import { z } from 'zod';
import { quantitySchema } from '../inventory/inventory.contracts.js';

export const cookingQuantitySchema = z
    .string()
    .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/)
    .refine((v) => /[1-9]/.test(v), 'Количество должно быть положительным');
const key = z.uuid();
export const cookingStartSchema = z
    .object({
        recipeId: z.uuid(),
        revisionId: z.uuid(),
        servings: z.number().int().min(1).max(1000),
        idempotencyKey: key,
    })
    .strict();
export const cookingProgressSchema = z
    .object({
        version: z.number().int().positive(),
        idempotencyKey: key,
        occurredAt: z.iso.datetime(),
        status: z.enum(['active', 'paused', 'cancelled']),
        steps: z
            .array(
                z
                    .object({
                        position: z.number().int().nonnegative(),
                        status: z.enum(['pending', 'completed', 'skipped']),
                        privateNote: z.string().max(2000).nullable(),
                    })
                    .strict(),
            )
            .max(200),
        timer: z
            .object({
                position: z.number().int().nonnegative(),
                action: z.enum(['start', 'pause', 'resume', 'reset', 'adjust']),
                seconds: z.number().int().min(-86400).max(604800).optional(),
            })
            .strict()
            .nullable(),
    })
    .strict();
export const cookingFinalizeSchema = z
    .object({
        version: z.number().int().positive(),
        idempotencyKey: key,
        outcome: z.enum(['completed', 'intermediate', 'failed']),
        confirmedDuration: z.number().int().min(0).max(31536000),
        privateNote: z.string().max(2000).nullable(),
        inputs: z
            .array(
                z
                    .object({
                        batchId: z.uuid(),
                        version: z.number().int().positive(),
                        quantity: cookingQuantitySchema,
                        containerId: z.uuid().optional(),
                        containerVersion: z.number().int().positive().optional(),
                    })
                    .strict(),
            )
            .max(200),
        outputs: z
            .array(
                z
                    .object({
                        name: z.string().trim().min(1).max(200),
                        quantity: cookingQuantitySchema,
                        unit: z.string().min(1).max(30),
                        locationId: z.uuid(),
                        expiryOn: z.iso.date().nullable(),
                        precision: z.enum(['exact', 'estimated']),
                        portionQuantity: cookingQuantitySchema.nullable(),
                    })
                    .strict(),
            )
            .max(50),
    })
    .strict()
    .superRefine((v, ctx) => {
        if (new Set(v.inputs.map((i) => `${i.batchId}:${i.containerId ?? ''}`)).size !== v.inputs.length)
            ctx.addIssue({ code: 'custom', path: ['inputs'], message: 'Партия указана дважды' });
        if (v.outcome === 'failed' ? v.outputs.length > 0 : v.outputs.length === 0)
            ctx.addIssue({ code: 'custom', path: ['outputs'], message: 'Проверьте выход приготовления' });
    });
export const cookingStepSchema = z.object({
    position: z.number().int(),
    text: z.string(),
    durationSeconds: z.number().int().nullable(),
    status: z.enum(['pending', 'completed', 'skipped']),
    privateNote: z.string().nullable(),
    timerDeadline: z.iso.datetime().nullable(),
    timerPausedSeconds: z.number().int().nonnegative().nullable(),
});
export const cookingAttemptSchema = z.object({
    id: z.uuid(),
    recipeId: z.uuid(),
    revisionId: z.uuid(),
    title: z.string(),
    servings: z.number().int().positive(),
    status: z.enum(['active', 'paused', 'cancelled', 'completed', 'intermediate', 'failed', 'archived']),
    archivedAt: z.iso.datetime().nullable().default(null),
    hideAfter: z.iso.datetime().nullable().default(null),
    version: z.number().int().positive(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    confirmedDuration: z.number().int().nullable(),
    privateNote: z.string().nullable(),
    steps: z.array(cookingStepSchema),
    outputBatchIds: z.array(z.uuid()),
});
export const cookingListQuerySchema = z
    .object({ view: z.enum(['current', 'archive', 'all']).default('current') })
    .strict();
export const cookingReminderSchema = z.object({
    id: z.uuid(),
    attemptId: z.uuid(),
    sequence: z.union([z.literal(1), z.literal(2)]),
    availableAt: z.iso.datetime(),
});
export const cookingListSchema = z.object({
    items: z.array(cookingAttemptSchema),
    reminders: z.array(cookingReminderSchema).default([]),
});
export const cookingReminderPreferencesSchema = z.object({
    enabled: z.boolean(),
    timezone: z.string().nullable(),
    quietHours: z.object({ start: z.literal('22:00'), end: z.literal('09:00') }),
});
export const cookingReminderPreferencesChangeSchema = z
    .object({
        enabled: z.boolean(),
        timezone: z
            .string()
            .min(1)
            .max(100)
            .regex(/^(?![+-])/, 'Укажите именованный часовой пояс IANA')
            .refine((value) => {
                try {
                    new Intl.DateTimeFormat('en', { timeZone: value });
                    return true;
                } catch {
                    return false;
                }
            }, 'Неизвестный часовой пояс')
            .optional(),
        idempotencyKey: z.uuid(),
    })
    .strict();
export const cookingStockOptionsSchema = z.object({
    items: z.array(
        z.object({
            id: z.uuid(),
            name: z.string(),
            kind: z.enum(['ingredient', 'prepared', 'preserve']),
            quantity: z.string().nullable(),
            unit: z.string().nullable(),
            version: z.number().int().positive(),
            locationId: z.uuid().nullable(),
            ingredientId: z.uuid().nullable(),
            sourceRecipeId: z.uuid().nullable(),
            preserveId: z.uuid().nullable().default(null),
            containers: z
                .array(
                    z.object({
                        id: z.uuid(),
                        label: z.string(),
                        quantity: quantitySchema.nullable(),
                        version: z.number().int().positive(),
                    }),
                )
                .default([]),
        }),
    ),
});
export type CookingAttempt = z.input<typeof cookingAttemptSchema>;
export const cookingStatisticsSchema = z.object({
    recipeId: z.uuid(),
    revisionId: z.uuid(),
    servings: z.number().int().positive(),
    sampleSize: z.number().int().nonnegative(),
    medianSeconds: z.number().nonnegative().nullable(),
    lowerQuartileSeconds: z.number().nonnegative().nullable(),
    upperQuartileSeconds: z.number().nonnegative().nullable(),
    outlierPolicy: z.literal('pending-calibration'),
});
