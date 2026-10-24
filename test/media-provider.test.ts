import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import {
    DisabledKeyManagementProvider,
    DisabledMalwareScannerProvider,
    DisabledObjectStorageProvider,
    MediaBoundaryError,
    assertMediaReady,
    mediaObjectBindingSchema,
    mediaTransition,
    validateDownloadTarget,
    validateMalwareScan,
    validateUploadTarget,
    type MalwareScanRequest,
    type UploadReservationRequest,
} from '../src/modules/media-infrastructure/media-provider.js';

const assetId = 'c9cc69e6-430f-4ef8-b6fe-335647a248d0';
const objectKey = `private/${assetId}/source`;
const checksum = `sha256:${'a'.repeat(64)}`;
const binding = {
    assetId,
    objectKey,
    purpose: 'diary_photo',
    mime: 'image/jpeg',
    sizeBytes: 4_000_000,
    checksum,
    retentionClass: 'private-diary-v1',
} as const;
const uploadRequest: UploadReservationRequest = {
    ...binding,
    idempotencyKey: 'upload-1',
    encryption: {
        provider: 'kms_candidate',
        keyReference: 'alias/private-media',
        mode: 'provider_managed_kms',
    },
};
const scanRequest: MalwareScanRequest = { ...binding, policyVersion: 'malware-v1' };
const now = new Date('2026-10-09T09:00:00.000Z');

void test('media metadata accepts bounded opaque objects and rejects traversal or oversized sources', () => {
    assert.equal(mediaObjectBindingSchema.safeParse(binding).success, true);
    assert.equal(mediaObjectBindingSchema.safeParse({ ...binding, objectKey: '../secret' }).success, false);
    assert.equal(
        mediaObjectBindingSchema.safeParse({ ...binding, objectKey: 'https://bucket.example/file' }).success,
        false,
    );
    assert.equal(mediaObjectBindingSchema.safeParse({ ...binding, sizeBytes: 50 * 1024 * 1024 + 1 }).success, false);
    assert.equal(mediaObjectBindingSchema.safeParse({ ...binding, checksum: 'not-a-checksum' }).success, false);
});

void test('upload reservation stays bound to the asset and permits only short-lived HTTPS targets', () => {
    const target = {
        provider: 'storage_candidate',
        assetId,
        objectKey,
        uploadUrl: 'https://storage.example/upload',
        expiresAt: '2026-10-09T09:10:00.000Z',
        requiredHeaders: [{ name: 'content-type', value: 'image/jpeg' }],
    };
    assert.deepEqual(validateUploadTarget(uploadRequest, target, now), target);
    assert.throws(
        () => validateUploadTarget(uploadRequest, { ...target, objectKey: `${objectKey}-other` }, now),
        (error: unknown) => error instanceof MediaBoundaryError && error.code === 'binding_mismatch',
    );
    assert.throws(
        () => validateUploadTarget(uploadRequest, { ...target, uploadUrl: 'http://storage.example/upload' }, now),
        (error: unknown) => error instanceof MediaBoundaryError && error.code === 'invalid_request',
    );
    assert.throws(
        () => validateUploadTarget(uploadRequest, { ...target, expiresAt: '2026-10-09T09:16:00.000Z' }, now),
        (error: unknown) => error instanceof MediaBoundaryError && error.code === 'unsafe_url_ttl',
    );
});

void test('download target is asset-bound, HTTPS-only and expires within five minutes', () => {
    const request = { assetId, objectKey, disposition: 'inline' } as const;
    const target = {
        provider: 'storage_candidate',
        assetId,
        objectKey,
        downloadUrl: 'https://storage.example/download',
        expiresAt: '2026-10-09T09:05:00.000Z',
    };
    assert.deepEqual(validateDownloadTarget(request, target, now), target);
    assert.throws(
        () => validateDownloadTarget(request, { ...target, expiresAt: '2026-10-09T09:05:00.001Z' }, now),
        (error: unknown) => error instanceof MediaBoundaryError && error.code === 'unsafe_url_ttl',
    );
});

void test('media lifecycle never publishes from quarantine and keeps terminal outcomes immutable', () => {
    assert.equal(mediaTransition('reserved', 'uploading'), 'uploading');
    assert.equal(mediaTransition('uploading', 'quarantined'), 'quarantined');
    assert.equal(mediaTransition('quarantined', 'scanning'), 'scanning');
    assert.equal(mediaTransition('scanning', 'clean'), 'clean');
    assert.equal(mediaTransition('clean', 'ready'), 'ready');
    for (const [current, next] of [
        ['quarantined', 'ready'],
        ['infected', 'ready'],
        ['deleted', 'reserved'],
    ] as const) {
        assert.throws(
            () => mediaTransition(current, next),
            (error: unknown) => error instanceof MediaBoundaryError && error.code === 'invalid_transition',
        );
    }
});

void test('scanner result is immutable-input-bound and only clean encrypted media becomes ready', () => {
    const scan = {
        provider: 'scanner_candidate',
        assetId,
        objectKey,
        checksum,
        policyVersion: 'malware-v1',
        verdict: 'clean',
        scannedAt: '2026-10-09T09:01:00.000Z',
        engineVersion: 'engine-1',
        reasonCode: null,
    } as const;
    assert.deepEqual(validateMalwareScan(scanRequest, scan), scan);
    assert.doesNotThrow(() => assertMediaReady(binding, uploadRequest.encryption, scan));
    assert.throws(
        () => validateMalwareScan(scanRequest, { ...scan, checksum: `sha256:${'b'.repeat(64)}` }),
        (error: unknown) => error instanceof MediaBoundaryError && error.code === 'binding_mismatch',
    );
    for (const value of [null, uploadRequest.encryption] as const) {
        assert.throws(
            () => assertMediaReady(binding, value, { ...scan, verdict: 'unknown' }),
            (error: unknown) => error instanceof MediaBoundaryError && error.code === 'media_not_ready',
        );
    }
    assert.throws(
        () => assertMediaReady(binding, null, scan),
        (error: unknown) => error instanceof MediaBoundaryError && error.code === 'media_not_ready',
    );
    assert.throws(
        () => assertMediaReady(binding, uploadRequest.encryption, { ...scan, rawPayload: 'not allowed' } as never),
        (error: unknown) => error instanceof MediaBoundaryError && error.code === 'invalid_request',
    );
});

void test('unselected storage, KMS and scanner are explicit fail-closed providers', async () => {
    const storage = new DisabledObjectStorageProvider();
    const kms = new DisabledKeyManagementProvider();
    const scanner = new DisabledMalwareScannerProvider();
    assert.deepEqual(storage.status(), { configured: false, provider: null });
    assert.deepEqual(kms.status(), { configured: false, provider: null });
    assert.deepEqual(scanner.status(), { configured: false, provider: null });
    await assert.rejects(storage.reserveUpload(uploadRequest), ServiceUnavailableException);
    await assert.rejects(
        kms.resolveKey({ assetId, purpose: 'diary_photo', encryptionContext: { objectKey, uploaderId: assetId } }),
        ServiceUnavailableException,
    );
    await assert.rejects(scanner.scan(scanRequest), ServiceUnavailableException);
});
