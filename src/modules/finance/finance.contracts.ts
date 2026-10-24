import { z } from 'zod';
import { proAccessSchema } from '../pro-overview/pro-overview.contracts.js';

export const financeCategorySchema = z.enum([
    'groceries',
    'delivery',
    'restaurant',
    'prepared_food',
    'beverages',
    'other',
]);
const amountMinorSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const financeExpenseSchema = z.strictObject({
    id: z.uuid(),
    source: z.enum(['manual', 'receipt']),
    category: financeCategorySchema,
    amountMinor: amountMinorSchema,
    currency: z.literal('RUB'),
    occurredAt: z.iso.datetime(),
    consentedAt: z.iso.datetime(),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
});
export const financeExpenseCreateSchema = z.strictObject({
    category: financeCategorySchema,
    amountMinor: amountMinorSchema,
    occurredAt: z.iso.datetime(),
    financeConsent: z.literal(true),
    idempotencyKey: z.uuid(),
});
export const financeExpenseUpdateSchema = z.strictObject({
    category: financeCategorySchema,
    amountMinor: amountMinorSchema,
    occurredAt: z.iso.datetime(),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const financeExpenseResultSchema = z.strictObject({ access: proAccessSchema, expense: financeExpenseSchema });
export const financeExpenseListSchema = z.strictObject({
    access: proAccessSchema,
    scope: z.literal('private'),
    period: z.strictObject({ from: z.iso.date(), to: z.iso.date(), dataThrough: z.iso.date() }),
    category: financeCategorySchema.nullable(),
    items: z.array(financeExpenseSchema),
    totalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal('RUB'),
});

export const financeBudgetSchema = z.strictObject({
    id: z.uuid(),
    amountMinor: amountMinorSchema,
    currency: z.literal('RUB'),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    category: z.null(),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
});
export const financeBudgetCreateSchema = z.strictObject({
    amountMinor: amountMinorSchema,
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    category: z.null(),
    idempotencyKey: z.uuid(),
});
export const financeBudgetUpdateSchema = z.strictObject({
    amountMinor: amountMinorSchema,
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    category: z.null(),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const financeBudgetResultSchema = z.strictObject({ budget: financeBudgetSchema });
export const financeBudgetListSchema = z.strictObject({
    access: proAccessSchema,
    scope: z.literal('private'),
    supportsCategoryBudgets: z.literal(false),
    items: z.array(financeBudgetSchema),
});
export const financeOverviewSchema = z.strictObject({
    access: proAccessSchema,
    scope: z.literal('private'),
    period: z.strictObject({ from: z.iso.date(), to: z.iso.date(), dataThrough: z.iso.date() }),
    expenseCount: z.number().int().nonnegative(),
    totalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal('RUB'),
    budget: financeBudgetSchema.nullable(),
    budgetSpentMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    budgetRemainingMinor: z.number().int().nullable(),
    forecastAvailable: z.literal(false),
});
export const financeAnalyticsSchema = z.strictObject({
    access: proAccessSchema,
    scope: z.literal('private'),
    period: z.strictObject({
        from: z.iso.date(),
        to: z.iso.date(),
        dataThrough: z.iso.date(),
        days: z.number().int().positive(),
    }),
    category: financeCategorySchema.nullable(),
    currency: z.literal('RUB'),
    totals: z.strictObject({
        expenseMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        expenseCount: z.number().int().nonnegative(),
        receiptCount: z.number().int().nonnegative(),
        averageReceiptMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
        purchaseFrequencyPer30Days: z.number().nonnegative().nullable(),
        confirmedSavingsMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    }),
    completeness: z.strictObject({
        receiptLineCount: z.number().int().nonnegative(),
        originalPriceKnownLineCount: z.number().int().nonnegative(),
        savingsCoveragePercent: z.number().min(0).max(100).nullable(),
    }),
    categories: z.array(
        z.strictObject({
            category: financeCategorySchema,
            amountMinor: z.number().int().nonnegative(),
            count: z.number().int().positive(),
        }),
    ),
    stores: z.array(
        z.strictObject({
            storeName: z.string().nullable(),
            amountMinor: z.number().int().nonnegative(),
            receiptCount: z.number().int().positive(),
        }),
    ),
    forecast: z.strictObject({
        available: z.boolean(),
        projected30DayMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
        basisDays: z.number().int().positive(),
        reason: z.enum(['available', 'insufficient_history']),
    }),
});

const quantitySchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/);
export const financePriceSourceSchema = z.enum(['personal_latest', 'personal_median', 'system_median']);
export const financePriceObservationSchema = z.strictObject({
    id: z.uuid(),
    ingredientId: z.uuid(),
    ingredientName: z.string(),
    unit: z.string(),
    quantity: quantitySchema,
    amountMinor: amountMinorSchema,
    currency: z.literal('RUB'),
    observedAt: z.iso.datetime(),
    source: z.enum(['manual', 'receipt']),
    consentedAt: z.iso.datetime(),
    eligibleForAggregate: z.literal(false),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
});
export const financePriceObservationCreateSchema = z.strictObject({
    ingredientId: z.uuid(),
    unit: z.string().min(1).max(32),
    quantity: quantitySchema.refine((value) => Number(value) > 0),
    amountMinor: amountMinorSchema,
    observedAt: z.iso.datetime(),
    financeConsent: z.literal(true),
    idempotencyKey: z.uuid(),
});
export const financeResolvedPriceSchema = z.strictObject({
    ingredientId: z.uuid(),
    ingredientName: z.string(),
    unit: z.string(),
    amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    perQuantity: z.literal('1'),
    currency: z.literal('RUB'),
    source: financePriceSourceSchema,
    observedAt: z.iso.datetime().nullable(),
    sampleCount: z.number().int().positive(),
    methodVersion: z.string(),
});
export const financePriceListSchema = z.strictObject({
    access: proAccessSchema,
    scope: z.literal('private'),
    currency: z.literal('RUB'),
    disclaimer: z.string(),
    items: z.array(financePriceObservationSchema),
    resolved: z.array(financeResolvedPriceSchema),
});
export const financePriceObservationResultSchema = z.strictObject({
    access: proAccessSchema,
    observation: financePriceObservationSchema,
    resolved: financeResolvedPriceSchema,
});
export const financePriceCatalogSchema = z.strictObject({
    access: proAccessSchema,
    items: z.array(z.strictObject({ ingredientId: z.uuid(), name: z.string(), unit: z.string() })),
});

export const financeCostLineSchema = z.strictObject({
    ingredientId: z.uuid().nullable(),
    name: z.string(),
    quantity: quantitySchema.nullable(),
    unit: z.string().nullable(),
    estimatedMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    price: financeResolvedPriceSchema.nullable(),
    reason: z.enum(['priced', 'unknown_ingredient', 'unknown_quantity', 'unknown_unit', 'price_unavailable']),
});
export const financeCostEstimateSchema = z
    .strictObject({
        access: proAccessSchema,
        subject: z.strictObject({
            type: z.enum(['recipe', 'shopping_list', 'meal_plan']),
            id: z.uuid(),
            title: z.string(),
        }),
        currency: z.literal('RUB'),
        approximate: z.literal(true),
        disclaimer: z.string(),
        complete: z.boolean(),
        knownLineCount: z.number().int().nonnegative(),
        totalLineCount: z.number().int().nonnegative(),
        knownSubtotalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        estimatedTotalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
        lines: z.array(financeCostLineSchema),
    })
    .superRefine((value, context) => {
        if (!value.complete && value.estimatedTotalMinor !== null)
            context.addIssue({
                code: 'custom',
                path: ['estimatedTotalMinor'],
                message: 'Неполная оценка не имеет итога',
            });
        if (value.complete && value.estimatedTotalMinor === null)
            context.addIssue({ code: 'custom', path: ['estimatedTotalMinor'], message: 'Полная оценка требует итог' });
    });

export type FinanceExpenseCreate = z.infer<typeof financeExpenseCreateSchema>;
export type FinanceExpenseUpdate = z.infer<typeof financeExpenseUpdateSchema>;
export type FinanceBudgetCreate = z.infer<typeof financeBudgetCreateSchema>;
export type FinanceBudgetUpdate = z.infer<typeof financeBudgetUpdateSchema>;
export type FinancePriceObservationCreate = z.infer<typeof financePriceObservationCreateSchema>;
