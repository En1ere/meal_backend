import { z } from 'zod';

export const recipePolicySchema = z.strictObject({
    version: z.number().int().positive(),
    submissionDailyLimit: z.number().int().min(1).max(10000),
    commentHourlyLimit: z.number().int().min(1).max(10000),
    reportDailyLimit: z.number().int().min(1).max(10000),
});
export const recipePolicyChangeSchema = recipePolicySchema.omit({ version: true }).extend({
    expectedVersion: z.number().int().positive(),
});
export type RecipePolicy = z.infer<typeof recipePolicySchema>;
export const defaultRecipePolicy: RecipePolicy = {
    version: 1,
    submissionDailyLimit: 10,
    commentHourlyLimit: 30,
    reportDailyLimit: 10,
};
export type RecipeAction = 'submission' | 'comment' | 'report';
export function recipeAllowance(policy: RecipePolicy, kind: RecipeAction) {
    return {
        limit:
            kind === 'submission'
                ? policy.submissionDailyLimit
                : kind === 'comment'
                  ? policy.commentHourlyLimit
                  : policy.reportDailyLimit,
        windowSeconds: kind === 'comment' ? 3600 : 86400,
    };
}
