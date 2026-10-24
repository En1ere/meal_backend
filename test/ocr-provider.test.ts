import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import {
    DisabledOcrProvider,
    OcrBoundaryError,
    ocrRequestSchema,
    ocrTransition,
    validateOcrRequestForProvider,
    validateOcrSnapshot,
    type OcrProviderStatus,
    type OcrRequest,
} from '../src/modules/ocr-infrastructure/ocr-provider.js';

const jobId = 'c9cc69e6-430f-4ef8-b6fe-335647a248d0';
const sourceId = '988f0dab-5708-426c-a404-6ab18a8e4b80';
const assetId = '19f15f6b-4e74-4d3e-9781-965d57aff62b';
const checksum = `sha256:${'a'.repeat(64)}`;
const request = (overrides: Partial<OcrRequest> = {}): OcrRequest => ({
    jobId,
    idempotencyKey: 'ocr-1',
    purpose: 'receipt_photo',
    source: {
        sourceId,
        assetId,
        objectKey: `private/${assetId}/source`,
        checksum,
        mime: 'image/jpeg',
        sizeBytes: 4_000_000,
        mediaState: 'ready',
        malwareVerdict: 'clean',
        encrypted: true,
    },
    languages: ['ru', 'en'],
    maxPages: 1,
    providerPolicyVersion: 'ocr-v1',
    retentionPolicyVersion: 'private-receipt-v1',
    externalTransferConsent: null,
    ...overrides,
});
const localStatus: OcrProviderStatus = {
    configured: true,
    provider: 'local_candidate',
    processingMode: 'local',
    dataRegion: null,
};

void test('OCR accepts only ready, clean, encrypted assets with bounded file policy', () => {
    assert.equal(ocrRequestSchema.safeParse(request()).success, true);
    assert.equal(
        ocrRequestSchema.safeParse(request({ source: { ...request().source, mediaState: 'scanning' } as never }))
            .success,
        false,
    );
    assert.equal(
        ocrRequestSchema.safeParse(request({ source: { ...request().source, encrypted: false } as never })).success,
        false,
    );
    assert.equal(ocrRequestSchema.safeParse(request({ languages: ['ru', 'ru'] })).success, false);
    assert.equal(ocrRequestSchema.safeParse(request({ maxPages: 2 })).success, false);
    assert.equal(
        ocrRequestSchema.safeParse(
            request({ purpose: 'receipt_pdf', source: { ...request().source, mime: 'application/pdf' }, maxPages: 20 }),
        ).success,
        true,
    );
});

void test('local OCR needs no external transfer consent', () => {
    assert.deepEqual(validateOcrRequestForProvider(request(), localStatus), request());
});

void test('external OCR requires explicit versioned transfer consent', () => {
    const externalStatus: OcrProviderStatus = {
        configured: true,
        provider: 'external_candidate',
        processingMode: 'external',
        dataRegion: 'ru-central1',
    };
    assert.throws(
        () => validateOcrRequestForProvider(request(), externalStatus),
        (error: unknown) => error instanceof OcrBoundaryError && error.code === 'external_consent_required',
    );
    const staleConsent = request({
        externalTransferConsent: { version: 'ocr-v0', consentedAt: '2026-10-09T09:00:00.000Z' },
    });
    assert.throws(
        () => validateOcrRequestForProvider(staleConsent, externalStatus),
        (error: unknown) => error instanceof OcrBoundaryError && error.code === 'external_consent_required',
    );
    const consented = request({
        externalTransferConsent: { version: 'ocr-v1', consentedAt: '2026-10-09T09:00:00.000Z' },
    });
    assert.deepEqual(validateOcrRequestForProvider(consented, externalStatus), consented);
});

void test('OCR result remains source-bound, bounded and always requires review', () => {
    const snapshot = {
        provider: 'local_candidate',
        processingMode: 'local',
        jobId,
        sourceId,
        assetId,
        checksum,
        state: 'succeeded',
        occurredAt: '2026-10-09T09:01:00.000Z',
        rawText: 'Молоко 100.00',
        fields: [
            {
                path: 'lines[0].name',
                rawValue: 'Молоко',
                confidence: 0.92,
                page: 1,
                region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
            },
        ],
        requiresReview: true,
        failureCode: null,
    } as const;
    assert.deepEqual(validateOcrSnapshot(request(), localStatus, snapshot), snapshot);
    assert.throws(
        () => validateOcrSnapshot(request(), localStatus, { ...snapshot, checksum: `sha256:${'b'.repeat(64)}` }),
        (error: unknown) => error instanceof OcrBoundaryError && error.code === 'binding_mismatch',
    );
    assert.throws(
        () => validateOcrSnapshot(request(), localStatus, { ...snapshot, requiresReview: false }),
        (error: unknown) => error instanceof OcrBoundaryError && error.code === 'invalid_request',
    );
    assert.throws(
        () => validateOcrSnapshot(request(), localStatus, { ...snapshot, rawProviderResponse: {} }),
        (error: unknown) => error instanceof OcrBoundaryError && error.code === 'invalid_request',
    );
    assert.throws(
        () => validateOcrSnapshot(request(), { ...localStatus, provider: 'other_provider' }, snapshot),
        (error: unknown) => error instanceof OcrBoundaryError && error.code === 'binding_mismatch',
    );
});

void test('incomplete OCR cannot expose fields and terminal states stay immutable', () => {
    const incomplete = {
        provider: 'local_candidate',
        processingMode: 'local',
        jobId,
        sourceId,
        assetId,
        checksum,
        state: 'failed',
        occurredAt: '2026-10-09T09:01:00.000Z',
        rawText: '',
        fields: [{ path: 'total', rawValue: '100', confidence: 0.5, page: 1, region: null }],
        requiresReview: true,
        failureCode: 'unreadable',
    };
    assert.throws(
        () => validateOcrSnapshot(request(), localStatus, incomplete),
        (error: unknown) => error instanceof OcrBoundaryError && error.code === 'invalid_request',
    );
    assert.equal(ocrTransition('queued', 'processing'), 'processing');
    assert.equal(ocrTransition('unknown', 'succeeded'), 'succeeded');
    assert.throws(
        () => ocrTransition('succeeded', 'failed'),
        (error: unknown) => error instanceof OcrBoundaryError && error.code === 'invalid_transition',
    );
});

void test('unselected durable OCR provider is explicit fail-closed infrastructure', async () => {
    const provider = new DisabledOcrProvider();
    assert.deepEqual(provider.status(), {
        configured: false,
        provider: null,
        processingMode: null,
        dataRegion: null,
    });
    assert.throws(
        () => validateOcrRequestForProvider(request(), provider.status()),
        (error: unknown) => error instanceof OcrBoundaryError && error.code === 'provider_unavailable',
    );
    await assert.rejects(provider.start(request()), ServiceUnavailableException);
    await assert.rejects(provider.lookup({ jobId, sourceId }), ServiceUnavailableException);
    await assert.rejects(provider.cancel({ jobId, sourceId }), ServiceUnavailableException);
});
