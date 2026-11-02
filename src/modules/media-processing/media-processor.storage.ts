import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import type { MediaProcessorConfig } from './media-processor.config.js';

type EnabledConfig = Extract<MediaProcessorConfig, { enabled: true }>;

function readable(value: unknown): value is Readable {
    return Boolean(value && typeof value === 'object' && 'pipe' in value && typeof value.pipe === 'function');
}

export class MediaProcessorStorage {
    private readonly client: S3Client;
    constructor(private readonly config: EnabledConfig) {
        this.client = new S3Client({
            endpoint: config.storageEndpoint,
            region: config.MEDIA_PROCESSOR_STORAGE_REGION,
            forcePathStyle: true,
            credentials: {
                accessKeyId: config.storageAccessKeyId,
                secretAccessKey: config.storageSecretAccessKey,
            },
            maxAttempts: 1,
        });
    }

    private key(value: string): string {
        if (
            !value.startsWith(`${this.config.storagePrefix}/`) ||
            value.startsWith('/') ||
            value.endsWith('/') ||
            value.includes('//') ||
            value.split('/').some((part) => part === '.' || part === '..') ||
            !/^[A-Za-z0-9][A-Za-z0-9/_-]{1,510}[A-Za-z0-9]$/.test(value)
        )
            throw new Error('media_processor_invalid_object_key');
        return value;
    }

    private async bounded<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.config.MEDIA_PROCESSOR_STORAGE_TIMEOUT_MS);
        try {
            return await run(abort.signal);
        } finally {
            clearTimeout(timer);
        }
    }

    async readQuarantine(objectKey: string): Promise<{ body: Readable; contentLength: number }> {
        const output = await this.bounded((signal) =>
            this.client.send(new GetObjectCommand({ Bucket: this.config.quarantineBucket, Key: this.key(objectKey) }), {
                abortSignal: signal,
            }),
        );
        if (!readable(output.Body) || typeof output.ContentLength !== 'number' || output.ContentLength < 1)
            throw new Error('media_processor_invalid_storage_read');
        return { body: output.Body, contentLength: output.ContentLength };
    }

    async putReady(
        request: Readonly<{
            objectKey: string;
            body: Readable;
            contentLength: number;
            metadata: Record<string, string>;
        }>,
    ): Promise<void> {
        await this.bounded(async (signal) => {
            await this.client.send(
                new PutObjectCommand({
                    Bucket: this.config.readyBucket,
                    Key: this.key(request.objectKey),
                    Body: request.body,
                    ContentLength: request.contentLength,
                    ContentType: 'application/octet-stream',
                    Metadata: request.metadata,
                }),
                { abortSignal: signal },
            );
        });
    }

    async headReady(objectKey: string): Promise<{ contentLength: number; metadata: Record<string, string> }> {
        const output = await this.bounded((signal) =>
            this.client.send(new HeadObjectCommand({ Bucket: this.config.readyBucket, Key: this.key(objectKey) }), {
                abortSignal: signal,
            }),
        );
        if (typeof output.ContentLength !== 'number' || output.ContentLength < 1 || !output.Metadata)
            throw new Error('media_processor_invalid_storage_head');
        return { contentLength: output.ContentLength, metadata: output.Metadata };
    }

    destroy(): void {
        this.client.destroy();
    }
}
