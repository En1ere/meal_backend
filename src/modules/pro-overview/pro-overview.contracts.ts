import { z } from 'zod';
import { aiBalanceSchema } from '../ai/ai.contracts.js';

export const proMissingFieldSchema = z.enum([
    'nutrition_profile',
    'goal',
    'energy_kcal',
    'protein_g',
    'fat_g',
    'carbohydrate_g',
    'fiber_g',
]);

export const proAccessSchema = z.strictObject({
    mode: z.enum(['active', 'read_only']),
    reason: z.literal('pro_expired').nullable(),
    source: z.enum(['personal', 'family', 'trial', 'gift', 'history']),
    periodEndsAt: z.iso.datetime().nullable(),
});

export const proOverviewSchema = z.strictObject({
    access: proAccessSchema,
    goal: z.enum(['maintain', 'lose_weight', 'gain_weight', 'custom']).nullable(),
    targets: z
        .strictObject({
            effectiveFrom: z.iso.date(),
            effectiveTo: z.iso.date().nullable(),
            energyKcal: z.string().nullable(),
            proteinG: z.string().nullable(),
            fatG: z.string().nullable(),
            carbohydrateG: z.string().nullable(),
            fiberG: z.string().nullable(),
        })
        .nullable(),
    missingFields: z.array(proMissingFieldSchema),
    diaryCount: z.number().int().nonnegative(),
    expenseCount: z.number().int().nonnegative(),
    ai: aiBalanceSchema,
});

export type ProOverview = z.infer<typeof proOverviewSchema>;
export type ProAccess = z.infer<typeof proAccessSchema>;
export type ProMissingField = z.infer<typeof proMissingFieldSchema>;
