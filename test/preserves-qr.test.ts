import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    preserveQrIssueSchema,
    preserveQrPayloadSchema,
    preserveQrResultSchema,
} from '../src/modules/preserves/preserves.contracts.js';

const id = '10000000-0000-4000-8000-000000000005';

void test('QR payload is an offline-safe minimal preserve snapshot', () => {
    const payload = preserveQrPayloadSchema.parse({
        schemaVersion: 1,
        id,
        name: 'Клубничное варенье',
        type: 'jam',
        createdOn: '2026-07-15',
        expiryOn: '2027-07-15',
        appUrl: `mealplanner://preserve/${id}`,
    });
    assert.deepEqual(Object.keys(payload).sort(), [
        'appUrl',
        'createdOn',
        'expiryOn',
        'id',
        'name',
        'schemaVersion',
        'type',
    ]);
    assert.throws(() => preserveQrPayloadSchema.parse({ ...payload, scopeId: id }));
});

void test('QR issue requires an optimistic preserve version and idempotency key', () => {
    assert.equal(preserveQrIssueSchema.parse({ preserveVersion: 3, idempotencyKey: id }).preserveVersion, 3);
    assert.throws(() => preserveQrIssueSchema.parse({ preserveVersion: 0, idempotencyKey: id }));
});

void test('QR read exposes tariff capability without inventing a label', () => {
    assert.deepEqual(
        preserveQrResultSchema.parse({
            label: null,
            capability: { available: false, reason: 'requires-plus' },
        }),
        { label: null, capability: { available: false, reason: 'requires-plus' } },
    );
});
