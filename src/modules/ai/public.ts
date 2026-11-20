export { AiController } from './ai.http.js';
export {
    AiProvider,
    AiProviderError,
    aiProviderResultSchema,
    type AiProviderFailureDisposition,
} from './ai-provider.js';
export { AiReconciliationService } from './ai-reconciliation.service.js';
export { AiContentRetentionService } from './ai-content-retention.service.js';
export { readAiWorkerConfig, type AiWorkerConfig } from './ai-worker.config.js';
export { AiOperationProcessor } from './ai-operation.processor.js';
export {
    AI_V2_PROVIDER_PORT,
    AI_V2_PROVIDER_RUNTIME,
    aiProviderProfileVersionSchema,
    frozenProviderRequestSchema,
    providerCommandFor,
    providerFailureCategorySchema,
    providerFinancialEffect,
    providerReadOutcomeSchema,
    providerSubmitOutcomeSchema,
    providerUsageSchema,
    type AiProviderPort,
    type AiV2ProviderRuntime,
    type FrozenProviderRequest,
    type ProviderDispatchState,
    type ProviderFailureCategory,
    type ProviderReadOutcome,
    type ProviderSubmitOutcome,
} from './ai-provider-port.js';
export {
    AiV2PublicActivationGate,
    aiV2CulinaryPublicOperationSchema,
    aiV2CulinaryPublicPreviewSchema,
    aiV2PublicActivationBlockerSchema,
    culinaryPublicActivationDecision,
    type AiV2PublicActivationBlocker,
} from './ai-public-activation.js';
export { AiProviderSimulator, type AiProviderSimulatorScenario } from './ai-provider-simulator.js';
export {
    YANDEX_AI_ENDPOINT,
    readYandexAiAdapterConfig,
    type YandexAiAdapterConfig,
    type YandexAiReadiness,
} from './yandex-ai-adapter.config.js';
export { YandexAiAdapter } from './yandex-ai-adapter.js';
export {
    aiV2ProviderDispatchStateSchema,
    aiV2ProviderNextCommand,
    aiV2ProviderTransitionAllowed,
    aiV2ProviderUsageSchema,
    type AiV2PersistedReadOutcome,
    type AiV2ProviderDispatchState,
    type AiV2ProviderUsage,
} from './ai-provider-operation.js';
export { AiV2ProviderDispatchConflict, AiV2ProviderOperationStore } from './ai-provider-operation.store.js';
export { AiV2CulinaryExecutor } from './ai-culinary-executor.js';
export { AiV2CulinaryInternalService } from './ai-culinary-internal.service.js';
export { AiV2BeveragePairingExecutor } from './ai-beverage-pairing-executor.js';
export { AiV2BeveragePairingInternalService } from './ai-beverage-pairing-internal.service.js';
export {
    AI_V2_BEVERAGE_PAIRING_MAX_OUTPUT_TOKENS,
    aiV2BeverageCandidateSchema,
    aiV2BeveragePairingShortlistSchema,
    beveragePairingBoundaryResult,
    beveragePairingProviderRequest,
    containsAlcoholMarker,
    validateBeveragePairingProviderResult,
    type AiV2BeveragePairingShortlist,
} from './ai-beverage-pairing.js';
export { AiV2RecipeAdaptationExecutor } from './ai-recipe-adaptation-executor.js';
export { AiV2RecipeAdaptationInternalService } from './ai-recipe-adaptation-internal.service.js';
export {
    AI_V2_RECIPE_ADAPTATION_MAX_OUTPUT_TOKENS,
    aiV2RecipeAdaptationSourceIngredientSchema,
    aiV2RecipeAdaptationSnapshotSchema,
    aiV2RecipeAdaptationStepSchema,
    recipeAdaptationProviderRequest,
    scaleRecipeAdaptationIngredients,
    validateRecipeAdaptationProviderResult,
    type AiV2RecipeAdaptationSnapshot,
} from './ai-recipe-adaptation.js';
export { AiV2RegistryAnalysisExecutor } from './ai-registry-analysis-executor.js';
export { AiV2RegistryAnalysisInternalService } from './ai-registry-analysis-internal.service.js';
export { AiV2NutritionCalculationExecutor } from './ai-nutrition-calculation-executor.js';
export { AiV2NutritionCalculationInternalService } from './ai-nutrition-calculation-internal.service.js';
export { AiV2PortionCostCalculationExecutor } from './ai-portion-cost-calculation-executor.js';
export { AiV2PortionCostCalculationInternalService } from './ai-portion-cost-calculation-internal.service.js';
export {
    AI_V2_PORTION_COST_ALGORITHM_VERSION,
    AI_V2_PORTION_COST_LINE_LIMIT,
    AI_V2_PORTION_COST_MAX_INPUT_BYTES,
    AI_V2_PORTION_COST_MAX_OUTPUT_TOKENS,
    aiV2PortionCostLineSchema,
    aiV2PortionCostPriceSchema,
    aiV2PortionCostSnapshotSchema,
    calculatePortionCostResult,
    estimatePortionCostMinor,
    portionCostProviderRequest,
    scalePortionCostQuantity,
    validatePortionCostProviderResult,
    type AiV2PortionCostSnapshot,
} from './ai-portion-cost-calculation.js';
export {
    AI_V2_NUTRITION_ALGORITHM_VERSION,
    AI_V2_NUTRITION_MAX_INPUT_BYTES,
    AI_V2_NUTRITION_MAX_OUTPUT_TOKENS,
    aiV2NutritionSnapshotSchema,
    aiV2NutritionSourceSchema,
    calculateNutritionValues,
    canonicalNutritionSnapshot,
    nutritionProviderRequest,
    scaleNutritionDecimal,
    validateNutritionProviderResult,
    type AiV2NutritionSnapshot,
} from './ai-nutrition-calculation.js';
export {
    AI_V2_REGISTRY_ANALYSIS_MAX_OUTPUT_TOKENS,
    aiV2RegistryFactsSnapshotSchema,
    registryAnalysisProviderRequest,
    registryWarningCodes,
    validateRegistryAnalysisProviderResult,
    type AiV2RegistryFactsSnapshot,
} from './ai-registry-analysis.js';
export { AiV2ReviewSummaryExecutor } from './ai-review-summary-executor.js';
export { AiV2ReviewSummaryInternalService } from './ai-review-summary-internal.service.js';
export { AiV2MealPlanGenerationExecutor } from './ai-meal-plan-generation-executor.js';
export { AiV2MealPlanGenerationInternalService } from './ai-meal-plan-generation-internal.service.js';
export { AiV2EventMenuGenerationExecutor } from './ai-event-menu-generation-executor.js';
export { AiV2EventMenuGenerationInternalService } from './ai-event-menu-generation-internal.service.js';
export {
    AI_V2_EVENT_MENU_CANDIDATE_LIMIT,
    AI_V2_EVENT_MENU_MAX_INPUT_BYTES,
    AI_V2_EVENT_MENU_MAX_OUTPUT_TOKENS,
    aiV2EventMenuCandidateSchema,
    aiV2EventMenuRoleSchema,
    aiV2EventMenuShortlistSchema,
    aiV2EventMenuSlotSchema,
    buildEventMenuSlots,
    eventMenuCandidateRole,
    eventMenuProviderRequest,
    sanitizeEventMenuText,
    validateEventMenuProviderResult,
    type AiV2EventMenuCandidate,
    type AiV2EventMenuShortlist,
} from './ai-event-menu-generation.js';
export {
    AI_V2_MEAL_PLAN_CANDIDATE_LIMIT,
    AI_V2_MEAL_PLAN_GENERATE_MAX_OUTPUT_TOKENS,
    AI_V2_MEAL_PLAN_REPEAT_LIMIT,
    AI_V2_MEAL_PLAN_REPLACE_MAX_OUTPUT_TOKENS,
    aiV2MealPlanCandidateSchema,
    aiV2MealPlanFrozenSlotSchema,
    aiV2MealPlanReplaceSnapshotSchema,
    aiV2MealPlanShortlistSchema,
    assertMealPlanMonday,
    buildMealPlanSlots,
    mealPlanCandidateMeals,
    mealPlanGenerateProviderRequest,
    mealPlanReplaceProviderRequest,
    sanitizeMealPlanText,
    validateMealPlanGenerateProviderResult,
    validateMealPlanReplaceProviderResult,
    type AiV2MealPlanCandidate,
    type AiV2MealPlanReplaceSnapshot,
    type AiV2MealPlanShortlist,
} from './ai-meal-plan-generation.js';
export {
    AI_V2_REVIEW_SUMMARY_MAX_EXCERPTS,
    AI_V2_REVIEW_SUMMARY_MAX_OUTPUT_TOKENS,
    AI_V2_REVIEW_SUMMARY_MIN_EXCERPTS,
    aiV2ReviewSummaryExcerptSchema,
    aiV2ReviewSummarySnapshotSchema,
    deterministicReviewSummarySample,
    parseReviewSummarySourceRelease,
    reviewSummaryProviderRequest,
    reviewSummaryWarningCodes,
    reviewSummaryWithoutModel,
    sanitizePublicReviewExcerpt,
    validateReviewSummaryProviderResult,
    type AiV2ReviewSummarySnapshot,
} from './ai-review-summary.js';
export { AiV2SubstitutionExecutor } from './ai-substitution-executor.js';
export { AiV2SubstitutionInternalService } from './ai-substitution-internal.service.js';
export { AiV2StorageAdviceExecutor } from './ai-storage-advice-executor.js';
export { AiV2StorageAdviceInternalService } from './ai-storage-advice-internal.service.js';
export { AiV2IngredientExtractionExecutor } from './ai-ingredient-extraction-executor.js';
export { AiV2IngredientExtractionInternalService } from './ai-ingredient-extraction-internal.service.js';
export { AiV2PersonalRecommendationInternalService } from './ai-personal-recommendation-internal.service.js';
export {
    AI_V2_WEEKLY_RECOMMENDATION_LIMIT,
    aiV2WeeklyRecommendationCandidateSchema,
    assertWeeklyRecommendationMonday,
    rankWeeklyRecommendations,
    type AiV2WeeklyRecommendationCandidate,
    type AiV2WeeklyRecommendationPreferences,
} from './ai-personal-recommendation.js';
export { AiV2ProductClassificationExecutor } from './ai-product-classification-executor.js';
export { AiV2ProductClassificationInternalService } from './ai-product-classification-internal.service.js';
export { AiV2RecipeFromStockExecutor } from './ai-recipe-from-stock-executor.js';
export { AiV2RecipeFromStockInternalService } from './ai-recipe-from-stock-internal.service.js';
export {
    AI_V2_RECIPE_FROM_STOCK_MAX_OUTPUT_TOKENS,
    aiV2RecipeCandidateSchema,
    aiV2RecipeFromStockShortlistSchema,
    aiV2RecipeStockItemSchema,
    aiV2RecipeStockRefSchema,
    recipeFromStockProviderRequest,
    validateRecipeFromStockProviderResult,
    type AiV2RecipeFromStockShortlist,
} from './ai-recipe-from-stock.js';
export {
    AI_V2_PRODUCT_CLASSIFICATION_MAX_OUTPUT_TOKENS,
    aiV2ProductClassificationCandidateSchema,
    aiV2ProductClassificationShortlistSchema,
    productClassificationProviderRequest,
    validateProductClassificationProviderResult,
    type AiV2ProductClassificationShortlist,
} from './ai-product-classification.js';
export {
    AI_V2_INGREDIENT_EXTRACTION_MAX_OUTPUT_TOKENS,
    classifyIngredientExtractionText,
    ingredientExtractionBoundaryResult,
    ingredientExtractionProviderRequest,
    sanitizeIngredientExtractionText,
    validateIngredientExtractionProviderResult,
    type IngredientExtractionBoundary,
} from './ai-ingredient-extraction.js';
export {
    AI_V2_STORAGE_MAX_OUTPUT_TOKENS,
    aiV2StorageTypeSchema,
    aiV2StorageVerdictSchema,
    storageAdviceProviderRequest,
    validateStorageAdviceProviderResult,
    type AiV2StorageVerdict,
} from './ai-storage-advice.js';
export {
    AI_V2_SUBSTITUTION_MAX_OUTPUT_TOKENS,
    aiV2SubstitutionCandidateSchema,
    classifySubstitutionQuestion,
    substitutionBoundaryResult,
    substitutionProviderRequest,
    validateSubstitutionProviderResult,
    type AiV2SubstitutionCandidate,
    type SubstitutionBoundary,
} from './ai-substitution.js';
export {
    AI_EVALUATION_FIXTURES,
    AI_EVALUATION_SUITE_VERSION,
    aiEvaluationCaseEvidenceSchema,
    aiEvaluationFixtureSchema,
    aiEvaluationRunEvidenceSchema,
    summarizeAiEvaluation,
    type AiEvaluationFixture,
    type AiEvaluationRunEvidence,
} from './ai-evaluation.js';
export {
    AI_PROVIDER_PROFILES,
    aiFormatMoneyUnits,
    aiMoneyUnits,
    aiProviderCost,
    aiProviderProfile,
    type AiProviderProfile,
    type AiProviderProfileVersion,
} from '../../shared/config/ai-provider-profile.js';
export { AiService, monthlyQuotaWindow } from './ai.service.js';
export {
    AI_CONTEXT_POLICY_VERSION,
    aiContextSnapshotHash,
    aiContextSnapshotSchema,
    aiContextSourceCount,
    aiInventoryContextItemSchema,
    aiNutritionContextSchema,
    aiPreferencesContextSchema,
    aiTaskContextPolicies,
    aiTaskRequiresPersonalData,
    parseAiContextSnapshot,
    renderAiContext,
    type AiContextSnapshot,
} from './ai-context.js';
export {
    aiBalanceSchema,
    aiBucketSchema,
    aiCapabilitiesSchema,
    aiContextManifestSchema,
    aiContextSourceKindSchema,
    aiContinueRequestSchema,
    aiConversationSchema,
    aiFamilyMemberSchema,
    aiFamilySharingSchema,
    aiHistoryArchiveResultSchema,
    aiHistoryArchiveSchema,
    aiHistoryItemSchema,
    aiHistoryQuerySchema,
    aiHistorySchema,
    aiMessageSchema,
    aiOrchestrationSchema,
    aiOperationFinancialStateSchema,
    aiOperationSchema,
    aiOperationStateSchema,
    aiPreviewRequestSchema,
    aiPreviewSchema,
    aiPurchaseRequestSchema,
    aiPurchaseSchema,
    aiRunRequestSchema,
    aiRunSchema,
    aiTaskCatalogItemSchema,
    aiTaskClassSchema,
    aiTaskTypeSchema,
    aiTokenBudgetSchema,
    aiTransferDecisionSchema,
    aiTransferRequestSchema,
    aiTransferResultSchema,
    aiTransferSchema,
    type AiTaskType,
    type AiContextSourceKind,
} from './ai.contracts.js';
export { aiContinuationPolicy, type AiContinuationPolicy, type AiContinuationPolicyInput } from './ai.domain.js';
export {
    AI_TASK_RULE_VERSION,
    aiAvailableTasks,
    aiOrchestration,
    aiTask,
    aiTaskAvailable,
    aiTasks,
    aiTokenBudget,
    type AiTaskDefinition,
    type AiContextManifest,
} from './ai-orchestration.js';
export {
    AI_CACHE_POLICY_V1,
    AI_CONTEXT_POLICY_V2,
    AI_PRICE_POLICY_V1,
    AI_RESULT_CONTRACT_V2,
    AI_ROUTING_POLICY_V1,
    AI_SAFETY_POLICY_V1,
    AI_TASK_POLICY_V4,
    aiTaskModeKey,
    aiTaskModeV4,
    aiTaskModesV4,
    aiV4ProviderProfiles,
    assertAiTaskPolicyV4,
    type AiActionCost,
    type AiApplicationKind,
    type AiCacheScope,
    type AiExecutionRoute,
    type AiTaskModeDefinition,
    type AiTaskModeV4,
} from './ai-policy-v4.js';
export {
    aiV2CulinaryAnswerResultSchema,
    aiV2BeveragePairingResultSchema,
    aiV2RecipeAdaptationIngredientSchema,
    aiV2RecipeAdaptationResultSchema,
    aiV2RecipeScaleResultSchema,
    aiV2RegistryExplainResultSchema,
    aiV2RegistryFactKeySchema,
    aiV2RegistryFactSchema,
    aiV2RegistryFactsResultSchema,
    aiV2NutritionFactKeySchema,
    aiV2NutritionValuesSchema,
    aiV2NutritionCalculationResultSchema,
    aiV2NutritionExplainResultSchema,
    aiV2PortionCostReasonCountsSchema,
    aiV2PortionCostCalculationResultSchema,
    aiV2PortionCostExplainResultSchema,
    aiV2ReviewSummaryFactsSchema,
    aiV2ReviewSummaryResultSchema,
    aiV2ReviewSummarySourceReleaseSchema,
    aiV2ReviewSummaryWarningCodeSchema,
    aiV2MealPlanSlotSchema,
    aiV2MealPlanGenerationResultSchema,
    aiV2MealPlanReplaceSlotResultSchema,
    aiV2EventMenuItemSchema,
    aiV2EventMenuGenerationResultSchema,
    aiV2CulinaryRecoveryCodeSchema,
    aiV2CulinaryWarningCodeSchema,
    aiV2SubstitutionExplainResultSchema,
    aiV2SubstitutionRecoveryCodeSchema,
    aiV2SubstitutionWarningCodeSchema,
    aiV2StorageExplainResultSchema,
    aiV2StorageRecoveryCodeSchema,
    aiV2StorageWarningCodeSchema,
    aiV2IngredientExtractionCandidateSchema,
    aiV2IngredientExtractionResultSchema,
    aiV2IngredientExtractionWarningCodeSchema,
    aiV2ProductClassificationResultSchema,
    aiV2PersonalRecommendationReasonCodeSchema,
    aiV2PersonalRecommendationResultSchema,
    aiV2RecipeFromStockIngredientSchema,
    aiV2RecipeFromStockResultSchema,
    aiV2ContextSelectionSchema,
    aiV2BackendOperationSchema,
    aiV2FrozenPreviewSchema,
    aiV2InputSchemas,
    aiV2PreviewSchema,
    aiV2PreviewSourceSchema,
    aiV2ResultEnvelopeSchema,
    aiV2RunRequestSchema,
    aiV2WarningCodeSchema,
    aiV2ShoppingListFromMealPlanInputSchema,
    aiV2ShoppingListFromRecipesInputSchema,
    parseAiV2PreviewRequest,
    type AiV2ExecutableTaskModeKey,
    type AiV2BackendOperation,
    type AiV2FrozenPreview,
    type AiV2Preview,
    type AiV2PreviewRequest,
    type AiV2ResultEnvelope,
    type AiV2CulinaryAnswerResult,
    type AiV2BeveragePairingResult,
    type AiV2RecipeAdaptationResult,
    type AiV2RecipeScaleResult,
    type AiV2RegistryExplainResult,
    type AiV2RegistryFact,
    type AiV2RegistryFactsResult,
    type AiV2NutritionValues,
    type AiV2NutritionCalculationResult,
    type AiV2NutritionExplainResult,
    type AiV2PortionCostReasonCounts,
    type AiV2PortionCostCalculationResult,
    type AiV2PortionCostExplainResult,
    type AiV2ReviewSummaryFacts,
    type AiV2ReviewSummaryResult,
    type AiV2MealPlanSlot,
    type AiV2MealPlanGenerationResult,
    type AiV2MealPlanReplaceSlotResult,
    type AiV2EventMenuItem,
    type AiV2EventMenuGenerationResult,
    type AiV2SubstitutionExplainResult,
    type AiV2StorageExplainResult,
    type AiV2IngredientExtractionResult,
    type AiV2ProductClassificationResult,
    type AiV2PersonalRecommendationResult,
    type AiV2RecipeFromStockResult,
    type AiV2RunRequest,
    type AiV2ShoppingListFromMealPlanInput,
    type AiV2ShoppingListFromRecipesInput,
} from './ai-v2.contracts.js';
export {
    AI_V2_CULINARY_MAX_OUTPUT_TOKENS,
    classifyCulinaryQuestion,
    culinaryBoundaryResult,
    culinaryProviderRequest,
    validateCulinaryProviderResult,
    type CulinaryQuestionBoundary,
} from './ai-culinary-question.js';
export {
    AiV2PreviewPolicyError,
    aiV2TaskContractColumns,
    aiV2TaskPreviewSnapshot,
    prepareAiV2Preview,
    type AiV2OfferedSource,
    type AiV2PreparedPreview,
    type AiV2PreviewEnvironment,
    type AiV2PreviewPolicyErrorCode,
} from './ai-v2-preview.js';
