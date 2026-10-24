import assert from 'node:assert/strict';
import test from 'node:test';
import {
    financeBudgetCreateSchema,
    financeExpenseCreateSchema,
    financeExpenseSchema,
    financeAnalyticsSchema,
} from '../src/modules/finance/finance.contracts.js';

const id = '10000000-0000-4000-8000-000000000001';

void test('manual finance input requires explicit consent and cannot inject family or receipt data', () => {
    const input = {
        category: 'groceries',
        amountMinor: 12550,
        occurredAt: '2026-10-08T08:30:00.000Z',
        financeConsent: true,
        idempotencyKey: id,
    } as const;
    assert.equal(financeExpenseCreateSchema.safeParse(input).success, true);
    assert.equal(financeExpenseCreateSchema.safeParse({ ...input, financeConsent: false }).success, false);
    assert.equal(financeExpenseCreateSchema.safeParse({ ...input, scope: 'family' }).success, false);
    assert.equal(financeExpenseCreateSchema.safeParse({ ...input, receiptId: id }).success, false);
});

void test('exact expense money is positive RUB minor units', () => {
    const expense = {
        id,
        source: 'manual',
        category: 'restaurant',
        amountMinor: 1,
        currency: 'RUB',
        occurredAt: '2026-10-08T08:30:00.000Z',
        consentedAt: '2026-10-08T08:31:00.000Z',
        version: 1,
        createdAt: '2026-10-08T08:31:00.000Z',
    } as const;
    assert.equal(financeExpenseSchema.safeParse(expense).success, true);
    assert.equal(financeExpenseSchema.safeParse({ ...expense, amountMinor: 0 }).success, false);
    assert.equal(financeExpenseSchema.safeParse({ ...expense, currency: 'USD' }).success, false);
});

void test('stage five budget contract is overall-only and validates its date fields', () => {
    const budget = {
        amountMinor: 500000,
        startsOn: '2026-10-01',
        endsOn: '2026-10-31',
        category: null,
        idempotencyKey: id,
    };
    assert.equal(financeBudgetCreateSchema.safeParse(budget).success, true);
    assert.equal(financeBudgetCreateSchema.safeParse({ ...budget, category: 'groceries' }).success, false);
    assert.equal(financeBudgetCreateSchema.safeParse({ ...budget, startsOn: '08.10.2026' }).success, false);
});

void test('analytics keeps unknown savings and short-history forecast honest', () => {
    const value = financeAnalyticsSchema.parse({
        access: { mode: 'active', reason: null, source: 'personal', periodEndsAt: null },
        scope: 'private',
        period: { from: '2026-10-01', to: '2026-10-08', dataThrough: '2026-10-08', days: 8 },
        category: null,
        currency: 'RUB',
        totals: {
            expenseMinor: 1000,
            expenseCount: 1,
            receiptCount: 0,
            averageReceiptMinor: null,
            purchaseFrequencyPer30Days: null,
            confirmedSavingsMinor: null,
        },
        completeness: { receiptLineCount: 0, originalPriceKnownLineCount: 0, savingsCoveragePercent: null },
        categories: [{ category: 'groceries', amountMinor: 1000, count: 1 }],
        stores: [],
        forecast: { available: false, projected30DayMinor: null, basisDays: 8, reason: 'insufficient_history' },
    });
    assert.equal(value.totals.confirmedSavingsMinor, null);
    assert.equal(value.forecast.projected30DayMinor, null);
});
