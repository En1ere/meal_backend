import assert from 'node:assert/strict';
import test from 'node:test';
import {
    financeCostEstimateSchema,
    financePriceObservationCreateSchema,
    financeResolvedPriceSchema,
} from '../src/modules/finance/finance.contracts.js';

const id = '20000000-0000-4000-8000-000000000001';

void test('manual price requires consent and exact positive RUB minor units', () => {
    const input = {
        ingredientId: id,
        unit: 'g',
        quantity: '500',
        amountMinor: 12999,
        observedAt: '2026-10-08T10:00:00.000Z',
        financeConsent: true,
        idempotencyKey: id,
    } as const;
    assert.equal(financePriceObservationCreateSchema.safeParse(input).success, true);
    assert.equal(financePriceObservationCreateSchema.safeParse({ ...input, financeConsent: false }).success, false);
    assert.equal(financePriceObservationCreateSchema.safeParse({ ...input, amountMinor: 0 }).success, false);
    assert.equal(financePriceObservationCreateSchema.safeParse({ ...input, quantity: '0' }).success, false);
    assert.equal(financePriceObservationCreateSchema.safeParse({ ...input, scope: 'family' }).success, false);
});

void test('resolved price always exposes provenance without private receipt data', () => {
    const value = {
        ingredientId: id,
        ingredientName: 'Томаты',
        unit: 'g',
        amountMinor: 26,
        perQuantity: '1',
        currency: 'RUB',
        source: 'personal_latest',
        observedAt: '2026-10-08T10:00:00.000Z',
        sampleCount: 1,
        methodVersion: 'personal-latest-v1',
    } as const;
    assert.equal(financeResolvedPriceSchema.safeParse(value).success, true);
    assert.equal(financeResolvedPriceSchema.safeParse({ ...value, receiptId: id }).success, false);
});

void test('incomplete cost exposes known subtotal but never a misleading total', () => {
    const estimate = {
        access: { mode: 'active', reason: null, source: 'personal', periodEndsAt: null },
        subject: { type: 'recipe', id, title: 'Салат' },
        currency: 'RUB',
        approximate: true,
        disclaimer: 'Примерная стоимость.',
        complete: false,
        knownLineCount: 1,
        totalLineCount: 2,
        knownSubtotalMinor: 15000,
        estimatedTotalMinor: null,
        lines: [],
    } as const;
    assert.equal(financeCostEstimateSchema.safeParse(estimate).success, true);
    assert.equal(financeCostEstimateSchema.safeParse({ ...estimate, estimatedTotalMinor: 15000 }).success, false);
});
