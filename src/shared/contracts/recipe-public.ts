import { z } from 'zod';

export const recipeAvailabilitySummarySchema = z.object({
    requiredCount: z.number().int().nonnegative(),
    presentCount: z.number().int().nonnegative(),
    presencePercent: z.number().min(0).max(100),
    canPrepare: z.boolean(),
    needsQuantityCheck: z.boolean(),
});

export const recipeSummarySchema = z.object({
    description: z.string().nullable(),
    imageUrl: z.string().nullable(),
    tags: z.array(z.string()),
    availability: recipeAvailabilitySummarySchema.nullable(),
    id: z.uuid(),
    revisionId: z.uuid(),
    title: z.string(),
    authorLogin: z.string().nullable(),
    category: z.string().nullable(),
    baseServings: z.number().int().positive(),
    durationMinutes: z.number().int().nonnegative().nullable(),
    rating: z.number().min(1).max(5).nullable(),
    ratingCount: z.number().int().nonnegative(),
    publishedAt: z.iso.datetime(),
});

export type RecipeSummary = z.infer<typeof recipeSummarySchema>;

export function publicRecipeImage(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    if (/^\/(?:recipes|assets)\/[A-Za-z0-9/_\.\-]+$/.test(value) && !value.includes('..')) return value;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}
