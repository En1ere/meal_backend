import { z } from 'zod';

// Fields unavailable from a reviewed source stay null; absence is never a fake zero.
export const publicProfileSchema = z.strictObject({
    username: z.string(),
    avatarUrl: z.string().nullable(),
    recipeCount: z.number().int().nonnegative().nullable(),
    reputationLabel: z.string().nullable(),
    achievements: z.array(z.strictObject({ id: z.string(), name: z.string() })).nullable(),
});
export const ownProfileSchema = z.strictObject({
    id: z.uuid(),
    username: z.string(),
    displayName: z.string().nullable(),
    email: z.string().nullable(),
    emailVerified: z.boolean(),
    timezone: z.string().nullable(),
    locale: z.string().nullable(),
    theme: z.string().nullable(),
    version: z.number().int().positive(),
    public: publicProfileSchema,
});
export const updateOwnProfileSchema = z.strictObject({
    displayName: z.string().trim().min(1).max(100),
    timezone: z.string().trim().min(1).max(100),
    locale: z.enum(['ru']),
    theme: z.string().trim().min(1).max(64).nullable(),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export function publicProjection(
    username: string,
    recipeCount: number | null = null,
): z.infer<typeof publicProfileSchema> {
    return { username, avatarUrl: null, recipeCount, reputationLabel: null, achievements: null };
}
