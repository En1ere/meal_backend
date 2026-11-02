import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    reconcileMediaUpload,
    type MediaDatabaseEvidence,
    type MediaReservationEvidence,
} from '../src/modules/media-storage/media-storage-reconciler.js';

const reservation: MediaReservationEvidence = {
    assetId: '00000000-0000-4000-8000-000000000111',
    purpose: 'diary_photo',
    expectedEncryptedBytes: 1_040,
    state: 'uploading',
    failureCode: 'reconciliation_required',
};

const durable: MediaDatabaseEvidence = {
    asset: { status: 'quarantined', sizeBytes: 1_000, checksum: `sha256:${'a'.repeat(64)}` },
    binding: {
        purpose: 'diary_photo',
        keyVersion: 1,
        nonce: 'nonce',
        authenticationTag: 'tag',
    },
};

const object = {
    outcome: 'present' as const,
    contentLength: 1_040,
    metadata: {
        assetId: reservation.assetId,
        purpose: reservation.purpose,
        keyVersion: '1',
    },
};

void test('reconciler confirms quarantine only from matching database and provider evidence', () => {
    assert.deepEqual(reconcileMediaUpload(reservation, durable, object), {
        action: 'confirm_quarantined',
        reason: 'durable_match',
    });
    assert.deepEqual(reconcileMediaUpload(reservation, durable, { ...object, contentLength: 1_039 }), {
        action: 'manual_review',
        reason: 'evidence_mismatch',
    });
});

void test('reconciler confirms failure only when database and provider both prove absence', () => {
    const empty: MediaDatabaseEvidence = { asset: null, binding: null };
    assert.deepEqual(reconcileMediaUpload(reservation, empty, { outcome: 'missing' }), {
        action: 'confirm_failed',
        reason: 'confirmed_absent',
    });
    assert.deepEqual(reconcileMediaUpload(reservation, empty, object), {
        action: 'manual_review',
        reason: 'orphan_object',
    });
});

void test('reconciler defers unknown provider outcomes and never guesses from partial database state', () => {
    assert.deepEqual(reconcileMediaUpload(reservation, durable, { outcome: 'unknown' }), {
        action: 'defer',
        reason: 'provider_unknown',
    });
    assert.deepEqual(
        reconcileMediaUpload(reservation, { asset: durable.asset, binding: null }, { outcome: 'missing' }),
        { action: 'manual_review', reason: 'database_partial' },
    );
});
