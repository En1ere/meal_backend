import { z } from 'zod';
import { recipeSummarySchema } from '../../shared/contracts/recipe-public.js';

export const recommendationReasonCodeSchema = z.enum([
    'inventory_match',
    'expiring_ingredients',
    'diet_match',
    'quick_goal',
    'variety',
    'similar_tastes',
    'high_rating',
    'new_recipe',
    'author_affinity',
    'author_quality',
    'author_similar_audience',
]);

export const recommendationExplanationSchema = z.strictObject({
    code: recommendationReasonCodeSchema,
    text: z.string().min(1).max(160),
});

export const recommendationSafetyWarningSchema = z.strictObject({
    code: z.enum(['allergens_incomplete', 'allergen_contains', 'allergen_may_contain', 'allergen_unknown']),
    text: z.string().min(1).max(200),
});

const recommendationMetaSchema = z.strictObject({
    recommendationId: z.uuid(),
    algorithmVersion: z.literal('personalized-v1'),
    score: z.number().min(0).max(100),
    reasonCodes: z.array(recommendationReasonCodeSchema).min(1).max(3),
    reasons: z.array(recommendationExplanationSchema).min(1).max(3),
    safetyWarnings: z.array(recommendationSafetyWarningSchema).max(3),
});

export const recipeRecommendationSchema = recommendationMetaSchema
    .extend({
        type: z.literal('recipe'),
        recipe: recipeSummarySchema,
    })
    .strict();

export const authorRecommendationSchema = recommendationMetaSchema
    .extend({
        type: z.literal('author'),
        author: z.strictObject({
            username: z.string().min(1),
            recipeCount: z.number().int().nonnegative(),
            averageRating: z.number().min(1).max(5).nullable(),
            followerCount: z.number().int().nonnegative(),
            followed: z.literal(false),
        }),
    })
    .strict();

export const recommendationSchema = z.discriminatedUnion('type', [
    recipeRecommendationSchema,
    authorRecommendationSchema,
]);

export const recommendationsResultSchema = z.strictObject({
    algorithm: z.literal('personalized-v1'),
    items: z.array(recommendationSchema),
});

export const recommendationsQuerySchema = z
    .strictObject({
        type: z.enum(['recipe', 'author']).default('recipe'),
        scope: z.enum(['private', 'family']).default('private'),
        surface: z.enum(['home', 'recipes', 'authors']).default('recipes'),
        limit: z.coerce.number().int().min(1).max(50).default(20),
    })
    .superRefine((value, context) => {
        if (
            (value.type === 'recipe' && value.surface === 'authors') ||
            (value.type === 'author' && value.surface !== 'authors')
        )
            context.addIssue({
                code: 'custom',
                path: ['surface'],
                message: 'Surface не соответствует типу рекомендации',
            });
    });

export const recommendationEventSchema = z.strictObject({
    event: z.enum(['impression', 'open', 'not_interested', 'not_suitable']),
    recommendationId: z.uuid(),
    entityType: z.enum(['recipe', 'author']),
    entityId: z.string().min(1).max(256),
    algorithm: z.literal('personalized-v1'),
    surface: z.enum(['home', 'recipes', 'authors']),
    position: z.number().int().min(0).max(999),
    reasonCodes: z.array(recommendationReasonCodeSchema).max(3),
    idempotencyKey: z.uuid(),
});

export const recommendationEventResultSchema = z.strictObject({ accepted: z.literal(true) });

export const authorFollowSchema = z.strictObject({ following: z.boolean(), idempotencyKey: z.uuid() });
export const authorFollowResultSchema = z.strictObject({ username: z.string(), following: z.boolean() });
export const authorFollowingQuerySchema = z.strictObject({
    cursor: z.string().trim().max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const followedAuthorSchema = z.strictObject({
    username: z.string(),
    avatarUrl: z.string().nullable(),
    recipeCount: z.number().int().nonnegative(),
    following: z.literal(true),
});
export const authorFollowingListSchema = z.strictObject({
    items: z.array(followedAuthorSchema),
    nextCursor: z.string().nullable(),
});

export type RecommendationReasonCode = z.infer<typeof recommendationReasonCodeSchema>;
export type RecipeRecommendation = z.infer<typeof recipeRecommendationSchema>;
export type AuthorRecommendation = z.infer<typeof authorRecommendationSchema>;
export type RecommendationsQuery = z.infer<typeof recommendationsQuerySchema>;
