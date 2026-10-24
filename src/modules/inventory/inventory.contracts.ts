import { z } from 'zod';

export const quantitySchema = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/);
const date = z.iso.date().nullable();
export const inventoryUnitSchema = z.enum(['g', 'kg', 'ml', 'l', 'pcs', 'pack', 'serv']);
export const inventoryScopeSchema = z.enum(['private', 'family']);
export const inventoryFieldsSchema = z
    .object({
        name: z.string().trim().min(1).max(200),
        quantity: quantitySchema.nullable(),
        unit: inventoryUnitSchema,
        locationId: z.uuid().nullable(),
        openedAt: z.iso.datetime().nullable(),
        purchasedOn: date,
        expiryOn: date,
        packageState: z.enum(['sealed', 'opened', 'unknown']),
        precision: z.enum(['exact', 'estimated']),
        quantitySource: z.enum(['user', 'receipt', 'recipe', 'inventory', 'system']).default('user'),
        confidence: z.number().min(0).max(1).nullable().default(null),
        pricePaidRub: quantitySchema.nullable(),
        storeName: z.string().trim().max(200).nullable(),
        barcode: z.string().max(128).nullable(),
    })
    .strict();
export const inventoryBatchSchema = inventoryFieldsSchema.extend({
    id: z.uuid(),
    ingredientId: z.uuid(),
    scope: inventoryScopeSchema,
    version: z.number().int().positive(),
    archivedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
});
export const inventoryCreateSchema = inventoryFieldsSchema.extend({
    locationId: z.uuid(),
    quantity: z
        .string()
        .regex(/^(?!0(?:\.0+)?$)(0|[1-9]\d{0,15})(\.\d{1,8})?$/)
        .nullable(),
    ingredientId: z.uuid(),
    scope: inventoryScopeSchema,
    idempotencyKey: z.uuid(),
});
const commandBase = z.object({
    version: z.number().int().positive(),
    scope: inventoryScopeSchema,
    idempotencyKey: z.uuid(),
});
export const inventoryCommandSchema = z.discriminatedUnion('action', [
    commandBase.extend({ action: z.literal('edit'), fields: inventoryFieldsSchema }).strict(),
    commandBase.extend({ action: z.literal('consume'), quantity: quantitySchema }).strict(),
    commandBase.extend({ action: z.literal('transfer'), locationId: z.uuid() }).strict(),
    commandBase.extend({ action: z.enum(['archive', 'restore']) }).strict(),
]);
export const inventoryLocationSchema = z.object({
    id: z.uuid(),
    name: z.string(),
    type: z.enum(['fridge', 'freezer', 'cabinet', 'pantry', 'shelf']),
    version: z.number().int().positive(),
});
export const inventoryLocationCommandSchema = z.discriminatedUnion('action', [
    z
        .object({
            action: z.literal('create'),
            name: z.string().trim().min(1).max(100),
            type: inventoryLocationSchema.shape.type,
            scope: inventoryScopeSchema,
            idempotencyKey: z.uuid(),
        })
        .strict(),
    commandBase.extend({ action: z.literal('rename'), id: z.uuid(), name: z.string().trim().min(1).max(100) }).strict(),
]);
export const inventoryListSchema = z.object({
    items: z.array(inventoryBatchSchema),
    total: z.number().int().nonnegative(),
});
export const inventoryResultSchema = z.object({ batch: inventoryBatchSchema });
export const inventoryLocationsSchema = z.object({ items: z.array(inventoryLocationSchema) });
export const inventoryLocationResultSchema = z.object({ location: inventoryLocationSchema });
export const inventoryHistoryBatchSchema = inventoryBatchSchema.extend({ ingredientId: z.uuid().nullable() });
export const inventoryHistorySchema = z.object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    items: z.array(
        z.object({
            id: z.uuid(),
            action: z.string(),
            quantityDelta: z.string().nullable(),
            recordedAt: z.iso.datetime(),
            effectiveAt: z.iso.datetime(),
            actorId: z.uuid().nullable(),
            before: inventoryHistoryBatchSchema.nullable(),
            after: inventoryHistoryBatchSchema,
        }),
    ),
});
export type InventoryBatch = z.infer<typeof inventoryBatchSchema>;
export type InventoryCreate = z.infer<typeof inventoryCreateSchema>;
export type InventoryCommand = z.infer<typeof inventoryCommandSchema>;

export const inventoryImportSchema = z
    .object({ rows: z.array(inventoryCreateSchema).min(1).max(5000), idempotencyKey: z.uuid() })
    .strict();
export const inventoryImportResultSchema = z.object({ items: z.array(inventoryBatchSchema) });
