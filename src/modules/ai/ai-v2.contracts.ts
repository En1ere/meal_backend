import { z } from 'zod';
import { planQuerySchema } from '../../shared/contracts/plan-query.js';
import { aiTaskTypeSchema, type AiTaskType } from './ai.contracts.js';
import { AI_TASK_POLICY_V4, aiTaskModeKey, aiTaskModeV4 } from './ai-policy-v4.js';

const shortText = z.string().trim().min(1).max(500);
const question = z.string().trim().min(3).max(500);
const boundedIdList = z.array(z.uuid()).min(1).max(20);
const recipeDecimalResultSchema = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/u);
const servingsNumber = z
    .number()
    .positive()
    .max(50)
    .refine((value) => /^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/u.test(String(value)), 'Некорректное число порций');

export const aiV2ShoppingListFromRecipesInputSchema = z
    .strictObject({ recipeIds: boundedIdList })
    .superRefine((value, context) => {
        if (new Set(value.recipeIds).size !== value.recipeIds.length)
            context.addIssue({ code: 'custom', path: ['recipeIds'], message: 'Рецепт указан дважды' });
    });

export const aiV2ReviewSummarySourceReleaseSchema = z
    .string()
    .trim()
    .max(100)
    .regex(/^recipe-publication:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:v[1-9]\d*$/iu);

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
    'storage_advice/explain': z.strictObject({ verdictId: z.uuid() }),
    'ingredient_extraction/extract': z.strictObject({ text: z.string().trim().min(3).max(8_000) }),
    'product_classification/candidates': z.strictObject({ query: shortText }),
    'product_classification/classify': z.strictObject({ shortlistId: z.uuid() }),
    'recipe_from_stock/select_existing': z.strictObject({
        inventoryScope: z.enum(['personal', 'family']),
        goal: shortText.optional(),
        maxResults: z.number().int().min(1).max(10).default(5),
    }),
    'recipe_from_stock/generate_new': z.strictObject({
        shortlistId: z.uuid(),
        servings: z.number().int().min(1).max(20).default(2),
    }),
    'personal_recommendation/weekly': z.strictObject({
        weekStartsOn: z.iso.date(),
        inventoryScope: z.enum(['personal', 'family']).default('personal'),
    }),
    'beverage_pairing/catalog': z.strictObject({ recipeId: z.uuid() }),
    'beverage_pairing/custom': z.strictObject({ shortlistId: z.uuid(), preferences: shortText.optional() }),
    'recipe_adaptation/scale': z.strictObject({
        recipeId: z.uuid(),
        revisionId: z.uuid(),
        servings: z.number().int().min(1).max(50),
    }),
    'recipe_adaptation/adapt': z.strictObject({ snapshotId: z.uuid(), instruction: question }),
    'registry_analysis/facts': z.strictObject({ query: question }),
    'registry_analysis/explain': z.strictObject({ factsId: z.uuid(), question: shortText.optional() }),
    'review_summary/public_summary': z.strictObject({
        subjectId: z.uuid(),
        sourceRelease: aiV2ReviewSummarySourceReleaseSchema,
    }),
    'shopping_list_generation/from_recipes': aiV2ShoppingListFromRecipesInputSchema,
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
        servings: servingsNumber.default(1),
    }),
    'nutrition_calculation/explain': z.strictObject({ calculationId: z.uuid(), question: shortText.optional() }),
    'portion_cost_calculation/calculate': z.strictObject({
        recipeId: z.uuid(),
        servings: servingsNumber.default(1),
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

export const aiV2StorageWarningCodeSchema = z.enum([
    'shelf_life_unknown',
    'storage_type_unknown',
    'composition_unknown',
]);

export const aiV2StorageRecoveryCodeSchema = z.enum(['check_product_label', 'use_conservative_storage']);

export const aiV2StorageExplainResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:storage_advice:explain'),
    explanation: z.string().trim().min(1).max(1_500),
    warningCodes: z.array(aiV2StorageWarningCodeSchema).min(1).max(3),
    recoveryCode: aiV2StorageRecoveryCodeSchema,
});

export const aiV2IngredientExtractionWarningCodeSchema = z.enum([
    'input_normalized',
    'candidate_truncated',
    'candidate_rejected',
    'low_confidence',
    'prompt_injection_detected',
    'url_not_allowed',
]);

export const aiV2IngredientExtractionCandidateSchema = z.strictObject({
    text: z.string().trim().min(1).max(120),
    confidence: z.enum(['high', 'medium', 'low']),
});

export const aiV2IngredientExtractionResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:ingredient_extraction:extract'),
    candidates: z.array(aiV2IngredientExtractionCandidateSchema).max(20),
    warningCodes: z.array(aiV2IngredientExtractionWarningCodeSchema).max(3),
    recoveryCode: z.enum(['review_candidates', 'provide_plain_ingredient_text']).nullable(),
});

export const aiV2ProductClassificationResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:product_classification:classify'),
    selectedCandidateId: z.uuid().nullable(),
    selectedName: z.string().trim().min(1).max(200).nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
    warningCodes: z.array(z.enum(['no_match', 'low_confidence'])).max(1),
    recoveryCode: z.enum(['review_selection', 'refine_query']),
});

export const aiV2RecipeFromStockIngredientSchema = z.strictObject({
    stockKey: z.number().int().min(1).max(40),
    name: z.string().trim().min(1).max(160),
    quantity: z.number().positive().max(1_000_000),
    unit: z.string().trim().min(1).max(20).nullable(),
});

export const aiV2RecipeFromStockResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:recipe_from_stock:generate_new'),
    title: z.string().trim().min(1).max(160),
    servings: z.number().int().min(1).max(20),
    ingredients: z.array(aiV2RecipeFromStockIngredientSchema).min(1).max(16),
    steps: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
    warningCodes: z
        .array(z.enum(['allergen_review_required', 'stock_quantity_unknown']))
        .min(1)
        .max(2),
    recoveryCode: z.literal('review_recipe'),
});

export const aiV2PersonalRecommendationReasonCodeSchema = z.enum([
    'inventory_match',
    'expiring_ingredients',
    'diet_match',
    'quick_goal',
    'high_rating',
    'new_recipe',
    'variety',
]);

export const aiV2PersonalRecommendationResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:personal_recommendation:weekly'),
    weekStartsOn: z.iso.date(),
    inventoryScope: z.enum(['personal', 'family']),
    algorithmVersion: z.literal('weekly-backend-v1'),
    items: z
        .array(
            z.strictObject({
                recipeId: z.uuid(),
                revisionId: z.uuid(),
                reasonCodes: z.array(aiV2PersonalRecommendationReasonCodeSchema).min(1).max(3),
            }),
        )
        .max(7),
    warningCodes: z.array(z.literal('allergen_profile_not_applied')).max(1),
});

export const aiV2BeveragePairingResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:beverage_pairing:custom'),
    selectedCandidateId: z.uuid().nullable(),
    selectedName: z.string().trim().min(1).max(160).nullable(),
    explanation: z.string().trim().min(1).max(800).nullable(),
    warningCodes: z.array(z.enum(['no_match', 'alcohol_mode_disabled'])).max(1),
    recoveryCode: z.enum(['review_pairing', 'refine_preferences']),
});

export const aiV2RecipeAdaptationIngredientSchema = z.strictObject({
    ingredientKey: z.number().int().min(1).max(40),
    name: z.string().trim().min(1).max(160),
    quantity: z
        .string()
        .regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/u)
        .nullable(),
    unit: z.string().trim().min(1).max(20).nullable(),
    optional: z.boolean(),
});

export const aiV2RecipeScaleResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:recipe_adaptation:scale'),
    snapshotId: z.uuid(),
    sourceRecipeId: z.uuid(),
    sourceRevisionId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    servings: z.number().int().min(1).max(50),
    ingredients: z.array(aiV2RecipeAdaptationIngredientSchema).min(1).max(40),
    steps: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
    adaptationAllowed: z.boolean(),
    warningCodes: z.array(z.enum(['allergen_evidence_incomplete', 'source_quantity_unknown'])).max(2),
});

export const aiV2RecipeAdaptationResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:recipe_adaptation:adapt'),
    sourceRecipeId: z.uuid(),
    sourceRevisionId: z.uuid(),
    title: z.string().trim().min(1).max(160),
    servings: z.number().int().min(1).max(50),
    ingredients: z.array(aiV2RecipeAdaptationIngredientSchema).min(1).max(40),
    steps: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    warningCodes: z
        .array(z.enum(['allergen_review_required', 'source_quantity_unknown']))
        .min(1)
        .max(2),
    recoveryCode: z.literal('review_recipe'),
});

export const aiV2RegistryFactKeySchema = z.enum([
    'active_batches',
    'distinct_items',
    'expired_batches',
    'expiring_7d_batches',
    'unknown_quantity_batches',
    'unknown_expiry_batches',
    'opened_batches',
]);

export const aiV2RegistryFactSchema = z.strictObject({
    key: aiV2RegistryFactKeySchema,
    value: z.number().int().nonnegative(),
    unit: z.enum(['batches', 'items']),
});

export const aiV2RegistryFactsResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:registry_analysis:facts'),
    factsId: z.uuid(),
    scope: z.literal('personal'),
    asOfDate: z.iso.date(),
    facts: z.array(aiV2RegistryFactSchema).length(7),
    warningCodes: z
        .array(z.enum(['expired_items_present', 'unknown_quantity_present', 'unknown_expiry_present']))
        .max(3),
});

export const aiV2RegistryExplainResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:registry_analysis:explain'),
    facts: z.array(aiV2RegistryFactSchema).length(7),
    explanation: z.string().trim().min(1).max(800),
    referencedFactKeys: z.array(aiV2RegistryFactKeySchema).min(1).max(7),
    warningCodes: z
        .array(z.enum(['expired_items_present', 'unknown_quantity_present', 'unknown_expiry_present']))
        .max(3),
    recoveryCode: z.literal('review_registry'),
});

export const aiV2NutritionFactKeySchema = z.enum(['energy_kcal', 'protein_g', 'fat_g', 'carbohydrate_g']);

export const aiV2NutritionValuesSchema = z.strictObject({
    energyKcal: recipeDecimalResultSchema.nullable(),
    proteinG: recipeDecimalResultSchema.nullable(),
    fatG: recipeDecimalResultSchema.nullable(),
    carbohydrateG: recipeDecimalResultSchema.nullable(),
});

export const aiV2NutritionCalculationResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:nutrition_calculation:calculate'),
    calculationId: z.uuid(),
    recipeId: z.uuid(),
    revisionId: z.uuid(),
    servings: servingsNumber,
    values: aiV2NutritionValuesSchema,
    completeness: z.enum(['complete', 'partial', 'unavailable']),
    warningCodes: z.array(z.enum(['nutrition_partially_known', 'nutrition_unavailable'])).max(1),
    recoveryCode: z.literal('review_nutrition'),
});

export const aiV2NutritionExplainResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:nutrition_calculation:explain'),
    calculationId: z.uuid(),
    values: aiV2NutritionValuesSchema,
    completeness: z.enum(['complete', 'partial']),
    explanation: z.string().trim().min(1).max(800),
    referencedFactKeys: z.array(aiV2NutritionFactKeySchema).min(1).max(4),
    warningCodes: z.array(z.literal('nutrition_partially_known')).max(1),
    recoveryCode: z.literal('review_nutrition'),
});

export const aiV2PortionCostReasonCountsSchema = z.strictObject({
    unknownIngredient: z.number().int().nonnegative(),
    unknownQuantity: z.number().int().nonnegative(),
    unknownUnit: z.number().int().nonnegative(),
    priceUnavailable: z.number().int().nonnegative(),
});

export const aiV2PortionCostCalculationResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:portion_cost_calculation:calculate'),
    calculationId: z.uuid(),
    recipeId: z.uuid(),
    revisionId: z.uuid(),
    servings: servingsNumber,
    currency: z.literal('RUB'),
    approximate: z.literal(true),
    knownLineCount: z.number().int().nonnegative(),
    totalLineCount: z.number().int().nonnegative(),
    knownSubtotalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    estimatedTotalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    reasonCounts: aiV2PortionCostReasonCountsSchema,
    completeness: z.enum(['complete', 'partial', 'unavailable']),
    warningCodes: z.array(z.enum(['prices_partially_known', 'prices_unavailable'])).max(1),
    recoveryCode: z.literal('review_cost'),
});

export const aiV2PortionCostExplainResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:portion_cost_calculation:explain'),
    calculationId: z.uuid(),
    currency: z.literal('RUB'),
    approximate: z.literal(true),
    knownLineCount: z.number().int().nonnegative(),
    totalLineCount: z.number().int().positive(),
    knownSubtotalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    estimatedTotalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    reasonCounts: aiV2PortionCostReasonCountsSchema,
    completeness: z.enum(['complete', 'partial']),
    explanation: z.string().trim().min(1).max(800),
    referencedFactKeys: z
        .array(z.enum(['coverage', 'approximation', 'missing_prices']))
        .min(1)
        .max(3),
    warningCodes: z.array(z.literal('prices_partially_known')).max(1),
    recoveryCode: z.literal('review_cost'),
});

export const aiV2ReviewSummaryFactsSchema = z.strictObject({
    averageRating: z.number().min(1).max(5).nullable(),
    ratingCount: z.number().int().nonnegative(),
    publicReviewCount: z.number().int().nonnegative(),
});

export const aiV2ReviewSummaryWarningCodeSchema = z.enum([
    'no_ratings',
    'no_public_reviews',
    'insufficient_safe_reviews',
    'reviews_sampled',
    'unsafe_reviews_excluded',
]);

export const aiV2ReviewSummaryResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:review_summary:public_summary'),
    subjectId: z.uuid(),
    sourceRelease: aiV2ReviewSummarySourceReleaseSchema,
    facts: aiV2ReviewSummaryFactsSchema,
    summary: z.string().trim().min(1).max(1_600).nullable(),
    warningCodes: z.array(aiV2ReviewSummaryWarningCodeSchema).max(5),
});

export const aiV2MealPlanSlotSchema = z.strictObject({
    slotId: z.uuid(),
    date: z.iso.date(),
    meal: z.enum(['breakfast', 'lunch', 'dinner']),
    portions: z.number().int().min(1).max(20),
    recipeId: z.uuid(),
    revisionId: z.uuid(),
    title: z.string().trim().min(1).max(200),
});

export const aiV2MealPlanGenerationResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:meal_plan_generation:generate'),
    mealPlanId: z.uuid(),
    snapshotVersion: z.literal(1),
    weekStartsOn: z.iso.date(),
    people: z.number().int().min(1).max(20),
    slots: z.array(aiV2MealPlanSlotSchema).length(21),
    warningCodes: z
        .array(z.enum(['allergen_profile_not_applied', 'nutrition_targets_not_applied', 'inventory_not_applied']))
        .length(3),
    recoveryCode: z.literal('review_meal_plan'),
});

export const aiV2MealPlanReplaceSlotResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:meal_plan_generation:replace_slot'),
    mealPlanId: z.uuid(),
    snapshotVersion: z.number().int().min(2).max(3),
    slot: aiV2MealPlanSlotSchema,
    warningCodes: z
        .array(z.enum(['allergen_profile_not_applied', 'nutrition_targets_not_applied', 'inventory_not_applied']))
        .length(3),
    recoveryCode: z.literal('review_meal_plan'),
});

export const aiV2EventMenuItemSchema = z.strictObject({
    slotId: z.uuid(),
    role: z.enum(['starter', 'salad', 'main', 'dessert']),
    portions: z.number().int().min(1).max(100),
    recipeId: z.uuid(),
    revisionId: z.uuid(),
    title: z.string().trim().min(1).max(200),
});

export const aiV2EventMenuGenerationResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:event_menu:generate'),
    eventMenuId: z.uuid(),
    snapshotVersion: z.literal(1),
    eventType: z.string().trim().min(1).max(500),
    guests: z.number().int().min(1).max(100),
    items: z.array(aiV2EventMenuItemSchema).length(4),
    warningCodes: z.union([
        z.tuple([
            z.literal('allergen_profile_not_applied'),
            z.literal('nutrition_not_calculated'),
            z.literal('shopping_not_generated'),
        ]),
        z.tuple([
            z.literal('allergen_profile_not_applied'),
            z.literal('nutrition_not_calculated'),
            z.literal('shopping_not_generated'),
            z.literal('constraints_require_review'),
        ]),
    ]),
    recoveryCode: z.literal('review_event_menu'),
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
export type AiV2StorageExplainResult = z.infer<typeof aiV2StorageExplainResultSchema>;
export type AiV2IngredientExtractionResult = z.infer<typeof aiV2IngredientExtractionResultSchema>;
export type AiV2ProductClassificationResult = z.infer<typeof aiV2ProductClassificationResultSchema>;
export type AiV2RecipeFromStockResult = z.infer<typeof aiV2RecipeFromStockResultSchema>;
export type AiV2PersonalRecommendationResult = z.infer<typeof aiV2PersonalRecommendationResultSchema>;
export type AiV2BeveragePairingResult = z.infer<typeof aiV2BeveragePairingResultSchema>;
export type AiV2RecipeAdaptationResult = z.infer<typeof aiV2RecipeAdaptationResultSchema>;
export type AiV2RecipeScaleResult = z.infer<typeof aiV2RecipeScaleResultSchema>;
export type AiV2RegistryFact = z.infer<typeof aiV2RegistryFactSchema>;
export type AiV2RegistryFactsResult = z.infer<typeof aiV2RegistryFactsResultSchema>;
export type AiV2RegistryExplainResult = z.infer<typeof aiV2RegistryExplainResultSchema>;
export type AiV2NutritionValues = z.infer<typeof aiV2NutritionValuesSchema>;
export type AiV2NutritionCalculationResult = z.infer<typeof aiV2NutritionCalculationResultSchema>;
export type AiV2NutritionExplainResult = z.infer<typeof aiV2NutritionExplainResultSchema>;
export type AiV2PortionCostReasonCounts = z.infer<typeof aiV2PortionCostReasonCountsSchema>;
export type AiV2PortionCostCalculationResult = z.infer<typeof aiV2PortionCostCalculationResultSchema>;
export type AiV2PortionCostExplainResult = z.infer<typeof aiV2PortionCostExplainResultSchema>;
export type AiV2ReviewSummaryFacts = z.infer<typeof aiV2ReviewSummaryFactsSchema>;
export type AiV2ReviewSummaryResult = z.infer<typeof aiV2ReviewSummaryResultSchema>;
export type AiV2MealPlanSlot = z.infer<typeof aiV2MealPlanSlotSchema>;
export type AiV2MealPlanGenerationResult = z.infer<typeof aiV2MealPlanGenerationResultSchema>;
export type AiV2MealPlanReplaceSlotResult = z.infer<typeof aiV2MealPlanReplaceSlotResultSchema>;
export type AiV2EventMenuItem = z.infer<typeof aiV2EventMenuItemSchema>;
export type AiV2EventMenuGenerationResult = z.infer<typeof aiV2EventMenuGenerationResultSchema>;
export type AiV2FrozenPreview = z.infer<typeof aiV2FrozenPreviewSchema>;
export type AiV2ShoppingListFromRecipesInput = z.infer<typeof aiV2ShoppingListFromRecipesInputSchema>;
export type AiV2ShoppingListFromMealPlanInput = z.infer<typeof aiV2ShoppingListFromMealPlanInputSchema>;
export type AiV2BackendOperation = z.infer<typeof aiV2BackendOperationSchema>;
