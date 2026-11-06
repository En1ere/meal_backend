import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { MediaStorageCapacityGuard } from '../src/modules/media-storage/public.js';

void test('capacity guard allows a write only when both byte and ratio reserves remain', async () => {
    const guard = new MediaStorageCapacityGuard(
        { snapshot: () => Promise.resolve({ freeBytes: 8_000, totalBytes: 10_000 }) },
        { minimumFreeBytes: 5_000, minimumFreeRatio: 0.2 },
    );
    assert.deepEqual(await guard.assertWritable(3_000), { freeBytes: 8_000, totalBytes: 10_000 });
    await assert.rejects(guard.assertWritable(3_001), ServiceUnavailableException);
});

void test('capacity guard fails closed when the probe fails or returns impossible values', async () => {
    const policy = { minimumFreeBytes: 1, minimumFreeRatio: 0.01 };
    await assert.rejects(
        new MediaStorageCapacityGuard(
            { snapshot: () => Promise.reject(new Error('probe down')) },
            policy,
        ).assertWritable(1),
        ServiceUnavailableException,
    );
    await assert.rejects(
        new MediaStorageCapacityGuard(
            { snapshot: () => Promise.resolve({ freeBytes: 101, totalBytes: 100 }) },
            policy,
        ).assertWritable(1),
        ServiceUnavailableException,
    );
});

void test('capacity guard rejects unsafe policy and request values before probing', async () => {
    const probe = { snapshot: () => Promise.resolve({ freeBytes: 10, totalBytes: 10 }) };
    assert.throws(
        () => new MediaStorageCapacityGuard(probe, { minimumFreeBytes: -1, minimumFreeRatio: 0.1 }),
        TypeError,
    );
    assert.throws(
        () => new MediaStorageCapacityGuard(probe, { minimumFreeBytes: 1, minimumFreeRatio: 1.1 }),
        TypeError,
    );
    const guard = new MediaStorageCapacityGuard(probe, { minimumFreeBytes: 1, minimumFreeRatio: 0.1 });
    await assert.rejects(guard.assertWritable(Number.MAX_SAFE_INTEGER + 1), TypeError);
});
