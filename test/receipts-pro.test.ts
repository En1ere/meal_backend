import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    purchaseLineInputSchema,
    receiptCapabilitiesSchema,
    receiptCreateSchema,
} from '../src/modules/receipts/receipts.contracts.js';

const id = '10000000-0000-4000-8000-000000000001';
const line = purchaseLineInputSchema.parse({
    id,
    name: 'Рис',
    quantity: '1',
    unit: 'kg',
    ingredientId: id,
    productId: null,
    locationId: null,
    isFood: true,
    intake: false,
    shoppingItemId: null,
    expiryOn: null,
    amountMinor: 12990,
    originalAmountMinor: 14990,
    discountMinor: 2000,
});

void test('Pro receipt contract accepts HTTPS electronic receipt and explicit financial consent', () => {
    const parsed = receiptCreateSchema.parse({
        idempotencyKey: id,
        source: { kind: 'electronic_link', storageStatus: 'not_required', reference: 'https://example.test/r/1' },
        ocrText: 'Рис',
        lines: [line],
        financial: {
            totalMinor: 12990,
            discountMinor: 2000,
            storeName: 'Магазин',
            paymentMethod: 'card',
            fiscalNumber: 'FN-1',
            fiscalDocumentNumber: 'FD-2',
            financeConsent: true,
        },
    });
    assert.equal(parsed.source.kind, 'electronic_link');
    assert.equal(parsed.financial?.currency, 'RUB');
    assert.equal(parsed.lines[0]?.amountMinor, 12990);
});

void test('receipt source rejects insecure links and PDF stays fail-closed', () => {
    assert.equal(
        receiptCreateSchema.safeParse({
            idempotencyKey: id,
            source: { kind: 'electronic_link', storageStatus: 'not_required', reference: 'http://example.test/r/1' },
            ocrText: 'Рис',
            lines: [line],
            financial: null,
        }).success,
        false,
    );
    assert.deepEqual(
        receiptCapabilitiesSchema.parse({
            photo: true,
            electronicLink: true,
            pdfUpload: false,
            ocrAdapter: false,
            pdfUnavailableReason: 'storage_not_configured',
        }),
        {
            photo: true,
            electronicLink: true,
            pdfUpload: false,
            ocrAdapter: false,
            pdfUnavailableReason: 'storage_not_configured',
        },
    );
});
