import { z } from 'zod';
import { planQuerySchema } from '../../shared/contracts/plan-query.js';
import { aiTaskTypeSchema, type AiTaskType } from './ai.contracts.js';
import { AI_TASK_POLICY_V4, aiTaskModeKey, aiTaskModeV4 } from './ai-policy-v4.js';

const shortText = z.string().trim().min(1).max(500);
const question = z.string().trim().min(3).max(500);
const boundedIdList = z.array(z.uuid()).min(1).max(20);

export const aiV2ShoppingListFromMealPlanInputSchema = z.strictObject({
    mealPlanId: z.uuid(),
    version: z.number().int().positive(),
    selection: planQuerySchema,
});

const inputSchemas = {
    'culinary_question/answer': z.strictObject({ question }),
    'substitution/candidates': z.strictObject({ ingredient: shortText, recipeId: z.uuid().optional() }),
    'substitution/explain': z.strictObject({ candidateId: z.uuid(), question: shortText.optional() }),
    'storage_advice/rule': z.strictObject({ productId: z.uuid() }),
    'storage_advice/explain': z.strictObject({ productId: z.uuid(), verdictId: z.uuid() }),
    'ingredient_extraction/extract': z.strictObject({ text: z.string().trim().min(3).max(8_000) }),
    'product_classification/candidates': z.strictObject({ query: shortText }),
    'product_classification/classify': z.strictObject({ query: shortText }),
    'recipe_from_stock/select_existing': z.strictObject({
        inventoryScope: z.enum(['personal', 'family']),
        maxResults: z.number().int().min(1).max(10).default(5),
    }),
    'recipe_from_stock/generate_new': z.strictObject({
        inventoryScope: z.enum(['personal', 'family']),
        servings: z.number().int().min(1).max(20).optional(),
        goal: shortText.optional(),
    }),
    'personal_recommendation/weekly': z.strictObject({ weekStartsOn: z.iso.date() }),
    'beverage_pairing/catalog': z.strictObject({ recipeId: z.uuid() }),
    'beverage_pairing/custom': z.strictObject({ recipeId: z.uuid(), preferences: shortText.optional() }),
    'recipe_adaptation/scale': z.strictObject({
        recipeId: z.uuid(),
        servings: z.number().int().min(1).max(50),
    }),
    'recipe_adaptation/adapt': z.strictObject({ recipeId: z.uuid(), instruction: question }),
    'registry_analysis/facts': z.strictObject({ query: question }),
    'registry_analysis/explain': z.strictObject({ factsId: z.uuid(), question: shortText.optional() }),
    'review_summary/public_summary': z.strictObject({
        subjectId: z.uuid(),
        sourceRelease: z.string().trim().min(1).max(100),
    }),
    'shopping_list_generation/from_recipes': z.strictObject({ recipeIds: boundedIdList }),
    'shopping_list_generation/from_meal_plan': aiV2ShoppingListFromMealPlanInputSchema,
    'meal_plan_generation/generate': z.strictObject({
        weekStartsOn: z.iso.date(),
        people: z.number().int().min(1).max(20),
        goal: shortText.optional(),
    }),
    'meal_plan_generation/replace_slot': z.strictObject({
        mealPlanId: z.uuid(),
        slotId: z.uuid(),
        reason: shortText.optional(),
    }),
    'event_menu/generate': z.strictObject({
        eventType: shortText,
        guests: z.number().int().min(1).max(100),
        constraints: shortText.optional(),
    }),
    'nutrition_calculation/calculate': z.strictObject({
        recipeId: z.uuid(),
        servings: z.number().positive().max(50).default(1),
    }),
    'nutrition_calculation/explain': z.strictObject({ calculationId: z.uuid(), question: shortText.optional() }),
    'portion_cost_calculation/calculate': z.strictObject({
        recipeId: z.uuid(),
        servings: z.number().positive().max(50).default(1),
        currency: z.literal('RUB').default('RUB'),
    }),
    'portion_cost_calculation/explain': z.strictObject({ calculationId: z.uuid(), question: shortText.optional() }),
} as const;

export const aiV2InputSchemas = inputSchemas;
export type AiV2ExecutableTaskModeKey = keyof typeof aiV2InputSchemas;

export const aiV2ContextSelectionSchema = z.strictObject({
    sourceIds: z.array(z.uuid()).max(16),
});

const aiV2PreviewRequestEnvelopeSchema = z.strictObject({
    task: aiTaskTypeSchema,
    mode: z.string().trim().min(1).max(50),
    input: z.unknown(),
    context: aiV2ContextSelectionSchema.optional(),
});

export type AiV2PreviewRequest = {
    task: AiTaskType;
    mode: string;
    input: Record<string, unknown>;
    context?: z.infer<typeof aiV2ContextSelectionSchema>;
};

export function parseAiV2PreviewRequest(value: unknown): AiV2PreviewRequest {
    const envelope = aiV2PreviewRequestEnvelopeSchema.parse(value);
    const definition = aiTaskModeV4(envelope.task, envelope.mode);
    if (definition === undefined || definition.route === 'disabled') {
        throw new Error(`AI task/mode is not executable: ${aiTaskModeKey(envelope.task, envelope.mode)}`);
    }

    const key = aiTaskModeKey(envelope.task, envelope.mode) as AiV2ExecutableTaskModeKey;
    const schema = aiV2InputSchemas[key];
    if (schema === undefined) throw new Error(`AI input schema is missing: ${key}`);

    const parsed = schema.parse(envelope.input) as Record<string, unknown>;
    return envelope.context === undefined
        ? { task: envelope.task, mode: envelope.mode, input: parsed }
        : { task: envelope.task, mode: envelope.mode, input: parsed, context: envelope.context };
}

export const aiV2PreviewSourceSchema = z.strictObject({
    id: z.uuid(),
    label: z.string().trim().min(1).max(120),
    itemCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
});

export const aiV2PreviewSchema = z.strictObject({
    id: z.uuid(),
    task: aiTaskTypeSchema,
    mode: z.string().trim().min(1).max(50),
    route: z.enum(['backend', 'economy', 'balanced']),
    cost: z.number().int().min(0).max(4),
    sources: z.array(aiV2PreviewSourceSchema).max(16),
    expiresAt: z.iso.datetime(),
    policyVersion: z.literal(AI_TASK_POLICY_V4),
});

export const aiV2RunRequestSchema = z.strictObject({
    previewId: z.uuid(),
    idempotencyKey: z.uuid(),
});

export const aiV2WarningCodeSchema = z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_]+$/u);

export const aiV2ResultEnvelopeSchema = z.strictObject({
    schemaVersion: z.string().trim().min(1).max(160),
    data: z.record(z.string(), z.unknown()),
    warningCodes: z.array(aiV2WarningCodeSchema).max(20),
});

export const aiV2CulinaryWarningCodeSchema = z.enum([
    'medical_boundary',
    'allergen_boundary',
    'food_safety_boundary',
    'prompt_injection_detected',
]);

export const aiV2CulinaryRecoveryCodeSchema = z.enum([
    'ask_general_cooking_question',
    'check_product_label',
    'follow_official_food_safety_guidance',
    'contact_healthcare_professional',
]);

export const aiV2CulinaryAnswerResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:culinary_question:answer'),
    answer: z.string().trim().min(1).max(2_000),
    warningCodes: z.array(aiV2CulinaryWarningCodeSchema).max(2),
    recoveryCode: aiV2CulinaryRecoveryCodeSchema.nullable(),
});

export const aiV2SubstitutionWarningCodeSchema = z.enum([
    'allergen_status_unknown',
    'medical_boundary',
    'allergen_boundary',
    'prompt_injection_detected',
]);

export const aiV2SubstitutionRecoveryCodeSchema = z.enum([
    'check_product_label',
    'contact_healthcare_professional',
    'ask_substitution_question',
]);

export const aiV2SubstitutionExplainResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:substitution:explain'),
    explanation: z.string().trim().min(1).max(1_800),
    warningCodes: z.array(aiV2SubstitutionWarningCodeSchema).max(2),
    recoveryCode: aiV2SubstitutionRecoveryCodeSchema.nullable(),
});

export const aiV2BackendOperationSchema = z.strictObject({
    item: z.strictObject({
        id: z.uuid(),
        taskId: z.uuid(),
        task: aiTaskTypeSchema,
        mode: z.string().trim().min(1).max(50),
        state: z.literal('succeeded'),
        financialState: z.literal('none'),
        providerCostState: z.literal('none'),
        result: aiV2ResultEnvelopeSchema,
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        version: z.number().int().positive(),
    }),
});

export const aiV2FrozenPreviewSchema = z.strictObject({
    contractVersion: z.literal(2),
    task: aiTaskTypeSchema,
    mode: z.string().trim().min(1).max(50),
    route: z.enum(['backend', 'economy', 'balanced']),
    cost: z.number().int().min(0).max(4),
    input: z.record(z.string(), z.unknown()),
    sourceIds: z.array(z.uuid()).max(16),
    taskPolicyVersion: z.literal('ai-task-policy-v4'),
    contextPolicyVersion: z.literal('ai-context-policy-v2'),
    routingPolicyVersion: z.literal('ai-routing-policy-v1'),
    pricePolicyVersion: z.literal('ai-price-policy-v1'),
    resultSchemaVersion: z.string().startsWith('ai-result-contract-v2:'),
    safetyPolicyVersion: z.literal('ai-safety-policy-v1'),
    cachePolicyVersion: z.literal('ai-cache-policy-v1'),
    providerProfileVersion: z.string().min(1).nullable(),
    providerCostCeilingMinor: z.number().int().min(0).max(1_200),
    sourceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
    expiresAt: z.iso.datetime(),
});

export type AiV2Preview = z.infer<typeof aiV2PreviewSchema>;
export type AiV2RunRequest = z.infer<typeof aiV2RunRequestSchema>;
export type AiV2ResultEnvelope = z.infer<typeof aiV2ResultEnvelopeSchema>;
export type AiV2CulinaryAnswerResult = z.infer<typeof aiV2CulinaryAnswerResultSchema>;
export type AiV2SubstitutionExplainResult = z.infer<typeof aiV2SubstitutionExplainResultSchema>;
export type AiV2FrozenPreview = z.infer<typeof aiV2FrozenPreviewSchema>;
export type AiV2ShoppingListFromMealPlanInput = z.infer<typeof aiV2ShoppingListFromMealPlanInputSchema>;
export type AiV2BackendOperation = z.infer<typeof aiV2BackendOperationSchema>;
