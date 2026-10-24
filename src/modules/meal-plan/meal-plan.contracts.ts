import { z } from 'zod';
import { quantitySchema } from '../inventory/inventory.contracts.js';

export const planViewSchema = z.enum(['day', 'week', 'range', 'calendar']);
export const planDateSchema = z.iso.date();
export const planTimezoneSchema = z
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
    }, 'Неизвестный часовой пояс');
export const planQuerySchema = z
    .object({
        scope: z.enum(['private', 'family']).default('private'),
        view: planViewSchema.default('week'),
        date: planDateSchema,
        endDate: planDateSchema.optional(),
        timezone: planTimezoneSchema,
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.view === 'range' && !value.endDate)
            ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Укажите конец периода' });
        if (value.endDate && value.endDate < value.date)
            ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Конец периода раньше начала' });
        if (value.endDate) {
            const days = Math.round(
                (Date.parse(`${value.endDate}T00:00:00Z`) - Date.parse(`${value.date}T00:00:00Z`)) / 86400000,
            );
            if (days > 366)
                ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Период не может быть больше года' });
        }
    });
export const mealSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);
export const slotStateSchema = z.enum(['recipe', 'outside', 'later', 'unplanned']);
const upsertMutationSchema = z
    .object({
        action: z.literal('upsert'),
        entryId: z.uuid().nullable(),
        date: planDateSchema,
        meal: mealSchema,
        portions: z.number().int().min(1).max(1000),
        locked: z.boolean(),
        slotState: slotStateSchema,
        recipeId: z.uuid().nullable(),
        revisionId: z.uuid().nullable(),
        note: z.string().trim().max(1000).nullable(),
        assignments: z
            .array(z.strictObject({ userId: z.uuid(), portions: z.number().int().min(1).max(1000) }))
            .max(100)
            .optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.slotState === 'recipe' && (!value.recipeId || !value.revisionId))
            ctx.addIssue({ code: 'custom', path: ['recipeId'], message: 'Выберите рецепт' });
        if (value.slotState !== 'recipe' && (value.recipeId || value.revisionId))
            ctx.addIssue({ code: 'custom', path: ['recipeId'], message: 'Рецепт допустим только для блюда' });
        const recipients = value.assignments?.map((item) => item.userId) ?? [];
        if (new Set(recipients).size !== recipients.length)
            ctx.addIssue({ code: 'custom', path: ['assignments'], message: 'Участник указан дважды' });
        if ((value.assignments?.reduce((sum, item) => sum + item.portions, 0) ?? 0) > value.portions)
            ctx.addIssue({
                code: 'custom',
                path: ['assignments'],
                message: 'Распределено больше порций, чем запланировано',
            });
    });
const removeMutationSchema = z.object({ action: z.literal('remove'), entryId: z.uuid() }).strict();
export const planMutationSchema = z.discriminatedUnion('action', [upsertMutationSchema, removeMutationSchema]);
export const planChangePreviewSchema = z
    .object({
        version: z.number().int().nonnegative(),
        selection: planQuerySchema,
        mutation: planMutationSchema,
    })
    .strict();
export const planChangeCommitSchema = planChangePreviewSchema.extend({
    previewToken: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.uuid(),
});
export const planShoppingPreviewRequestSchema = z
    .object({ version: z.number().int().positive(), selection: planQuerySchema })
    .strict();
export const planShoppingCommitSchema = planShoppingPreviewRequestSchema.extend({
    previewToken: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().trim().min(1).max(200),
    idempotencyKey: z.uuid(),
});

export const planEntrySchema = z.strictObject({
    id: z.uuid(),
    date: planDateSchema,
    meal: mealSchema,
    portions: z.number().int().positive(),
    locked: z.boolean(),
    slotState: slotStateSchema,
    note: z.string().nullable(),
    recipe: z.strictObject({ id: z.uuid(), revisionId: z.uuid(), title: z.string() }).nullable(),
    assignments: z.array(
        z.strictObject({ userId: z.uuid(), displayName: z.string(), portions: z.number().int().positive() }),
    ),
    version: z.number().int().positive(),
});
export const planSchema = z.strictObject({
    scope: z.enum(['private', 'family']),
    id: z.uuid().nullable(),
    version: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    timezone: planTimezoneSchema,
    startsOn: planDateSchema,
    endsOn: planDateSchema,
    view: planViewSchema,
    selectedDate: planDateSchema,
    entries: z.array(planEntrySchema),
});
export const planImpactItemSchema = z.strictObject({
    entryRef: z.string(),
    ingredientId: z.uuid().nullable(),
    name: z.string(),
    requiredQuantity: quantitySchema.nullable(),
    reservedQuantity: quantitySchema.nullable(),
    missingQuantity: quantitySchema.nullable(),
    unit: z.string().nullable(),
    needsQuantityCheck: z.boolean(),
});
export const planImpactSchema = z.strictObject({
    items: z.array(planImpactItemSchema),
    estimatedPriceMinor: z.number().int().nonnegative().nullable(),
    priceComplete: z.boolean(),
});
export const planChangePreviewResultSchema = z.strictObject({
    previewToken: z.string(),
    expiresAt: z.iso.datetime(),
    proposedEntry: planEntrySchema.nullable(),
    impact: planImpactSchema,
});
export const planShoppingItemSchema = z.strictObject({
    ingredientId: z.uuid().nullable(),
    name: z.string(),
    quantity: quantitySchema.nullable(),
    unit: z.string().nullable(),
    needsQuantityCheck: z.boolean(),
    entryIds: z.array(z.uuid()),
});
export const planShoppingPreviewResultSchema = z.strictObject({
    previewToken: z.string(),
    expiresAt: z.iso.datetime(),
    items: z.array(planShoppingItemSchema),
    estimatedPriceMinor: z.number().int().nonnegative().nullable(),
    priceComplete: z.boolean(),
});
export const planShoppingCommitResultSchema = z.strictObject({ listId: z.uuid() });

export const planOptimizationPrioritySchema = z.enum(['expiry', 'nutrition', 'budget']);
export const planOptimizationCandidateSchema = z.strictObject({ recipeId: z.uuid(), revisionId: z.uuid() });
export const planOptimizationSettingsSchema = z
    .strictObject({
        priorities: z.array(planOptimizationPrioritySchema).min(1).max(3),
        maxBudgetMinor: z.number().int().positive().nullable(),
        targetMealSharePercent: z.number().int().min(10).max(100),
    })
    .superRefine((value, ctx) => {
        if (new Set(value.priorities).size !== value.priorities.length)
            ctx.addIssue({ code: 'custom', path: ['priorities'], message: 'Приоритет указан дважды' });
        if (value.priorities.includes('budget') && value.maxBudgetMinor === null)
            ctx.addIssue({ code: 'custom', path: ['maxBudgetMinor'], message: 'Укажите бюджет одного приготовления' });
    });

export const planAutomationRuleSchema = z
    .strictObject({
        recipeId: z.uuid(),
        revisionId: z.uuid(),
        meal: mealSchema,
        weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        portions: z.number().int().min(1).max(1000),
        assignments: z
            .array(z.strictObject({ userId: z.uuid(), portions: z.number().int().min(1).max(1000) }))
            .max(100)
            .optional(),
        alternatives: z.array(planOptimizationCandidateSchema).max(9).optional(),
        optimization: planOptimizationSettingsSchema.optional(),
        conflictPolicy: z.literal('skip-existing'),
    })
    .superRefine((value, ctx) => {
        if (new Set(value.weekdays).size !== value.weekdays.length)
            ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'День недели указан дважды' });
        const recipients = value.assignments?.map((item) => item.userId) ?? [];
        if (new Set(recipients).size !== recipients.length)
            ctx.addIssue({ code: 'custom', path: ['assignments'], message: 'Участник указан дважды' });
        if ((value.assignments?.reduce((sum, item) => sum + item.portions, 0) ?? 0) > value.portions)
            ctx.addIssue({ code: 'custom', path: ['assignments'], message: 'Распределено больше доступных порций' });
        const candidates = [
            `${value.recipeId}:${value.revisionId}`,
            ...(value.alternatives ?? []).map((item) => `${item.recipeId}:${item.revisionId}`),
        ];
        if (new Set(candidates).size !== candidates.length)
            ctx.addIssue({ code: 'custom', path: ['alternatives'], message: 'Рецепт указан дважды' });
        if (value.optimization && !value.alternatives?.length)
            ctx.addIssue({
                code: 'custom',
                path: ['alternatives'],
                message: 'Для оптимизации нужен минимум два рецепта',
            });
    });
export const planAutomationPreviewSchema = z
    .strictObject({
        version: z.number().int().nonnegative(),
        selection: planQuerySchema,
        rule: planAutomationRuleSchema,
    })
    .superRefine((value, ctx) => {
        if (value.selection.view !== 'range')
            ctx.addIssue({ code: 'custom', path: ['selection', 'view'], message: 'Автоматизация требует периода' });
    });
export const planAutomationCommitSchema = planAutomationPreviewSchema.extend({
    previewToken: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.uuid(),
});
export const planAutomationConflictSchema = z.strictObject({
    date: planDateSchema,
    meal: mealSchema,
    existingEntryId: z.uuid(),
    locked: z.boolean(),
});
export const planAutomationPreviewResultSchema = z.strictObject({
    previewToken: z.string(),
    expiresAt: z.iso.datetime(),
    occurrences: z.number().int().nonnegative(),
    proposedEntries: z.array(planEntrySchema).max(366),
    conflicts: z.array(planAutomationConflictSchema).max(366),
    impact: planImpactSchema,
    optimization: z
        .strictObject({
            mode: z.literal('deterministic-v1'),
            priorities: z.array(planOptimizationPrioritySchema),
            candidates: z.array(
                z.strictObject({
                    recipeId: z.uuid(),
                    revisionId: z.uuid(),
                    title: z.string(),
                    rank: z.number().int().positive(),
                    estimatedPriceMinor: z.number().int().nonnegative().nullable(),
                    priceComplete: z.boolean(),
                    nutritionCompletenessPercent: z.number().min(0).max(100),
                    nutritionTargetDeviationPercent: z.number().min(0).nullable(),
                    expiringIngredientCount: z.number().int().nonnegative(),
                }),
            ),
            warnings: z.array(z.enum(['missing_prices', 'missing_nutrition', 'missing_nutrition_target'])),
        })
        .nullable(),
});

export const portionScopeQuerySchema = z.strictObject({ scope: z.enum(['private', 'family']).default('family') });
export const preparedPortionSourceSchema = z.strictObject({
    batchId: z.uuid(),
    outputId: z.uuid(),
    attemptId: z.uuid(),
    name: z.string(),
    quantity: quantitySchema.nullable(),
    unit: z.string(),
    version: z.number().int().positive(),
});
export const portionProposalSchema = z.strictObject({
    id: z.uuid(),
    recipient: z.strictObject({ userId: z.uuid(), displayName: z.string() }),
    source: z.strictObject({ batchId: z.uuid(), name: z.string() }),
    quantity: quantitySchema,
    unit: z.string(),
    state: z.enum(['pending', 'confirmed', 'auto_confirmed', 'refused', 'cancelled']),
    availableAt: z.iso.datetime(),
    dueAt: z.iso.datetime(),
    decisionAt: z.iso.datetime().nullable(),
    version: z.number().int().positive(),
});
export const portionWorkspaceSchema = z.strictObject({
    scope: z.enum(['private', 'family']),
    prepared: z.array(preparedPortionSourceSchema),
    proposals: z.array(portionProposalSchema),
});
export const portionAssignSchema = z.strictObject({
    scope: z.enum(['private', 'family']).default('family'),
    batchId: z.uuid(),
    recipientUserId: z.uuid(),
    quantity: quantitySchema,
    expectedBatchVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const portionDecisionSchema = z.strictObject({
    scope: z.enum(['private', 'family']).default('family'),
    decision: z.enum(['confirmed', 'refused', 'cancelled']),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});

export type PlanQuery = z.infer<typeof planQuerySchema>;
export type PlanMutation = z.infer<typeof planMutationSchema>;
export type PlanEntry = z.infer<typeof planEntrySchema>;
