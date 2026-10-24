import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import { decimal, decimalText, requireVersion, transition } from '../src/modules/inventory/inventory.domain.js';
import {
    inventoryBatchSchema,
    inventoryCreateSchema,
    inventoryImportSchema,
    type InventoryBatch,
} from '../src/modules/inventory/inventory.contracts.js';
const id = '10000000-0000-4000-8000-000000000001';
const batch: InventoryBatch = {
    id,
    ingredientId: id,
    name: 'Молоко',
    quantity: '0.3',
    unit: 'l',
    locationId: null,
    purchasedOn: null,
    expiryOn: null,
    openedAt: null,
    packageState: 'unknown',
    precision: 'exact',
    quantitySource: 'user',
    confidence: null,
    pricePaidRub: null,
    storeName: null,
    barcode: null,
    scope: 'private',
    version: 1,
    archivedAt: null,
    createdAt: '2026-09-28T00:00:00Z',
};
const base = { version: 1, scope: 'private' as const, idempotencyKey: id };
void test('decimal quantities preserve precision at numeric(24,8) boundary', () => {
    assert.equal(decimalText(decimal('9999999999999999.99999999')), '9999999999999999.99999999');
    const next = transition(batch, { ...base, action: 'consume', quantity: '0.1' }, batch.createdAt);
    assert.equal(next.quantity, '0.2');
    assert.equal(batch.quantity, '0.3');
});
void test('consume cannot create negative, zero movement or pretend unknown is known', () => {
    for (const quantity of ['0', '0.30000001'])
        assert.throws(
            () => transition(batch, { ...base, action: 'consume', quantity }, batch.createdAt),
            HttpException,
        );
    assert.throws(
        () => transition({ ...batch, quantity: null }, { ...base, action: 'consume', quantity: '1' }, batch.createdAt),
        HttpException,
    );
});
void test('stale mutations fail 412 before changing data', () => {
    assert.throws(
        () => transition(batch, { ...base, version: 2, action: 'archive' }, batch.createdAt),
        (error: unknown) => error instanceof HttpException && error.getStatus() === 412,
    );
    assert.throws(
        () => requireVersion(undefined, 1),
        (error: unknown) => error instanceof HttpException && error.getStatus() === 428,
    );
    assert.throws(() => requireVersion('"2"', 1), HttpException);
    requireVersion('"1"', 1);
});
void test('archive only permits explicit restore; restore preserves quantity', () => {
    const archived = transition(batch, { ...base, action: 'archive' }, batch.createdAt);
    assert.throws(
        () => transition(archived, { ...base, version: 2, action: 'consume', quantity: '0.1' }, batch.createdAt),
        HttpException,
    );
    assert.equal(transition(archived, { ...base, version: 2, action: 'restore' }, batch.createdAt).quantity, '0.3');
});
void test('create accepts an explicit isolated scope and rejects malformed quantities and unknown fields', () => {
    const { id: _id, version: _version, archivedAt: _archivedAt, createdAt: _createdAt, ...fields } = batch;
    void _id;
    void _version;
    void _archivedAt;
    void _createdAt;
    const input = { ...fields, locationId: id, idempotencyKey: id };
    assert.equal(inventoryCreateSchema.safeParse(input).success, true);
    for (const patch of [
        { scope: 'another' },
        { quantity: '1e3' },
        { quantity: '-1' },
        { familyId: id },
        { quantity: '0.000000001' },
    ])
        assert.equal(inventoryCreateSchema.safeParse({ ...input, ...patch }).success, false);
    assert.equal(inventoryImportSchema.safeParse({ rows: [], idempotencyKey: id }).success, false);
});
void test('unknown values remain null and opened date independent from package state', () => {
    assert.equal(
        inventoryBatchSchema.parse({ ...batch, quantity: null, openedAt: '2026-09-28T07:00:00Z' }).quantity,
        null,
    );
});
