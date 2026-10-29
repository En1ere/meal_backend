import { z } from 'zod';
import {
    recipeAllergenIngredientSchema,
    recipeAllergenSchema,
} from '../allergen-intelligence/allergen-intelligence.contracts.js';
import { recipeSummarySchema } from '../../shared/contracts/recipe-public.js';
export {
    recipeAvailabilitySummarySchema,
    recipeSummarySchema,
    type RecipeSummary,
} from '../../shared/contracts/recipe-public.js';
export const recipeDecimalSchema = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/);
export const recipeIngredientSchema = z.object({
    id: z.uuid(),
    position: z.number().int().nonnegative(),
    name: z.string(),
    ingredientId: z.uuid().nullable(),
    variantId: z.uuid().nullable(),
    productId: z.uuid().nullable(),
    sourceRecipeId: z.uuid().nullable(),
    quantity: recipeDecimalSchema.nullable(),
    unit: z.string().nullable(),
    optional: z.boolean(),
});
export const recipeNutritionSchema = z.object({
    kcal: recipeDecimalSchema.nullable(),
    protein: recipeDecimalSchema.nullable(),
    fat: recipeDecimalSchema.nullable(),
    carbs: recipeDecimalSchema.nullable(),
    basis: z.enum(['recipe', 'serving']),
});
export const recipeDetailSchema = recipeSummarySchema.extend({
    method: z.string(),
    allergens: z.array(recipeAllergenSchema),
    allergensComplete: z.boolean(),
    allergenCompleteness: z.strictObject({
        complete: z.boolean(),
        unknownIngredients: z.array(recipeAllergenIngredientSchema),
    }),
    ingredients: z.array(recipeIngredientSchema),
    steps: z.array(
        z.object({
            id: z.uuid(),
            position: z.number().int().nonnegative(),
            text: z.string(),
            durationSeconds: z.number().int().nonnegative().nullable(),
            temperature: z
                .string()
                .regex(/^-?(0|[1-9]\d{0,15})(\.\d{1,8})?$/)
                .nullable(),
        }),
    ),
    nutrition: recipeNutritionSchema.nullable(),
    variants: z.array(recipeSummarySchema),
    comments: z.array(
        z.object({
            id: z.uuid(),
            body: z.string(),
            authorLogin: z.string().nullable(),
            createdAt: z.iso.datetime(),
            edited: z.boolean(),
            replyToId: z.uuid().nullable(),
        }),
    ),
    commentsTotal: z.number().int().nonnegative(),
});
export const recipesListSchema = z.object({
    items: z.array(recipeSummarySchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    recommendationMode: z.enum(['inventory-presence-v1', 'personalized-v1']),
});
export const recipeResultSchema = z.object({ recipe: recipeDetailSchema });
export const recipePersonalSchema = z.object({
    recipeId: z.uuid(),
    servings: z.number().int().min(1).max(1000),
    bookmarked: z.boolean(),
    availability: z.object({
        requiredCount: z.number().int().nonnegative(),
        presentCount: z.number().int().nonnegative(),
        presencePercent: z.number().min(0).max(100),
        canPrepare: z.boolean(),
        needsQuantityCheck: z.boolean(),
        items: z.array(
            z.object({
                id: z.uuid(),
                requiredQuantity: z
                    .string()
                    .regex(/^(0|[1-9]\d*)(\.\d{1,8})?$/)
                    .nullable(),
                availableQuantity: z
                    .string()
                    .regex(/^(0|[1-9]\d*)(\.\d{1,8})?$/)
                    .nullable(),
                unit: z.string().nullable(),
                present: z.boolean(),
                optional: z.boolean(),
                needsQuantityCheck: z.boolean(),
            }),
        ),
    }),
});
export const recipeBookmarkSchema = z.object({ bookmarked: z.boolean(), idempotencyKey: z.uuid() }).strict();
export const recipeBookmarkResultSchema = z.object({ recipeId: z.uuid(), bookmarked: z.boolean() });
export const recipesQuerySchema = z
    .object({
        q: z.string().trim().max(200).default(''),
        category: z.string().trim().max(100).optional(),
        tab: z.enum(['for-you', 'inventory', 'new']).default('for-you'),
        scope: z.enum(['private', 'family']).default('private'),
        page: z.coerce.number().int().min(1).max(10000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict();
export const recipePersonalQuerySchema = z
    .object({ servings: z.coerce.number().int().min(1).max(1000).default(1) })
    .strict();
export type RecipeIngredient = z.infer<typeof recipeIngredientSchema>;
export type RecipeDetail = z.infer<typeof recipeDetailSchema>;
export type RecipesQuery = z.infer<typeof recipesQuerySchema>;
