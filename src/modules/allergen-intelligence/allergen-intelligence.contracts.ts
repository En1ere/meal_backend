import { z } from 'zod';

export const allergenStatusSchema = z.enum(['contains', 'may_contain', 'unknown']);
export const allergenIconSchema = z.strictObject({
    state: z.enum(['fallback', 'custom', 'unavailable']),
    url: z.string().nullable(),
    fallbackKey: z.string().min(1).max(80),
    alt: z.string().min(1).max(160),
});
export const allergenEvidenceSchema = z.strictObject({
    kind: z.enum(['composition', 'dictionary']),
    source: z.string(),
    mappingId: z.uuid().nullable(),
});
export const recipeAllergenIngredientSchema = z.strictObject({
    recipeIngredientId: z.uuid(),
    name: z.string(),
    ingredientId: z.uuid().nullable(),
    variantId: z.uuid().nullable(),
    productId: z.uuid().nullable(),
});
export const recipeAllergenSchema = z.strictObject({
    code: z.string(),
    name: z.string(),
    status: allergenStatusSchema,
    source: z.string(),
    icon: allergenIconSchema,
    ingredients: z.array(recipeAllergenIngredientSchema),
    evidence: z.array(allergenEvidenceSchema),
});
export const recipeAllergenProjectionSchema = z.strictObject({
    allergens: z.array(recipeAllergenSchema),
    complete: z.boolean(),
    unknownIngredients: z.array(recipeAllergenIngredientSchema),
});

export const allergenAdminQuerySchema = z.strictObject({
    q: z.string().trim().max(100).default(''),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});
export const allergenAdminSummarySchema = z.strictObject({
    code: z.string(),
    name: z.string(),
    version: z.number().int().positive(),
    activeMappings: z.number().int().nonnegative(),
    ingredientMappings: z.number().int().nonnegative(),
    variantMappings: z.number().int().nonnegative(),
    productMappings: z.number().int().nonnegative(),
    icon: allergenIconSchema,
});
export const allergenAdminListSchema = z.strictObject({
    items: z.array(allergenAdminSummarySchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
});
export const allergenSubjectQuerySchema = z.strictObject({
    q: z.string().trim().max(100).default(''),
    subjectType: z.enum(['ingredient', 'variant', 'product']),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const allergenSubjectSchema = z.strictObject({
    subjectType: z.enum(['ingredient', 'variant', 'product']),
    subjectId: z.uuid(),
    subjectName: z.string(),
    imageUrl: z.string().url().nullable(),
});
export const allergenSubjectListSchema = z.strictObject({ items: z.array(allergenSubjectSchema) });
export const allergenMappingSchema = z.strictObject({
    id: z.uuid(),
    subjectType: z.enum(['ingredient', 'variant', 'product']),
    subjectId: z.uuid(),
    subjectName: z.string(),
    status: allergenStatusSchema,
    source: z.string(),
    version: z.number().int().positive(),
});
export const allergenAdminDetailSchema = allergenAdminSummarySchema
    .extend({
        mappings: z.array(allergenMappingSchema),
        iconUpload: z.strictObject({ mode: z.literal('unavailable'), reason: z.string() }),
    })
    .strict();
export const allergenMappingMutationSchema = z.strictObject({
    action: z.enum(['add', 'remove']),
    subjectType: z.enum(['ingredient', 'variant', 'product']),
    subjectId: z.uuid(),
    status: allergenStatusSchema.default('contains'),
    source: z.string().trim().min(1).max(500),
    mappingId: z.uuid().nullable().default(null),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const allergenIconMutationSchema = z.strictObject({
    action: z.enum(['set_fallback', 'remove']),
    fallbackKey: z.string().trim().min(1).max(80),
    altText: z.string().trim().min(1).max(160),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const allergenIconUploadSchema = z.strictObject({
    name: z.string().trim().min(1).max(255),
    mime: z.enum(['image/svg+xml', 'image/png', 'image/webp']),
    size: z.number().int().min(1).max(1048576),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    altText: z.string().trim().min(1).max(160),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const allergenReportSchema = z.strictObject({
    recipeId: z.uuid(),
    revisionId: z.uuid(),
    unknownIngredientIds: z.array(z.uuid()).min(1).max(50),
    note: z.string().trim().max(2000).default(''),
    idempotencyKey: z.uuid(),
});
export const allergenReportResultSchema = z.strictObject({ ticketId: z.uuid(), ticketNumber: z.string() });
