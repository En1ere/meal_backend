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
