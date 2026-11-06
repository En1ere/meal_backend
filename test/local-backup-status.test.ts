import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    isSafeLocalBackupDirectory,
    localBackupStatusSchema,
    parseLocalBackupStatus,
} from '../src/modules/admin-runtime-settings/public.js';

const observedAt = '2026-11-02T20:00:00.000Z';
const status = {
    schemaVersion: 1,
    state: 'ok',
    observedAt,
    lastAttemptAt: observedAt,
    lastSuccessAt: observedAt,
    snapshotId: 'a'.repeat(64),
    snapshotAt: observedAt,
    repositoryBytes: 12_345,
    artifactCount: 6,
    recoveryKeyConfigured: true,
    schedule: { timezone: 'Asia/Yekaterinburg', localTime: '01:00' },
    retention: { daily: 7, weekly: 4 },
    policy: { rpoSeconds: 86_400, rtoSeconds: 14_400, offsite: false },
    restoreDrill: { outcome: 'passed', observedAt, measuredRestoreSeconds: 42 },
    failureCode: null,
} as const;

const raw = JSON.stringify(status);
const metadata = {
    regularFile: true,
    uid: 0,
    gid: 29_002,
    mode: 0o100640,
    size: Buffer.byteLength(raw),
    mtimeMs: Date.parse(observedAt),
};

void test('local backup status accepts only the fixed local encrypted policy', () => {
    assert.equal(localBackupStatusSchema.safeParse(status).success, true);
    assert.equal(
        localBackupStatusSchema.safeParse({ ...status, policy: { ...status.policy, offsite: true } }).success,
        false,
    );
    assert.equal(
        localBackupStatusSchema.safeParse({ ...status, schedule: { ...status.schedule, localTime: '02:00' } }).success,
        false,
    );
    assert.equal(localBackupStatusSchema.safeParse({ ...status, retention: { daily: 30, weekly: 4 } }).success, false);
});

void test('local backup status requires root-owned bounded evidence from the observability group', () => {
    assert.deepEqual(parseLocalBackupStatus(raw, metadata, Date.parse(observedAt) + 3_000), {
        availability: 'available',
        data: status,
        ageSeconds: 3,
    });
    assert.deepEqual(parseLocalBackupStatus(raw, { ...metadata, uid: 1000 }, Date.parse(observedAt)), {
        availability: 'unavailable',
        reason: 'invalid',
    });
    assert.deepEqual(parseLocalBackupStatus(raw, { ...metadata, mode: 0o100644 }, Date.parse(observedAt)), {
        availability: 'unavailable',
        reason: 'invalid',
    });
    assert.deepEqual(parseLocalBackupStatus(raw, metadata, Date.parse(observedAt) - 31_000), {
        availability: 'unavailable',
        reason: 'clock_skew',
    });
});

void test('local backup status directory rejects writable or unexpected ownership', () => {
    assert.equal(isSafeLocalBackupDirectory({ directory: true, uid: 0, gid: 29_002, mode: 0o42750 }), true);
    assert.equal(isSafeLocalBackupDirectory({ directory: true, uid: 0, gid: 29_002, mode: 0o40770 }), false);
    assert.equal(isSafeLocalBackupDirectory({ directory: true, uid: 0, gid: 0, mode: 0o42750 }), false);
});
