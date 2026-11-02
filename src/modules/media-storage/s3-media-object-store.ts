import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadBucketCommand,
    PutObjectCommand,
    S3Client,
    type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { AppConfig } from '../../shared/config/app-config.js';
import {
    MediaObjectStoreError,
    type MediaObjectLocation,
    type MediaObjectPutRequest,
    type MediaObjectReadResult,
    type MediaObjectStore,
} from './media-object-store.js';

type S3Command = HeadBucketCommand | PutObjectCommand | GetObjectCommand | DeleteObjectCommand;
export interface MediaS3Client {
    send(command: S3Command, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

type MediaS3Config = AppConfig & {
    MEDIA_STORAGE_ENDPOINT: string;
    MEDIA_STORAGE_BACKEND_PORT: number;
    MEDIA_STORAGE_REGION: string;
    MEDIA_STORAGE_ACCESS_KEY_ID: string;
    MEDIA_STORAGE_SECRET_ACCESS_KEY: string;
    MEDIA_STORAGE_QUARANTINE_BUCKET: string;
    MEDIA_STORAGE_READY_BUCKET: string;
    MEDIA_STORAGE_PREFIX: string;
};

function configured(config: AppConfig): config is MediaS3Config {
    return (
        config.MEDIA_STORAGE_ENABLED &&
        typeof config.MEDIA_STORAGE_ENDPOINT === 'string' &&
        typeof config.MEDIA_STORAGE_BACKEND_PORT === 'number' &&
        typeof config.MEDIA_STORAGE_REGION === 'string' &&
        typeof config.MEDIA_STORAGE_ACCESS_KEY_ID === 'string' &&
        typeof config.MEDIA_STORAGE_SECRET_ACCESS_KEY === 'string' &&
        typeof config.MEDIA_STORAGE_QUARANTINE_BUCKET === 'string' &&
        typeof config.MEDIA_STORAGE_READY_BUCKET === 'string' &&
        typeof config.MEDIA_STORAGE_PREFIX === 'string'
    );
}

function endpoint(config: MediaS3Config): string {
    const value = new URL(config.MEDIA_STORAGE_ENDPOINT);
    value.port = String(config.MEDIA_STORAGE_BACKEND_PORT);
    return value.origin;
}

function httpStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object' || !('$metadata' in error)) return null;
    const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
    return typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : null;
}

function providerError(error: unknown, operation: string): MediaObjectStoreError {
    const status = httpStatus(error);
    const outcome = status !== null && status >= 400 && status < 500 ? 'not_committed' : 'unknown';
    return new MediaObjectStoreError(`S3 media ${operation} failed`, outcome);
}

function isReadable(value: unknown): value is Readable {
    return Boolean(value && typeof value === 'object' && 'pipe' in value && typeof value.pipe === 'function');
}

export class S3MediaObjectStore implements MediaObjectStore {
    private readonly client: MediaS3Client | null;
    private readonly storageEndpoint: string | null;

    constructor(
        private readonly config: AppConfig,
        client?: MediaS3Client,
    ) {
        if (!configured(config)) {
            this.client = null;
            this.storageEndpoint = null;
            return;
        }
        this.storageEndpoint = endpoint(config);
        this.client =
            client ??
            new S3Client({
                endpoint: this.storageEndpoint,
                region: config.MEDIA_STORAGE_REGION,
                forcePathStyle: config.MEDIA_STORAGE_FORCE_PATH_STYLE,
                credentials: {
                    accessKeyId: config.MEDIA_STORAGE_ACCESS_KEY_ID,
                    secretAccessKey: config.MEDIA_STORAGE_SECRET_ACCESS_KEY,
                },
                maxAttempts: 1,
            });
    }

    status() {
        return this.client
            ? ({ configured: true, provider: 's3-compatible', endpoint: this.storageEndpoint } as const)
            : ({ configured: false, provider: null, endpoint: null } as const);
    }

    private runtime(): { client: MediaS3Client; config: MediaS3Config } {
        if (!this.client || !configured(this.config))
            throw new ServiceUnavailableException('S3-compatible media storage is disabled');
        return { client: this.client, config: this.config };
    }

    private bucket(location: MediaObjectLocation, config: MediaS3Config): string {
        return location === 'quarantine' ? config.MEDIA_STORAGE_QUARANTINE_BUCKET : config.MEDIA_STORAGE_READY_BUCKET;
    }

    private key(objectKey: string, config: MediaS3Config): string {
        if (
            !objectKey.startsWith(`${config.MEDIA_STORAGE_PREFIX}/`) ||
            objectKey.startsWith('/') ||
            objectKey.endsWith('/') ||
            objectKey.includes('//') ||
            objectKey.split('/').some((part) => part === '.' || part === '..') ||
            !/^[A-Za-z0-9][A-Za-z0-9/_-]{1,510}[A-Za-z0-9]$/.test(objectKey)
        )
            throw new MediaObjectStoreError('Invalid media object key', 'not_committed');
        return objectKey;
    }

    async preflight(): Promise<void> {
        const { client, config } = this.runtime();
        try {
            await client.send(new HeadBucketCommand({ Bucket: config.MEDIA_STORAGE_QUARANTINE_BUCKET }));
            await client.send(new HeadBucketCommand({ Bucket: config.MEDIA_STORAGE_READY_BUCKET }));
        } catch {
            throw new ServiceUnavailableException('S3-compatible media storage preflight failed');
        }
    }

    async put(request: MediaObjectPutRequest): Promise<void> {
        const { client, config } = this.runtime();
        const key = this.key(request.objectKey, config);
        try {
            await client.send(
                new PutObjectCommand({
                    Bucket: this.bucket(request.location, config),
                    Key: key,
                    Body: request.body,
                    ContentLength: request.contentLength,
                    ContentType: request.contentType,
                    Metadata: request.metadata,
                }),
                { abortSignal: request.signal },
            );
        } catch (error) {
            throw providerError(error, 'put');
        }
    }

    async read(location: MediaObjectLocation, objectKey: string): Promise<MediaObjectReadResult> {
        const { client, config } = this.runtime();
        const key = this.key(objectKey, config);
        let output: GetObjectCommandOutput;
        try {
            output = (await client.send(
                new GetObjectCommand({ Bucket: this.bucket(location, config), Key: key }),
            )) as GetObjectCommandOutput;
        } catch (error) {
            throw providerError(error, 'read');
        }
        if (!isReadable(output.Body) || typeof output.ContentLength !== 'number' || output.ContentLength < 0)
            throw new MediaObjectStoreError('S3 media read returned an invalid stream', 'unknown');
        return { body: output.Body, contentLength: output.ContentLength };
    }

    async delete(location: MediaObjectLocation, objectKey: string): Promise<void> {
        const { client, config } = this.runtime();
        const key = this.key(objectKey, config);
        try {
            await client.send(new DeleteObjectCommand({ Bucket: this.bucket(location, config), Key: key }));
        } catch (error) {
            throw providerError(error, 'delete');
        }
    }
}
