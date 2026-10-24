import { z } from 'zod';
import { cookingQuantitySchema } from '../cooking/cooking.contracts.js';
export const shoppingScopeSchema = z.enum(['private', 'family']);
export const shoppingScopeQuerySchema = z.object({ scope: shoppingScopeSchema.default('private') }).strict();
const originSchema = z
    .array(
        z.strictObject({
            revisionId: z.uuid(),
            portions: z.number().int().min(1).max(1000),
            quantity: cookingQuantitySchema.nullable(),
        }),
    )
    .max(20);
export const shoppingFieldsSchema = z
    .object({
        name: z.string().trim().min(1).max(200),
        quantity: cookingQuantitySchema.nullable(),
        unit: z.string().min(1).max(30).nullable(),
        ingredientId: z.uuid().nullable(),
        productId: z.uuid().nullable(),
        allowAnalog: z.boolean(),
        recipeOrigin: originSchema.default([]),
        requirements: z.record(z.string(), z.string().max(200)).default({}),
        estimatedPriceMinor: z.number().int().min(0).max(9007199254740991).nullable().default(null),
    })
    .strict();
export const shoppingItemSchema = shoppingFieldsSchema.extend({
    id: z.uuid(),
    version: z.number().int().positive(),
    status: z.enum(['pending', 'purchased', 'removed']),
    position: z.number().int().nonnegative().default(0),
    manual: z.boolean().default(true),
    allocatedQuantity: cookingQuantitySchema.nullable().default(null),
    origin: z
        .array(
            z.strictObject({
                revisionId: z.uuid().nullable(),
                portions: z.number().int(),
                quantity: cookingQuantitySchema.nullable(),
            }),
        )
        .default([]),
});
export const shoppingListSchema = z.strictObject({
    id: z.uuid(),
    title: z.string(),
    version: z.number().int().positive(),
    status: z.enum(['active', 'completed', 'archived']).default('active'),
    createdAt: z.iso.datetime().optional(),
    progress: z.strictObject({ purchased: z.number().int(), total: z.number().int() }).optional(),
    items: z.array(shoppingItemSchema),
    scope: shoppingScopeSchema,
});
export const shoppingListsSchema = z.strictObject({
    items: z.array(shoppingListSchema.omit({ items: true })),
    nextCursor: z.string().nullable().default(null),
});
export const shoppingListQuerySchema = z
    .object({
        q: z.string().max(200).default(''),
        status: z.enum(['active', 'completed', 'archived', 'all']).default('active'),
        cursor: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        scope: shoppingScopeSchema.default('private'),
    })
    .strict();
export const shoppingCreateSchema = z
    .object({
        title: z.string().trim().min(1).max(200),
        idempotencyKey: z.uuid(),
        scope: shoppingScopeSchema.optional(),
    })
    .strict();
export const shoppingCommandSchema = z
    .object({
        version: z.number().int().positive(),
        idempotencyKey: z.uuid(),
        action: z.enum(['rename', 'complete', 'reopen', 'archive', 'restore']),
        title: z.string().trim().min(1).max(200).optional(),
        scope: shoppingScopeSchema.optional(),
    })
    .strict();
export const shoppingReorderSchema = z
    .object({
        version: z.number().int().positive(),
        idempotencyKey: z.uuid(),
        itemIds: z.array(z.uuid()).max(1000),
        scope: shoppingScopeSchema.optional(),
    })
    .strict();
export const shoppingAddSchema = z
    .object({
        version: z.number().int().positive(),
        idempotencyKey: z.uuid(),
        items: z.array(shoppingFieldsSchema).min(1).max(200),
        scope: shoppingScopeSchema.optional(),
    })
    .strict();
export const shoppingEditSchema = z
    .object({
        version: z.number().int().positive(),
        idempotencyKey: z.uuid(),
        status: z.enum(['pending', 'purchased', 'removed']),
        fields: shoppingFieldsSchema,
        scope: shoppingScopeSchema.optional(),
    })
    .strict();
export const shoppingPreviewQuerySchema = z
    .object({
        recipeId: z.uuid(),
        servings: z.coerce.number().int().min(1).max(1000),
        scope: shoppingScopeSchema.default('private'),
    })
    .strict();
export const shoppingPreviewSchema = z.strictObject({
    recipeId: z.uuid(),
    servings: z.number().int(),
    items: z.array(shoppingFieldsSchema.extend({ needsQuantityCheck: z.boolean() })),
});
export const shoppingHistorySchema = z.strictObject({
    items: z.array(
        z.strictObject({
            id: z.uuid(),
            action: z.string(),
            actorId: z.uuid().nullable(),
            actorLogin: z.string().nullable(),
            at: z.iso.datetime(),
        }),
    ),
});
