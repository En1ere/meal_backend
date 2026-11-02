import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Readable } from 'node:stream';

export const MEDIA_OBJECT_STORE = Symbol('MEDIA_OBJECT_STORE');

export type MediaObjectLocation = 'quarantine' | 'ready';
export type MediaObjectPutRequest = Readonly<{
    location: MediaObjectLocation;
    objectKey: string;
    body: Readable;
    contentLength: number;
    contentType: 'application/octet-stream';
    metadata: Readonly<Record<string, string>>;
    signal: AbortSignal;
}>;
export type MediaObjectReadResult = Readonly<{ body: Readable; contentLength: number }>;

export interface MediaObjectStore {
    status(): Readonly<{ configured: boolean; provider: string | null; endpoint: string | null }>;
    put(request: MediaObjectPutRequest): Promise<void>;
    read(location: MediaObjectLocation, objectKey: string): Promise<MediaObjectReadResult>;
    delete(location: MediaObjectLocation, objectKey: string): Promise<void>;
}

export class MediaObjectStoreError extends Error {
    constructor(
        message: string,
        public readonly outcome: 'not_committed' | 'unknown',
    ) {
        super(message);
        this.name = 'MediaObjectStoreError';
    }
}

@Injectable()
export class DisabledMediaObjectStore implements MediaObjectStore {
    status() {
        return { configured: false, provider: null, endpoint: null } as const;
    }
    private unavailable<T>(): Promise<T> {
        return Promise.reject(new ServiceUnavailableException('S3-compatible media storage adapter is not installed'));
    }
    put(request: MediaObjectPutRequest): Promise<void> {
        void request;
        return this.unavailable();
    }
    read(location: MediaObjectLocation, objectKey: string): Promise<MediaObjectReadResult> {
        void location;
        void objectKey;
        return this.unavailable();
    }
    delete(location: MediaObjectLocation, objectKey: string): Promise<void> {
        void location;
        void objectKey;
        return this.unavailable();
    }
}
