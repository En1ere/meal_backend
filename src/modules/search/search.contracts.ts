import { z } from 'zod';

export const searchTypeSchema = z.enum(['product', 'recipe', 'brand', 'store']);

export const searchQuerySchema = z.strictObject({
    type: searchTypeSchema,
    q: z.string().trim().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(2000).optional(),
});

export const productSearchItemSchema = z.strictObject({
    type: z.literal('product'),
    id: z.uuid(),
    name: z.string(),
    categoryCode: z.string(),
    defaultUnit: z.string(),
    status: z.enum(['approved', 'pending']),
});

export const recipeSearchItemSchema = z.strictObject({
    type: z.literal('recipe'),
    id: z.uuid(),
    title: z.string(),
    description: z.string().nullable(),
    imageUrl: z.string().nullable(),
    authorLogin: z.string().nullable(),
    category: z.string().nullable(),
    durationMinutes: z.number().int().nonnegative().nullable(),
    rating: z.number().min(1).max(5).nullable(),
    ratingCount: z.number().int().nonnegative(),
});

export const brandSearchItemSchema = z.strictObject({
    type: z.literal('brand'),
    id: z.uuid(),
    name: z.string(),
    productCount: z.number().int().nonnegative(),
});

export const storeSearchItemSchema = z.strictObject({
    type: z.literal('store'),
    id: z.uuid(),
    name: z.string(),
});

export const searchItemSchema = z.discriminatedUnion('type', [
    productSearchItemSchema,
    recipeSearchItemSchema,
    brandSearchItemSchema,
    storeSearchItemSchema,
]);

export const searchResultSchema = z.discriminatedUnion('type', [
    z.strictObject({
        type: z.literal('product'),
        items: z.array(productSearchItemSchema),
        nextCursor: z.string().nullable(),
    }),
    z.strictObject({
        type: z.literal('recipe'),
        items: z.array(recipeSearchItemSchema),
        nextCursor: z.string().nullable(),
    }),
    z.strictObject({
        type: z.literal('brand'),
        items: z.array(brandSearchItemSchema),
        nextCursor: z.string().nullable(),
    }),
    z.strictObject({
        type: z.literal('store'),
        items: z.array(storeSearchItemSchema),
        nextCursor: z.string().nullable(),
    }),
]);

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchType = z.infer<typeof searchTypeSchema>;
