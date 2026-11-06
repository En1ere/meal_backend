import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ServiceUnavailableException } from '@nestjs/common';
import { readConfig } from '../src/app/config.js';
import { MediaObjectStoreError, S3MediaObjectStore, type MediaS3Client } from '../src/modules/media-storage/public.js';

type Command = Parameters<MediaS3Client['send']>[0];
type SendOptions = Parameters<MediaS3Client['send']>[1];

class FakeS3Client implements MediaS3Client {
    readonly calls: Array<{ command: Command; options?: SendOptions }> = [];
    readonly outputs: unknown[] = [];
    error: Error | null = null;

    send(command: Command, options?: SendOptions): Promise<unknown> {
        this.calls.push(options ? { command, options } : { command });
        if (this.error) return Promise.reject(this.error);
        return Promise.resolve(this.outputs.shift() ?? {});
    }
}

function config(enabled = true) {
    if (!enabled) return readConfig({ NODE_ENV: 'test' });
    return readConfig({
        NODE_ENV: 'test',
        MEDIA_STORAGE_ENABLED: 'true',
        MEDIA_STORAGE_ENDPOINT: 'http://seaweedfs',
        MEDIA_STORAGE_BACKEND_PORT: '8333',
        MEDIA_STORAGE_REGION: 'us-east-1',
        MEDIA_STORAGE_ACCESS_KEY_ID: 'meal-backend',
        MEDIA_STORAGE_SECRET_ACCESS_KEY: 'storage-secret-access-key-value-1234',
        MEDIA_STORAGE_QUARANTINE_BUCKET: 'meal-media-quarantine',
        MEDIA_STORAGE_READY_BUCKET: 'meal-media-ready',
        MEDIA_STORAGE_PREFIX: 'meal',
        MEDIA_STORAGE_FORCE_PATH_STYLE: 'true',
        MEDIA_STORAGE_PUBLIC_ORIGIN: 'https://meal.example.test',
        MEDIA_STORAGE_SIGNING_KEY: randomBytes(32).toString('base64'),
        MEDIA_STORAGE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        MEDIA_STORAGE_KEY_VERSION: '1',
    });
}

void test('S3 media store stays disabled without the complete feature-gated configuration', async () => {
    const store = new S3MediaObjectStore(config(false));
    assert.deepEqual(store.status(), { configured: false, provider: null, endpoint: null });
    await assert.rejects(store.preflight(), ServiceUnavailableException);
});

void test('S3 media preflight checks both private buckets without exposing credentials', async () => {
    const client = new FakeS3Client();
    const store = new S3MediaObjectStore(config(), client);
    assert.deepEqual(store.status(), {
        configured: true,
        provider: 's3-compatible',
        endpoint: 'http://seaweedfs:8333',
    });
    assert.equal(JSON.stringify(store.status()).includes('storage-secret'), false);
    await store.preflight();
    assert.equal(client.calls.length, 2);
    assert.ok(client.calls[0]?.command instanceof HeadBucketCommand);
    assert.deepEqual(
        client.calls.map(({ command }) => (command as HeadBucketCommand).input.Bucket),
        ['meal-media-quarantine', 'meal-media-ready'],
    );

    client.error = Object.assign(new Error('provider payload with credentials'), {
        $metadata: { httpStatusCode: 403 },
    });
    await assert.rejects(
        store.preflight(),
        (error: unknown) =>
            error instanceof ServiceUnavailableException &&
            error.message === 'S3-compatible media storage preflight failed',
    );
});

void test('S3 media put binds ciphertext to the quarantine bucket and forwards cancellation', async () => {
    const client = new FakeS3Client();
    const store = new S3MediaObjectStore(config(), client);
    const abort = new AbortController();
    const body = Readable.from([Buffer.from('ciphertext')]);
    await store.put({
        location: 'quarantine',
        objectKey: 'meal/quarantine/profile_avatar/00000000-0000-4000-8000-000000000001',
        body,
        contentLength: 10,
        contentType: 'application/octet-stream',
        metadata: { assetId: '00000000-0000-4000-8000-000000000001', keyVersion: '1' },
        signal: abort.signal,
    });
    assert.equal(client.calls.length, 1);
    const call = client.calls[0]!;
    assert.ok(call.command instanceof PutObjectCommand);
    assert.equal(call.command.input.Bucket, 'meal-media-quarantine');
    assert.equal(call.command.input.ContentLength, 10);
    assert.equal(call.command.input.ContentType, 'application/octet-stream');
    assert.equal(call.command.input.Body, body);
    assert.equal(call.options?.abortSignal, abort.signal);
});

void test('S3 media read accepts only a bounded Node stream result from the ready bucket', async () => {
    const client = new FakeS3Client();
    const body = Readable.from([Buffer.from('ciphertext')]);
    client.outputs.push({ Body: body, ContentLength: 10 });
    const store = new S3MediaObjectStore(config(), client);
    const result = await store.read('ready', 'meal/quarantine/profile_avatar/00000000-0000-4000-8000-000000000001');
    assert.equal(result.body, body);
    assert.equal(result.contentLength, 10);
    assert.ok(client.calls[0]?.command instanceof GetObjectCommand);
    assert.equal(client.calls[0].command.input.Bucket, 'meal-media-ready');

    client.outputs.push({ Body: 'not-a-node-stream', ContentLength: 10 });
    await assert.rejects(
        store.read('ready', 'meal/quarantine/profile_avatar/00000000-0000-4000-8000-000000000001'),
        (error: unknown) => error instanceof MediaObjectStoreError && error.outcome === 'unknown',
    );
});

void test('S3 media errors distinguish definitive rejection from unknown provider outcome', async () => {
    const client = new FakeS3Client();
    const store = new S3MediaObjectStore(config(), client);
    const request = {
        location: 'quarantine' as const,
        objectKey: 'meal/quarantine/profile_avatar/00000000-0000-4000-8000-000000000001',
        body: Readable.from([Buffer.from('ciphertext')]),
        contentLength: 10,
        contentType: 'application/octet-stream' as const,
        metadata: {},
        signal: new AbortController().signal,
    };
    client.error = Object.assign(new Error('access denied'), { $metadata: { httpStatusCode: 403 } });
    await assert.rejects(
        store.put(request),
        (error: unknown) => error instanceof MediaObjectStoreError && error.outcome === 'not_committed',
    );
    client.error = Object.assign(new Error('gateway timeout'), { $metadata: { httpStatusCode: 504 } });
    await assert.rejects(
        store.put({ ...request, body: Readable.from([Buffer.from('ciphertext')]) }),
        (error: unknown) => error instanceof MediaObjectStoreError && error.outcome === 'unknown',
    );
});

void test('S3 media store rejects non-prefixed and traversal-like keys before provider access', async () => {
    const client = new FakeS3Client();
    const store = new S3MediaObjectStore(config(), client);
    for (const objectKey of ['other/quarantine/file', 'meal/../secret', 'meal//secret']) {
        await assert.rejects(
            store.read('quarantine', objectKey),
            (error: unknown) => error instanceof MediaObjectStoreError && error.outcome === 'not_committed',
        );
    }
    assert.equal(client.calls.length, 0);
});
