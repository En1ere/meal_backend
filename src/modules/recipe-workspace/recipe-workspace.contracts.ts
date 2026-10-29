import { z } from 'zod';
import { recipeNutritionSchema } from '../recipes/recipes.contracts.js';
export const workspaceNutritionSchema = z.object({
    status: z.enum(['calculated', 'base-unadjusted', 'unavailable']),
    base: recipeNutritionSchema.nullable(),
    uncoveredIngredientIds: z.array(z.string()),
});
const uuid = z.uuid();
const nullableId = uuid.nullable().default(null);
export const workspaceScopeSchema = z.enum(['private', 'family']);
export const workspaceIngredientSchema = z
    .object({
        ingredientId: nullableId,
        variantId: nullableId,
        productId: nullableId,
        sourceRecipeId: nullableId,
        quantity: z
            .string()
            .regex(/^\d{1,16}(?:\.\d{1,8})?$/)
            .nullable()
            .default(null),
        unit: z.string().min(1).max(30).nullable().default(null),
        optional: z.boolean().default(false),
    })
    .strict()
    .refine(
        (v) => [v.ingredientId, v.variantId, v.productId, v.sourceRecipeId].filter(Boolean).length === 1,
        'Выберите один источник ингредиента',
    );
export const workspaceStepSchema = z
    .object({
        text: z.string().max(10000),
        durationSeconds: z.number().int().min(0).max(604800).nullable().default(null),
        temperature: z
            .string()
            .regex(/^-?\d{1,4}(?:\.\d{1,2})?$/)
            .nullable()
            .default(null),
    })
    .strict();
export const workspaceDocumentSchema = z
    .object({
        title: z.string().trim().max(300).default(''),
        description: z.string().max(10000).nullable().default(null),
        category: z.string().trim().max(100).nullable().default(null),
        tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
        baseServings: z.number().int().min(1).max(1000).default(1),
        method: z.string().max(100).default(''),
        ingredients: z.array(workspaceIngredientSchema).max(100).default([]),
        steps: z.array(workspaceStepSchema).max(100).default([]),
    })
    .strict();
export const workspaceCreateSchema = z
    .object({ idempotencyKey: uuid, scope: workspaceScopeSchema.default('private'), document: workspaceDocumentSchema })
    .strict();
export const workspaceCommandSchema = z
    .object({ idempotencyKey: uuid, expectedVersion: z.number().int().positive() })
    .strict();
export const workspaceSaveSchema = workspaceCommandSchema.extend({ document: workspaceDocumentSchema });
export const workspaceVariantSchema = z.object({ idempotencyKey: uuid }).strict();
export const workspaceQuerySchema = z
    .object({
        q: z.string().trim().max(200).default(''),
        scope: workspaceScopeSchema.default('private'),
        status: z.enum(['active', 'archived']).default('active'),
        page: z.coerce.number().int().min(1).max(10000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict();
export const workspaceDetailQuerySchema = z.object({ scope: workspaceScopeSchema.default('private') }).strict();
export const recipeReviewStatusSchema = z.enum(['draft', 'pending', 'rejected', 'published', 'hidden', 'unpublished']);
export const workspaceRecipeSchema = z.object({
    nutrition: workspaceNutritionSchema,
    id: uuid,
    revisionId: uuid,
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    status: recipeReviewStatusSchema,
    review: z.strictObject({
        revisionId: uuid,
        status: recipeReviewStatusSchema,
        publicReason: z.string().nullable(),
    }),
    publication: z.strictObject({ revisionId: uuid, publishedAt: z.iso.datetime() }).nullable(),
    archived: z.boolean(),
    baseRecipeId: uuid.nullable(),
    availabilityScope: workspaceScopeSchema,
    authorLogin: z.string().nullable(),
    canEdit: z.boolean(),
    document: workspaceDocumentSchema,
});
export const workspaceListSchema = z.object({
    items: z.array(workspaceRecipeSchema),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
});
export const workspaceResultSchema = z.object({ recipe: workspaceRecipeSchema });
export const workspaceRatingSchema = z
    .object({
        idempotencyKey: uuid,
        attemptId: uuid,
        value: z.number().int().min(1).max(5),
        confirmed: z.literal(true),
    })
    .strict();
export const workspaceCommentSchema = z
    .object({
        idempotencyKey: uuid,
        attemptId: uuid,
        body: z.string().trim().min(1).max(5000),
        replyToId: uuid.nullable().default(null),
    })
    .strict();
export const workspaceCommentEditSchema = workspaceCommandSchema.extend({ body: z.string().trim().min(1).max(5000) });
export const workspaceReportSchema = z
    .object({
        idempotencyKey: uuid,
        reason: z.enum(['copyright', 'dangerous', 'inappropriate', 'community', 'personal-data', 'quality', 'fake']),
        comment: z.string().trim().max(5000).nullable().default(null),
        commentId: uuid.nullable().default(null),
    })
    .strict();
export type WorkspaceDocument = z.infer<typeof workspaceDocumentSchema>;
export type WorkspaceRecipe = z.infer<typeof workspaceRecipeSchema>;
export const workspaceCommunitySchema = z.object({
    attemptId: uuid.nullable(),
    rating: z.number().int().min(1).max(5).nullable(),
    comments: z.array(
        z.object({
            id: uuid,
            authorLogin: z.string().nullable(),
            body: z.string(),
            editedAt: z.string().nullable(),
            createdAt: z.string(),
            version: z.number().int(),
            isOwn: z.boolean(),
            replyToId: uuid.nullable(),
        }),
    ),
    reports: z.array(z.object({ id: uuid, reason: z.string(), status: z.string(), submittedAt: z.string() })),
});
export const workspaceCommunityMutationSchema = z.object({ id: uuid });
export const workspaceReportsQuerySchema = workspaceQuerySchema.pick({ page: true, limit: true });
export const workspaceReportDetailSchema = z.strictObject({
    id: uuid,
    recipeId: uuid.nullable(),
    reason: z.string(),
    status: z.string(),
    submittedAt: z.string(),
});
export const workspaceReportsSchema = z.object({
    items: z.array(
        z.object({ id: uuid, recipeId: uuid, reason: z.string(), status: z.string(), submittedAt: z.string() }),
    ),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
});
export function assertSubmittable(document: WorkspaceDocument): void {
    if (
        !document.title.trim() ||
        !document.ingredients.length ||
        !document.steps.length ||
        document.steps.some((s) => !s.text.trim())
    )
        throw new Error('Для публикации нужны название, ингредиенты и непустые шаги');
}
