import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
    decryptMediaStream,
    encryptMediaStream,
    encryptedMediaHeaderBytes,
} from '../media-storage/media-encryption.js';
import { imageCdrPolicy } from './image-cdr.js';
import { ImageCdrChildError, runImageCdrChild, type ImageCdrChildResult } from './image-cdr-runner.js';
import type { MediaProcessorConfig } from './media-processor.config.js';
import type { ImageCdrJob } from './media-processor.repository.js';

type EnabledConfig = Extract<MediaProcessorConfig, { enabled: true }>;

async function collect(body: Readable, maximumBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of body) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        size += chunk.length;
        if (size > maximumBytes) {
            body.destroy(new Error('media_processor_plaintext_too_large'));
            throw new Error('media_processor_plaintext_too_large');
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
}

function failureCode(error: unknown): string {
    if (error instanceof ImageCdrChildError) return `cdr_${error.code}`;
    if (error instanceof Error && error.message.startsWith('IMAGE_CDR_REJECTED:')) return 'cdr_rejected';
    return 'processor_failed';
}

export class MediaProcessorAmbiguousSideEffect extends Error {
    constructor(public readonly phase: 'put' | 'readback' | 'database_commit') {
        super(`media_processor_ambiguous_${phase}`);
    }
}

export interface MediaProcessorRepositoryPort {
    recoverExpired(): Promise<number>;
    claim(): Promise<ImageCdrJob | null>;
    complete(
        job: ImageCdrJob,
        variant: Readonly<{
            id: string;
            objectKey: string;
            result: ImageCdrChildResult & { bytes: Buffer };
            keyReference: string;
            keyVersion: number;
            nonce: string;
            authenticationTag: string;
        }>,
    ): Promise<void>;
    failOrRetry(job: ImageCdrJob, code: string): Promise<void>;
    manualReview(job: ImageCdrJob, reason: string): Promise<void>;
}

export interface MediaProcessorStoragePort {
    readQuarantine(objectKey: string): Promise<{ body: Readable; contentLength: number }>;
    putReady(request: {
        objectKey: string;
        body: Readable;
        contentLength: number;
        metadata: Record<string, string>;
    }): Promise<void>;
    headReady(objectKey: string): Promise<{ contentLength: number; metadata: Record<string, string> }>;
}

type ChildRunner = typeof runImageCdrChild;

export class MediaProcessor {
    constructor(
        private readonly config: EnabledConfig,
        private readonly repository: MediaProcessorRepositoryPort,
        private readonly storage: MediaProcessorStoragePort,
        private readonly childScript: string,
        private readonly childRunner: ChildRunner = runImageCdrChild,
        private readonly workRoot = '/tmp/meal-media-processor',
    ) {}

    async runOnce(): Promise<boolean> {
        await this.repository.recoverExpired();
        const job = await this.repository.claim();
        if (!job) return false;
        try {
            await this.process(job);
        } catch (error) {
            if (error instanceof MediaProcessorAmbiguousSideEffect)
                await this.repository.manualReview(job, `ambiguous_${error.phase}`);
            else await this.repository.failOrRetry(job, failureCode(error));
        }
        return true;
    }

    private async process(job: ImageCdrJob): Promise<void> {
        if (job.keyVersion !== this.config.keyVersion) throw new Error('media_processor_key_version_unavailable');
        if (!(imageCdrPolicy.acceptedMimeTypes as readonly string[]).includes(job.mime))
            throw new Error('IMAGE_CDR_REJECTED:mime_not_allowed');
        if (job.sizeBytes < 1 || job.sizeBytes > imageCdrPolicy.maximumInputBytes)
            throw new Error('IMAGE_CDR_REJECTED:size_not_allowed');
        const stored = await this.storage.readQuarantine(job.objectKey);
        if (stored.contentLength !== job.sizeBytes + encryptedMediaHeaderBytes)
            throw new Error('media_processor_encrypted_size_mismatch');
        const decrypted = decryptMediaStream(
            stored.body,
            this.config.encryptionKey,
            Buffer.from(job.nonce, 'base64url'),
            Buffer.from(job.authenticationTag, 'base64url'),
            { assetId: job.assetId, purpose: job.purpose, keyVersion: job.keyVersion },
            job.sourceChecksum,
        );
        const plaintext = await collect(decrypted.body, imageCdrPolicy.maximumInputBytes);
        await decrypted.completion;

        const workId = randomUUID();
        const inputPath = join(this.workRoot, `${workId}.input`);
        const outputPath = join(this.workRoot, `${workId}.output`);
        try {
            await writeFile(inputPath, plaintext, { mode: 0o600, flag: 'wx' });
            const childResult = await this.childRunner({
                scriptPath: this.childScript,
                inputPath,
                outputPath,
                declaredMime: job.mime,
                timeoutMs: this.config.MEDIA_PROCESSOR_CDR_TIMEOUT_MS,
                killGraceMs: this.config.MEDIA_PROCESSOR_KILL_GRACE_MS,
            });
            const outputStat = await stat(outputPath);
            if (outputStat.size < 1 || outputStat.size > imageCdrPolicy.maximumInputBytes)
                throw new Error('media_processor_cdr_output_too_large');
            const bytes = await readFile(outputPath);
            if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== childResult.checksum)
                throw new Error('media_processor_child_checksum_mismatch');
            const variantId = randomUUID();
            const objectKey = `${this.config.storagePrefix}/ready/${job.assetId}/cdr/${variantId}`;
            const nonce = randomBytes(12);
            const encrypted = encryptMediaStream(Readable.from(bytes), this.config.encryptionKey, nonce, bytes.length, {
                assetId: job.assetId,
                purpose: job.purpose,
                keyVersion: this.config.keyVersion,
            });
            const encryptedLength = bytes.length + encryptedMediaHeaderBytes;
            const metadata = {
                assetid: job.assetId,
                processingjobid: job.id,
                policyversion: childResult.policyVersion,
                keyversion: String(this.config.keyVersion),
            };
            const put = this.storage.putReady({
                objectKey,
                body: encrypted.body,
                contentLength: encryptedLength,
                metadata,
            });
            let encryption;
            try {
                [, encryption] = await Promise.all([put, encrypted.completion]);
            } catch (error) {
                encrypted.cancel(error instanceof Error ? error : new Error('media_processor_put_failed'));
                await Promise.allSettled([put, encrypted.completion]);
                throw new MediaProcessorAmbiguousSideEffect('put');
            }
            let readback;
            try {
                readback = await this.storage.headReady(objectKey);
            } catch {
                throw new MediaProcessorAmbiguousSideEffect('readback');
            }
            if (
                readback.contentLength !== encryptedLength ||
                Object.entries(metadata).some(([key, value]) => readback.metadata[key] !== value)
            )
                throw new MediaProcessorAmbiguousSideEffect('readback');
            try {
                await this.repository.complete(job, {
                    id: variantId,
                    objectKey,
                    result: { ...childResult, bytes },
                    keyReference: `app-media-v${this.config.keyVersion}`,
                    keyVersion: this.config.keyVersion,
                    nonce: encryption.nonce,
                    authenticationTag: encryption.authenticationTag,
                });
            } catch {
                throw new MediaProcessorAmbiguousSideEffect('database_commit');
            }
        } finally {
            await Promise.allSettled([rm(inputPath, { force: true }), rm(outputPath, { force: true })]);
        }
    }
}
