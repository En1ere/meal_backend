import { z } from 'zod';

export const aiTaskTypeSchema = z.enum([
    'culinary_question',
    'recipe_from_stock',
    'substitution',
    'storage_advice',
    'meal_plan_generation',
    'shopping_list_generation',
    'registry_analysis',
    'personal_recommendation',
    'nutrition_calculation',
    'product_classification',
    'ingredient_extraction',
    'review_summary',
    'beverage_pairing',
    'event_menu',
    'portion_cost_calculation',
    'seasonal_analysis',
    'recipe_adaptation',
    'document_analysis',
]);
export type AiTaskType = z.infer<typeof aiTaskTypeSchema>;
export const aiTaskClassSchema = z.enum(['standard', 'advanced', 'heavy']);
export const aiTokenBudgetSchema = z.strictObject({
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
});
export const aiContextManifestSchema = z.strictObject({
    personalDataUsed: z.boolean(),
    sources: z.array(
        z.strictObject({
            kind: z.enum(['user_prompt', 'personal_inventory']),
            label: z.string().min(1),
            itemCount: z.number().int().nonnegative(),
            truncated: z.boolean(),
        }),
    ),
});
export const aiOrchestrationSchema = z.strictObject({
    ruleVersion: z.string().min(1),
    taskClass: aiTaskClassSchema,
    priority: z.enum(['normal', 'pro']),
    target: z.strictObject({
        provider: z.literal('openai'),
        model: z.literal('gpt-6-luna'),
        transport: z.literal('responses'),
        reasoningEffort: z.literal('low'),
    }),
    tokenBudget: aiTokenBudgetSchema,
    context: aiContextManifestSchema,
    compensation: z.strictObject({
        providerFailure: z.literal('release_reserved_actions'),
        internalRetryCost: z.literal(0),
    }),
});
export const aiTaskCatalogItemSchema = z.strictObject({
    code: aiTaskTypeSchema,
    label: z.string().min(1),
    taskClass: aiTaskClassSchema,
    cost: z.number().int().min(1).max(5),
    tokenBudget: aiTokenBudgetSchema,
});
export const aiCapabilitiesSchema = z.strictObject({
    provider: z.strictObject({
        configured: z.boolean(),
        kind: z.enum(['disabled', 'openai_compatible']),
        model: z.string().nullable(),
    }),
    executionAvailable: z.boolean(),
    purchaseMode: z.enum(['unavailable', 'simulation', 'ready']),
    freeTaskTypes: z.array(
        z.strictObject({ code: aiTaskTypeSchema, label: z.string(), cost: z.number().int().min(1).max(5) }),
    ),
    taskTypes: z.array(aiTaskCatalogItemSchema),
    orchestrationRuleVersion: z.string().min(1),
    disclaimer: z.string(),
});
export const aiBucketSchema = z.strictObject({
    id: z.uuid(),
    kind: z.enum(['subscription', 'transferred', 'family_reserve', 'purchased', 'trial']),
    granted: z.number().int().nonnegative(),
    balance: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    requiresConfirmation: z.boolean(),
    expiresAt: z.iso.datetime().nullable(),
});
export const aiBalanceSchema = z.strictObject({
    buckets: z.array(aiBucketSchema),
    total: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    debitOrder: z.array(aiBucketSchema.shape.kind),
    packageOffer: z.strictObject({
        actions: z.literal(40),
        amountMinor: z.literal(19900),
        currency: z.literal('RUB'),
        purchaseMode: z.enum(['unavailable', 'simulation', 'ready']),
    }),
});
export const aiHistoryItemSchema = z.strictObject({
    id: z.uuid(),
    title: z.string(),
    taskType: aiTaskTypeSchema,
    status: z.enum(['preview', 'processing', 'completed', 'failed', 'refunded']),
    cost: z.number().int().min(1).max(5),
    createdAt: z.iso.datetime(),
    result: z.string().nullable(),
    archived: z.boolean(),
    version: z.number().int().positive(),
});
export const aiHistoryQuerySchema = z.strictObject({
    archived: z.enum(['active', 'archived', 'all']).default('active'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(2000).optional(),
});
export const aiHistorySchema = z.strictObject({
    items: z.array(aiHistoryItemSchema),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
});
export const aiHistoryArchiveSchema = z.strictObject({
    archived: z.boolean(),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const aiHistoryArchiveResultSchema = z.strictObject({ item: aiHistoryItemSchema });
export const aiPreviewRequestSchema = z.strictObject({
    taskType: aiTaskTypeSchema,
    prompt: z.string().trim().min(3).max(4000),
    usePersonalData: z.boolean(),
    agreementAccepted: z.literal(true),
});
export const aiPreviewSchema = z.strictObject({
    previewId: z.uuid(),
    taskType: aiTaskTypeSchema,
    cost: z.number().int().min(1).max(5),
    prompt: z.string(),
    balanceBefore: z.number().int().nonnegative(),
    balanceAfter: z.number().int().nonnegative(),
    sources: z.array(z.string()),
    expiresAt: z.iso.datetime(),
    providerReady: z.boolean(),
    familyReserveRequired: z.number().int().nonnegative(),
    orchestration: aiOrchestrationSchema,
});
export const aiRunRequestSchema = z.strictObject({
    previewId: z.uuid(),
    idempotencyKey: z.uuid(),
    familyReserveAccepted: z.boolean(),
});
export const aiRunSchema = z.strictObject({ item: aiHistoryItemSchema });
export const aiMessageSchema = z.strictObject({
    id: z.uuid(),
    role: z.enum(['user', 'assistant']),
    body: z.string(),
    createdAt: z.iso.datetime(),
});
export const aiConversationSchema = z.strictObject({
    item: aiHistoryItemSchema,
    messages: z.array(aiMessageSchema),
    continuation: z.strictObject({
        state: z.enum(['ready', 'processing', 'wait']),
        clarificationsUsed: z.number().int().min(0).max(2),
        clarificationsRemaining: z.number().int().min(0).max(2),
        intervalEndsAt: z.iso.datetime().nullable(),
        nextMessageCost: z.number().int().min(0).max(5),
    }),
});
export const aiContinueRequestSchema = z.strictObject({
    message: z.string().trim().min(1).max(4000),
    idempotencyKey: z.uuid(),
    familyReserveAccepted: z.boolean(),
});
export const aiPurchaseRequestSchema = z.strictObject({
    idempotencyKey: z.uuid(),
    acceptedAmountMinor: z.literal(19900),
});
export const aiPurchaseSchema = z.strictObject({
    status: z.enum(['unavailable', 'simulated', 'completed']),
    balance: aiBalanceSchema,
});

export const aiFamilyMemberSchema = z.strictObject({
    userId: z.uuid(),
    displayName: z.string().min(1),
    availableToTransfer: z.number().int().nonnegative(),
    currentUser: z.boolean(),
});
export const aiTransferSchema = z.strictObject({
    id: z.uuid(),
    donorId: z.uuid(),
    donorName: z.string().min(1),
    recipientId: z.uuid(),
    recipientName: z.string().min(1),
    amount: z.number().int().positive(),
    status: z.enum(['pending', 'accepted', 'rejected', 'expired']),
    expiresAt: z.iso.datetime(),
    version: z.number().int().positive(),
});
export const aiFamilySharingSchema = z.strictObject({
    members: z.array(aiFamilyMemberSchema),
    transfers: z.array(aiTransferSchema),
});
export const aiTransferRequestSchema = z.strictObject({
    donorId: z.uuid(),
    amount: z.number().int().positive().max(120),
    idempotencyKey: z.uuid(),
});
export const aiTransferDecisionSchema = z.strictObject({
    decision: z.enum(['accept', 'reject']),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const aiTransferResultSchema = z.strictObject({ transfer: aiTransferSchema });
