import { z } from 'zod';
import { cookingQuantitySchema } from '../cooking/cooking.contracts.js';
import { quantitySchema } from '../inventory/inventory.contracts.js';
import { workflowScopeSchema as shoppingScopeSchema } from '../../shared/contracts/workflow-scope.js';
export const receiptScopeQuerySchema = z.object({ scope: shoppingScopeSchema.default('private') }).strict();
export const purchaseLineInputSchema = z
    .object({
        id: z.uuid(),
        name: z.string().trim().min(1).max(200),
        quantity: cookingQuantitySchema.nullable(),
        unit: z.string().max(30).nullable(),
        ingredientId: z.uuid().nullable(),
        productId: z.uuid().nullable(),
        locationId: z.uuid().nullable(),
        isFood: z.boolean(),
        intake: z.boolean(),
        shoppingItemId: z.uuid().nullable(),
        expiryOn: z.iso.date().nullable(),
        amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().default(null),
        originalAmountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().default(null),
        discountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().default(null),
    })
    .strict();
export const purchaseReviewSchema = z
    .object({
        version: z.number().int().positive(),
        purchasedAt: z.iso.datetime(),
        lines: z.array(purchaseLineInputSchema).min(1).max(200),
        scope: shoppingScopeSchema.optional(),
    })
    .strict();
export const purchaseCommitSchema = purchaseReviewSchema.extend({
    previewToken: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.uuid(),
});
export const purchasePreviewSchema = z.strictObject({
    previewToken: z.string(),
    lines: z.array(
        z.strictObject({
            id: z.uuid(),
            allocatedQuantity: quantitySchema.nullable(),
            remainingNeed: quantitySchema.nullable(),
            overage: quantitySchema.nullable(),
            intake: z.boolean(),
        }),
    ),
});
export const purchaseResultSchema = z.strictObject({
    purchaseId: z.uuid(),
    batchIds: z.array(z.uuid()),
    unknownLineIds: z.array(z.uuid()),
});
export const receiptSourceSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('photo'),
        storageStatus: z.literal('deferred'),
        reference: z.string().max(200).nullable(),
    }),
    z.strictObject({
        kind: z.literal('electronic_link'),
        storageStatus: z.literal('not_required'),
        reference: z
            .url()
            .max(2000)
            .refine((value) => {
                const url = new URL(value);
                return url.protocol === 'https:' && !url.username && !url.password;
            }, 'Нужна безопасная HTTPS-ссылка'),
    }),
]);
export const receiptFinancialSchema = z
    .strictObject({
        currency: z.literal('RUB').default('RUB'),
        storeName: z.string().trim().min(1).max(200).nullable().default(null),
        totalMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        discountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
        paymentMethod: z.enum(['cash', 'card', 'other', 'unknown']).default('unknown'),
        fiscalNumber: z.string().trim().min(1).max(100).nullable().default(null),
        fiscalDocumentNumber: z.string().trim().min(1).max(100).nullable().default(null),
        financeConsent: z.literal(true),
        consentedAt: z.iso.datetime().nullable().default(null),
    })
    .superRefine((value, context) => {
        if (value.discountMinor > value.totalMinor)
            context.addIssue({ code: 'custom', path: ['discountMinor'], message: 'Скидка больше суммы чека' });
    });
export const receiptCreateSchema = z
    .object({
        idempotencyKey: z.uuid(),
        source: receiptSourceSchema,
        ocrText: z.string().max(100000),
        lines: z.array(purchaseLineInputSchema).min(1).max(200),
        financial: receiptFinancialSchema.nullable().default(null),
        scope: shoppingScopeSchema.optional(),
    })
    .strict();
export const receiptEditSchema = z
    .object({
        version: z.number().int().positive(),
        idempotencyKey: z.uuid(),
        lines: z.array(purchaseLineInputSchema).min(1).max(200),
        financial: receiptFinancialSchema.nullable().optional(),
        scope: shoppingScopeSchema.optional(),
    })
    .strict();
export const receiptLinkSchema = z
    .object({
        version: z.number().int().positive(),
        idempotencyKey: z.uuid(),
        purchaseId: z.uuid(),
        scope: shoppingScopeSchema.optional(),
    })
    .strict();
export const receiptSchema = z.strictObject({
    id: z.uuid(),
    version: z.number().int(),
    status: z.enum(['draft', 'committed', 'linked']),
    source: receiptSourceSchema,
    ocrText: z.string(),
    lines: z.array(purchaseLineInputSchema),
    financial: receiptFinancialSchema.nullable().default(null),
    result: purchaseResultSchema.nullable(),
    history: z.array(z.strictObject({ action: z.string(), at: z.iso.datetime() })),
});
export const receiptResultSchema = z.strictObject({ receipt: receiptSchema });
export const receiptCapabilitiesSchema = z.strictObject({
    photo: z.literal(true),
    electronicLink: z.literal(true),
    pdfUpload: z.literal(false),
    ocrAdapter: z.literal(false),
    pdfUnavailableReason: z.literal('storage_not_configured'),
});
export const receiptDuplicatesSchema = z.strictObject({
    items: z.array(
        z.strictObject({
            purchaseId: z.uuid(),
            purchasedAt: z.iso.datetime(),
            reason: z.literal('review-required'),
            lineNames: z.array(z.string()),
            lineCount: z.number().int(),
        }),
    ),
});
export const purchaseDetailSchema = z.strictObject({
    purchaseId: z.uuid(),
    version: z.number().int(),
    purchasedAt: z.iso.datetime(),
    lines: z.array(purchaseLineInputSchema.extend({ version: z.number().int(), batchIds: z.array(z.uuid()) })),
});
export const purchaseResolveSchema = z
    .object({
        version: z.number().int().positive(),
        line: purchaseLineInputSchema,
        scope: shoppingScopeSchema.optional(),
    })
    .strict();
export const purchaseResolveCommitSchema = purchaseResolveSchema.extend({
    previewToken: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.uuid(),
});
