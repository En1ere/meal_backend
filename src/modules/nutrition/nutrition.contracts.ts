import { z } from 'zod';
import { quantitySchema } from '../inventory/inventory.contracts.js';
import { proAccessSchema } from '../pro-overview/pro-overview.contracts.js';
import { diaryCompletenessSchema, diaryNutrientsSchema } from '../diary/diary.contracts.js';

export const nutritionGoalSchema = z.enum(['maintain', 'lose_weight', 'gain_weight', 'custom']);
export const nutritionTargetValuesSchema = diaryNutrientsSchema;

export const nutritionProfileUpdateSchema = z.strictObject({
    goal: nutritionGoalSchema,
    expectedVersion: z.number().int().positive().nullable(),
    idempotencyKey: z.uuid(),
});

export const nutritionTargetCreateSchema = z
    .strictObject({
        effectiveFrom: z.iso.date(),
        energyKcal: quantitySchema.nullable(),
        proteinG: quantitySchema.nullable(),
        fatG: quantitySchema.nullable(),
        carbohydrateG: quantitySchema.nullable(),
        fiberG: quantitySchema.nullable(),
        expectedProfileVersion: z.number().int().positive(),
        idempotencyKey: z.uuid(),
    })
    .refine(
        (value) =>
            [value.energyKcal, value.proteinG, value.fatG, value.carbohydrateG, value.fiberG].some(
                (target) => target !== null && Number(target) > 0,
            ),
        'At least one positive target is required',
    );

export const nutritionTargetSchema = z.strictObject({
    id: z.uuid(),
    effectiveFrom: z.iso.date(),
    effectiveTo: z.iso.date().nullable(),
    values: nutritionTargetValuesSchema,
    source: z.literal('manual'),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
});

export const nutritionProfileSchema = z.strictObject({
    id: z.uuid(),
    goal: nutritionGoalSchema.nullable(),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
});

export const nutritionSettingsSchema = z.strictObject({
    access: proAccessSchema,
    profile: nutritionProfileSchema.nullable(),
    currentTarget: nutritionTargetSchema.nullable(),
    targetHistory: z.array(nutritionTargetSchema),
    policy: z.strictObject({
        mode: z.literal('manual_only'),
        medicalAdvice: z.literal(false),
        automaticTargetsAvailable: z.literal(false),
    }),
});

export const nutritionProgressSchema = z.strictObject({
    energyKcal: z.number().min(0).nullable(),
    proteinG: z.number().min(0).nullable(),
    fatG: z.number().min(0).nullable(),
    carbohydrateG: z.number().min(0).nullable(),
    fiberG: z.number().min(0).nullable(),
});

export const nutritionAnalyticsDaySchema = z.strictObject({
    date: z.iso.date(),
    entryCount: z.number().int().nonnegative(),
    nutrition: diaryNutrientsSchema,
    completeness: diaryCompletenessSchema,
    target: nutritionTargetSchema.nullable(),
    progressPercent: nutritionProgressSchema,
});

export const nutritionAnalyticsSchema = z.strictObject({
    access: proAccessSchema,
    period: z.strictObject({ from: z.iso.date(), to: z.iso.date(), dataThrough: z.iso.date() }),
    days: z.array(nutritionAnalyticsDaySchema),
    summary: z.strictObject({
        entryCount: z.number().int().nonnegative(),
        daysWithEntries: z.number().int().nonnegative(),
        completeDays: z.number().int().nonnegative(),
        partialDays: z.number().int().nonnegative(),
        unknownDays: z.number().int().nonnegative(),
    }),
    disclaimer: z.literal('informational_not_medical'),
});

export type NutritionProfileUpdate = z.infer<typeof nutritionProfileUpdateSchema>;
export type NutritionTargetCreate = z.infer<typeof nutritionTargetCreateSchema>;
export type NutritionTarget = z.infer<typeof nutritionTargetSchema>;
export type NutritionSettings = z.infer<typeof nutritionSettingsSchema>;
export type NutritionAnalytics = z.infer<typeof nutritionAnalyticsSchema>;
