import { z } from 'zod';
import { inventoryUnitSchema, quantitySchema } from '../inventory/inventory.contracts.js';
import { proAccessSchema } from '../pro-overview/pro-overview.contracts.js';

export const diaryMealSchema = z.enum(['breakfast', 'snack', 'lunch', 'dinner', 'other']);
export const diaryNutrientsSchema = z.strictObject({
    energyKcal: quantitySchema.nullable(),
    proteinG: quantitySchema.nullable(),
    fatG: quantitySchema.nullable(),
    carbohydrateG: quantitySchema.nullable(),
    fiberG: quantitySchema.nullable(),
});
export const diaryCompletenessSchema = z.enum(['complete', 'partial', 'unknown']);
const sourceInputSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('manual'), name: z.string().trim().min(1).max(200) }),
    z.strictObject({ type: z.literal('ingredient'), ingredientId: z.uuid() }),
    z.strictObject({
        type: z.literal('inventory_batch'),
        batchId: z.uuid(),
        batchVersion: z.number().int().positive(),
    }),
    z.strictObject({ type: z.literal('recipe'), recipeId: z.uuid() }),
]);
export const diaryComponentInputSchema = z.strictObject({
    id: z.uuid(),
    source: sourceInputSchema,
    quantity: quantitySchema.refine((value) => Number(value) > 0, 'Quantity must be positive'),
    unit: inventoryUnitSchema,
});
export const diaryCreateSchema = z.strictObject({
    eatenAt: z.iso.datetime(),
    meal: diaryMealSchema,
    note: z.string().trim().max(2000).nullable(),
    components: z.array(diaryComponentInputSchema).min(1).max(20),
    idempotencyKey: z.uuid(),
});
export const diaryUpdateSchema = z.strictObject({
    eatenAt: z.iso.datetime(),
    meal: diaryMealSchema,
    note: z.string().trim().max(2000).nullable(),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const diaryArchiveSchema = z.strictObject({
    archived: z.boolean(),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const diaryPortionDecisionSchema = z.strictObject({
    decision: z.enum(['confirmed', 'refused', 'cancelled']),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const diaryMediaUploadSchema = z.strictObject({
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    sizeBytes: z
        .number()
        .int()
        .positive()
        .max(10 * 1024 * 1024),
    idempotencyKey: z.uuid(),
});
export const diaryMediaCapabilitySchema = z.strictObject({
    mode: z.literal('unavailable'),
    reason: z.string(),
    acceptedMimeTypes: z.array(z.enum(['image/jpeg', 'image/png', 'image/webp'])),
    maxBytes: z.number().int().positive(),
});
export const diarySourceSnapshotSchema = z.strictObject({
    type: z.enum(['manual', 'ingredient', 'inventory_batch', 'recipe', 'portion_proposal']),
    id: z.uuid().nullable(),
    name: z.string(),
    scope: z.enum(['private', 'catalog', 'public', 'manual']),
});
export const diaryComponentSchema = z.strictObject({
    id: z.uuid(),
    source: diarySourceSnapshotSchema,
    quantity: quantitySchema,
    unit: inventoryUnitSchema,
    nutrition: diaryNutrientsSchema,
    completeness: diaryCompletenessSchema,
    confidence: z.enum(['confirmed', 'estimated', 'unconfirmed']),
});
export const diaryEntrySchema = z.strictObject({
    id: z.uuid(),
    eatenAt: z.iso.datetime(),
    meal: diaryMealSchema,
    state: z.enum(['confirmed', 'archived']),
    confirmationMethod: z.enum(['manual', 'timeout']),
    proposalId: z.uuid().nullable(),
    note: z.string().nullable(),
    nutrition: diaryNutrientsSchema,
    completeness: diaryCompletenessSchema,
    components: z.array(diaryComponentSchema),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
});
export const diaryPortionProposalSchema = z.strictObject({
    id: z.uuid(),
    source: z.strictObject({ batchId: z.uuid(), name: z.string() }),
    quantity: quantitySchema,
    unit: inventoryUnitSchema,
    state: z.enum(['pending', 'confirmed', 'auto_confirmed', 'refused', 'cancelled']),
    confirmationMethod: z.enum(['manual', 'timeout', 'refused', 'cancelled']).nullable(),
    availableAt: z.iso.datetime(),
    dueAt: z.iso.datetime(),
    decisionAt: z.iso.datetime().nullable(),
    version: z.number().int().positive(),
    actions: z.strictObject({
        canConfirm: z.boolean(),
        canRefuse: z.boolean(),
        canCancel: z.boolean(),
    }),
});
export const diaryPortionDecisionResultSchema = z.strictObject({ proposal: diaryPortionProposalSchema });
export const diaryResultSchema = z.strictObject({ entry: diaryEntrySchema });
export const diaryDaySchema = z.strictObject({
    access: proAccessSchema,
    date: z.iso.date(),
    items: z.array(diaryEntrySchema),
    proposals: z.array(diaryPortionProposalSchema),
    media: diaryMediaCapabilitySchema,
    summary: z.strictObject({
        entryCount: z.number().int().nonnegative(),
        nutrition: diaryNutrientsSchema,
        completeness: diaryCompletenessSchema,
    }),
});
export const diarySourcesSchema = z.strictObject({
    items: z.array(
        z.strictObject({
            type: z.enum(['ingredient', 'inventory_batch', 'recipe']),
            id: z.uuid(),
            name: z.string(),
            unit: inventoryUnitSchema,
            availableQuantity: quantitySchema.nullable(),
            version: z.number().int().positive().nullable(),
            scope: z.enum(['private', 'catalog', 'public']),
        }),
    ),
});

export type DiaryCreate = z.infer<typeof diaryCreateSchema>;
export type DiaryUpdate = z.infer<typeof diaryUpdateSchema>;
export type DiaryArchive = z.infer<typeof diaryArchiveSchema>;
export type DiaryPortionDecision = z.infer<typeof diaryPortionDecisionSchema>;
export type DiaryPortionProposal = z.infer<typeof diaryPortionProposalSchema>;
export type DiaryMediaUpload = z.infer<typeof diaryMediaUploadSchema>;
export type DiaryEntry = z.infer<typeof diaryEntrySchema>;
export type DiaryComponent = z.infer<typeof diaryComponentSchema>;
