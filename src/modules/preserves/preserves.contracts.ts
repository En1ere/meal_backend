import { z } from 'zod';
import { inventoryUnitSchema, quantitySchema } from '../inventory/inventory.contracts.js';
export const preserveTypeSchema = z.enum([
    'canned',
    'jam',
    'frozen',
    'dried',
    'fermented',
    'infusion',
    'meat',
    'cheese',
    'other',
]);
export const preserveScopeSchema = z.enum(['private', 'family']);
export const preserveScopeInputSchema = z.object({ scope: preserveScopeSchema.default('private') }).strict();
export const preserveIngredientSchema = z
    .object({
        name: z.string().trim().min(1).max(200),
        ingredientId: z.uuid().nullable(),
        quantity: quantitySchema.nullable(),
        unit: inventoryUnitSchema.nullable(),
    })
    .strict();
export const preserveFieldsSchema = z
    .object({
        name: z.string().trim().min(1).max(200),
        type: preserveTypeSchema,
        createdOn: z.iso.date(),
        expiryOn: z.iso.date().nullable(),
        shelfLifeDays: z.number().int().min(1).max(36500).nullable(),
        locationId: z.uuid().nullable(),
        unit: inventoryUnitSchema.nullable(),
        volumePerUnit: quantitySchema.nullable(),
        notes: z.string().max(10000).nullable(),
        tags: z.array(z.string().trim().min(1).max(50)).max(30),
        ingredients: z.array(preserveIngredientSchema).max(100),
        imageUrl: z.string().max(2000).nullable(),
    })
    .strict();
export const preserveContainerSchema = z.object({
    id: z.uuid(),
    label: z.string(),
    initialQuantity: quantitySchema.nullable(),
    remainingQuantity: quantitySchema.nullable(),
    openedAt: z.iso.datetime().nullable(),
    depletedAt: z.iso.datetime().nullable(),
    version: z.number().int().positive(),
});
export const preserveSchema = preserveFieldsSchema.extend({
    id: z.uuid(),
    batchId: z.uuid(),
    version: z.number().int().positive(),
    quantity: quantitySchema.nullable(),
    createdAt: z.iso.datetime(),
    archivedAt: z.iso.datetime().nullable(),
    recipeRevisionId: z.uuid().nullable(),
    recipeId: z.uuid().nullable(),
    recipeTitle: z.string().nullable(),
    containers: z.array(preserveContainerSchema),
    scope: preserveScopeSchema,
    capabilities: z.object({
        qr: z.boolean(),
        print: z.boolean(),
        reason: z.literal('requires-plus').nullable(),
    }),
});
export const preserveResultSchema = z.object({ preserve: preserveSchema });
export const preserveListQuerySchema = z
    .object({
        q: z.string().trim().max(200).default(''),
        type: preserveTypeSchema.optional(),
        locationId: z.union([z.uuid(), z.literal('none')]).optional(),
        status: z.enum(['active', 'archived', 'all']).default('active'),
        attention: z.enum(['all', 'expiring', 'expired', 'unknown']).default('all'),
        days: z.coerce.number().int().min(1).max(365).default(14),
        localDate: z.iso.date(),
        page: z.coerce.number().int().min(1).max(10000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        scope: preserveScopeSchema.default('private'),
    })
    .strict();
export const preserveListSchema = z.object({
    items: z.array(preserveSchema),
    total: z.number().int().nonnegative(),
    attentionCount: z.number().int().nonnegative(),
    page: z.number().int(),
    limit: z.number().int(),
});
export const preserveCreateSchema = preserveFieldsSchema
    .extend({
        scope: preserveScopeSchema.default('private'),
        recipeRevisionId: z.uuid().nullable(),
        containers: z
            .array(z.object({ label: z.string().trim().min(1).max(100), quantity: quantitySchema.nullable() }).strict())
            .min(1)
            .max(500),
        idempotencyKey: z.uuid(),
    })
    .superRefine((value, context) => {
        if (value.unit === null && value.containers.some((c) => c.quantity !== null))
            context.addIssue({ code: 'custom', path: ['unit'], message: 'Для известного количества нужна единица' });
    });
export const preserveCommandSchema = z
    .object({
        version: z.number().int().positive(),
        idempotencyKey: z.uuid(),
        scope: preserveScopeSchema.default('private'),
    })
    .strict();
export const preserveEditSchema = preserveCommandSchema.extend({ fields: preserveFieldsSchema });
export const preserveOpenSchema = preserveCommandSchema.extend({
    containerVersion: z.number().int().positive(),
    openedAt: z.iso.datetime(),
    timezone: z
        .string()
        .min(1)
        .max(100)
        .refine((value) => {
            try {
                new Intl.DateTimeFormat('en', { timeZone: value });
                return true;
            } catch {
                return false;
            }
        }, 'Неизвестный часовой пояс'),
});
export const preserveQuantitySchema = preserveCommandSchema.extend({
    containerVersion: z.number().int().positive(),
    quantity: quantitySchema.nullable(),
});
export const preserveConsumePreviewInputSchema = z
    .object({
        version: z.number().int().positive(),
        containerId: z.uuid(),
        containerVersion: z.number().int().positive(),
        quantity: quantitySchema.refine((v) => /[1-9]/.test(v), 'Положительное количество'),
        scope: preserveScopeSchema.default('private'),
    })
    .strict();
export const preserveConsumeSchema = preserveConsumePreviewInputSchema.extend({
    previewToken: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.uuid(),
});
export const preserveConsumePreviewSchema = z.object({
    preserveId: z.uuid(),
    containerId: z.uuid(),
    before: quantitySchema,
    after: quantitySchema,
    unit: inventoryUnitSchema,
    previewToken: z.string(),
});
export const preserveHistoryDetailsSchema = z
    .object({
        containerId: z.uuid().nullable().optional(),
        quantity: quantitySchema.nullable().optional(),
        before: quantitySchema.nullable().optional(),
        after: quantitySchema.nullable().optional(),
        openedAt: z.iso.datetime().nullable().optional(),
        recipeId: z.uuid().nullable().optional(),
        revisionId: z.uuid().nullable().optional(),
        containerCount: z.number().int().nonnegative().optional(),
        labelId: z.uuid().optional(),
        revision: z.number().int().positive().optional(),
    })
    .strict();
export const preserveHistorySchema = z.object({
    items: z.array(
        z.object({
            id: z.uuid(),
            action: z.string(),
            recordedAt: z.iso.datetime(),
            details: preserveHistoryDetailsSchema,
        }),
    ),
    total: z.number().int().nonnegative(),
    page: z.number().int(),
    limit: z.number().int(),
});
export const preserveHistoryQuerySchema = z
    .object({
        page: z.coerce.number().int().min(1).max(10000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        scope: preserveScopeSchema.default('private'),
    })
    .strict();
export const preserveRecipeBaseSchema = z.object({ recipeId: z.uuid(), revisionId: z.uuid() });
export const preserveQrPayloadSchema = z
    .object({
        schemaVersion: z.literal(1),
        id: z.uuid(),
        name: z.string().min(1).max(200),
        type: preserveTypeSchema,
        createdOn: z.iso.date(),
        expiryOn: z.iso.date().nullable(),
        appUrl: z.string().regex(/^mealplanner:\/\/preserve\/[0-9a-f-]{36}$/u),
    })
    .strict();
export const preserveQrLabelSchema = z.object({
    id: z.uuid(),
    revision: z.number().int().positive(),
    issuedAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    payload: preserveQrPayloadSchema,
});
export const preserveQrCapabilitySchema = z.object({
    available: z.boolean(),
    reason: z.literal('requires-plus').nullable(),
});
export const preserveQrResultSchema = z.object({
    label: preserveQrLabelSchema.nullable(),
    capability: preserveQrCapabilitySchema,
});
export const preserveQrIssueSchema = z
    .object({
        preserveVersion: z.number().int().positive(),
        idempotencyKey: z.uuid(),
        scope: preserveScopeSchema.default('private'),
    })
    .strict();
export type Preserve = z.infer<typeof preserveSchema>;
