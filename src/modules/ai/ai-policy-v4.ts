import type { PlanCode } from '../entitlements/public.js';
import { aiTaskTypeSchema, type AiTaskType } from './ai.contracts.js';

export const AI_TASK_POLICY_V4 = 'ai-task-policy-v4';
export const AI_ROUTING_POLICY_V1 = 'ai-routing-policy-v1';
export const AI_PRICE_POLICY_V1 = 'ai-price-policy-v1';
export const AI_CONTEXT_POLICY_V2 = 'ai-context-policy-v2';
export const AI_RESULT_CONTRACT_V2 = 'ai-result-contract-v2';
export const AI_CACHE_POLICY_V1 = 'ai-cache-policy-v1';
export const AI_SAFETY_POLICY_V1 = 'ai-safety-policy-v1';

export type AiExecutionRoute = 'backend' | 'economy' | 'balanced' | 'disabled';
export type AiActionCost = 0 | 1 | 2 | 3 | 4;
export type AiApplicationKind = 'read_only' | 'preview_then_confirm' | 'artifact';
export type AiCacheScope = 'none' | 'personal_exact' | 'shared_public_artifact';

export const aiV4ProviderProfiles = {
    economy: {
        version: 'yandex-alice-flash-economy-v1',
        maxInputBytes: 24 * 1024,
        maxOutputTokens: 1_000,
        fallbackProfileVersion: null,
    },
    balanced: {
        version: 'yandexgpt-5.1-balanced-v1',
        maxInputBytes: 48 * 1024,
        maxOutputTokens: 2_000,
        fallbackProfileVersion: null,
    },
} as const;

type ProviderRoute = Exclude<AiExecutionRoute, 'backend' | 'disabled'>;

type ExecutableTaskModeDefinition = {
    task: AiTaskType;
    mode: string;
    minimumPlan: PlanCode;
    route: Exclude<AiExecutionRoute, 'disabled'>;
    actionCost: AiActionCost;
    requiredCapability: string;
    applicationKind: AiApplicationKind;
    cacheScope: AiCacheScope;
    maxInputBytes: number;
    maxOutputTokens: number | null;
    providerProfileVersion: string | null;
    providerCostCeilingMinor: number | null;
    clarification: { includedMessages: 0 | 2; intervalSeconds: number | null };
    resultSchemaVersion: string;
};

type DisabledTaskModeDefinition = {
    task: AiTaskType;
    mode: 'disabled';
    minimumPlan: null;
    route: 'disabled';
    actionCost: null;
    requiredCapability: null;
    applicationKind: 'read_only';
    cacheScope: 'none';
    maxInputBytes: 0;
    maxOutputTokens: null;
    providerProfileVersion: null;
    providerCostCeilingMinor: null;
    clarification: { includedMessages: 0; intervalSeconds: null };
    resultSchemaVersion: null;
};

export type AiTaskModeDefinition = ExecutableTaskModeDefinition | DisabledTaskModeDefinition;

const noClarification = { includedMessages: 0, intervalSeconds: null } as const;
const mealPlanClarification = { includedMessages: 2, intervalSeconds: 600 } as const;

function resultSchema(task: AiTaskType, mode: string) {
    return `${AI_RESULT_CONTRACT_V2}:${task}:${mode}`;
}

function backend(
    task: AiTaskType,
    mode: string,
    minimumPlan: PlanCode,
    options: {
        requiredCapability: string;
        applicationKind?: AiApplicationKind;
        cacheScope?: AiCacheScope;
        maxInputBytes?: number;
    },
): ExecutableTaskModeDefinition {
    return {
        task,
        mode,
        minimumPlan,
        route: 'backend',
        actionCost: 0,
        requiredCapability: options.requiredCapability,
        applicationKind: options.applicationKind ?? 'read_only',
        cacheScope: options.cacheScope ?? 'personal_exact',
        maxInputBytes: options.maxInputBytes ?? 8 * 1024,
        maxOutputTokens: null,
        providerProfileVersion: null,
        providerCostCeilingMinor: null,
        clarification: noClarification,
        resultSchemaVersion: resultSchema(task, mode),
    };
}

function provider(
    task: AiTaskType,
    mode: string,
    minimumPlan: PlanCode,
    route: ProviderRoute,
    actionCost: AiActionCost,
    options: {
        requiredCapability: string;
        applicationKind?: AiApplicationKind;
        cacheScope?: AiCacheScope;
        maxInputBytes: number;
        maxOutputTokens: number;
        providerCostCeilingMinor: number;
        clarification?: typeof noClarification | typeof mealPlanClarification;
    },
): ExecutableTaskModeDefinition {
    return {
        task,
        mode,
        minimumPlan,
        route,
        actionCost,
        requiredCapability: options.requiredCapability,
        applicationKind: options.applicationKind ?? 'read_only',
        cacheScope: options.cacheScope ?? 'none',
        maxInputBytes: options.maxInputBytes,
        maxOutputTokens: options.maxOutputTokens,
        providerProfileVersion: aiV4ProviderProfiles[route].version,
        providerCostCeilingMinor: options.providerCostCeilingMinor,
        clarification: options.clarification ?? noClarification,
        resultSchemaVersion: resultSchema(task, mode),
    };
}

function disabled(task: AiTaskType): DisabledTaskModeDefinition {
    return {
        task,
        mode: 'disabled',
        minimumPlan: null,
        route: 'disabled',
        actionCost: null,
        requiredCapability: null,
        applicationKind: 'read_only',
        cacheScope: 'none',
        maxInputBytes: 0,
        maxOutputTokens: null,
        providerProfileVersion: null,
        providerCostCeilingMinor: null,
        clarification: noClarification,
        resultSchemaVersion: null,
    };
}

export const aiTaskModesV4 = [
    provider('culinary_question', 'answer', 'free', 'economy', 1, {
        requiredCapability: 'ai.culinary_question',
        maxInputBytes: 8 * 1024,
        maxOutputTokens: 500,
        providerCostCeilingMinor: 100,
    }),
    backend('substitution', 'candidates', 'free', { requiredCapability: 'recipes.read' }),
    provider('substitution', 'explain', 'free', 'economy', 1, {
        requiredCapability: 'ai.substitution',
        maxInputBytes: 6 * 1024,
        maxOutputTokens: 350,
        providerCostCeilingMinor: 100,
    }),
    backend('storage_advice', 'rule', 'free', { requiredCapability: 'inventory.read' }),
    provider('storage_advice', 'explain', 'free', 'economy', 1, {
        requiredCapability: 'ai.storage_advice',
        maxInputBytes: 6 * 1024,
        maxOutputTokens: 350,
        providerCostCeilingMinor: 100,
    }),
    provider('ingredient_extraction', 'extract', 'free', 'economy', 1, {
        requiredCapability: 'ai.ingredient_extraction',
        applicationKind: 'preview_then_confirm',
        maxInputBytes: 12 * 1024,
        maxOutputTokens: 700,
        providerCostCeilingMinor: 100,
    }),
    backend('product_classification', 'candidates', 'free', { requiredCapability: 'catalog.read' }),
    provider('product_classification', 'classify', 'free', 'economy', 1, {
        requiredCapability: 'ai.product_classification',
        applicationKind: 'preview_then_confirm',
        maxInputBytes: 8 * 1024,
        maxOutputTokens: 250,
        providerCostCeilingMinor: 100,
    }),
    backend('recipe_from_stock', 'select_existing', 'free', {
        requiredCapability: 'recipes.read',
        maxInputBytes: 12 * 1024,
    }),
    provider('recipe_from_stock', 'generate_new', 'free', 'balanced', 2, {
        requiredCapability: 'ai.recipe_generation',
        applicationKind: 'preview_then_confirm',
        maxInputBytes: 24 * 1024,
        maxOutputTokens: 1_200,
        providerCostCeilingMinor: 600,
    }),
    backend('personal_recommendation', 'weekly', 'free', {
        requiredCapability: 'recommendations.read',
        applicationKind: 'artifact',
        cacheScope: 'personal_exact',
        maxInputBytes: 2 * 1024,
    }),
    backend('beverage_pairing', 'catalog', 'free', {
        requiredCapability: 'recipes.read',
        cacheScope: 'shared_public_artifact',
    }),
    provider('beverage_pairing', 'custom', 'free', 'economy', 1, {
        requiredCapability: 'ai.beverage_pairing',
        maxInputBytes: 8 * 1024,
        maxOutputTokens: 400,
        providerCostCeilingMinor: 100,
    }),
    backend('recipe_adaptation', 'scale', 'free', {
        requiredCapability: 'recipes.read',
        applicationKind: 'preview_then_confirm',
    }),
    provider('recipe_adaptation', 'adapt', 'free', 'balanced', 2, {
        requiredCapability: 'ai.recipe_adaptation',
        applicationKind: 'preview_then_confirm',
        maxInputBytes: 18 * 1024,
        maxOutputTokens: 1_200,
        providerCostCeilingMinor: 600,
    }),
    backend('registry_analysis', 'facts', 'free', { requiredCapability: 'inventory.read' }),
    provider('registry_analysis', 'explain', 'free', 'economy', 1, {
        requiredCapability: 'ai.registry_analysis',
        maxInputBytes: 12 * 1024,
        maxOutputTokens: 600,
        providerCostCeilingMinor: 100,
    }),
    provider('review_summary', 'public_summary', 'free', 'economy', 0, {
        requiredCapability: 'reviews.read_public',
        applicationKind: 'artifact',
        cacheScope: 'shared_public_artifact',
        maxInputBytes: 20 * 1024,
        maxOutputTokens: 700,
        providerCostCeilingMinor: 100,
    }),
    backend('shopping_list_generation', 'from_recipes', 'plus', {
        requiredCapability: 'shopping.manage',
        applicationKind: 'preview_then_confirm',
        maxInputBytes: 12 * 1024,
    }),
    backend('shopping_list_generation', 'from_meal_plan', 'plus', {
        requiredCapability: 'shopping.manage',
        applicationKind: 'preview_then_confirm',
        maxInputBytes: 4 * 1024,
    }),
    provider('meal_plan_generation', 'generate', 'plus', 'balanced', 4, {
        requiredCapability: 'meal_plan.manage',
        applicationKind: 'preview_then_confirm',
        maxInputBytes: 32 * 1024,
        maxOutputTokens: 700,
        providerCostCeilingMinor: 950,
        clarification: mealPlanClarification,
    }),
    provider('meal_plan_generation', 'replace_slot', 'plus', 'balanced', 0, {
        requiredCapability: 'meal_plan.manage',
        applicationKind: 'preview_then_confirm',
        maxInputBytes: 4 * 1024,
        maxOutputTokens: 100,
        providerCostCeilingMinor: 125,
        clarification: mealPlanClarification,
    }),
    provider('event_menu', 'generate', 'plus', 'balanced', 3, {
        requiredCapability: 'meal_plan.manage',
        applicationKind: 'preview_then_confirm',
        maxInputBytes: 32 * 1024,
        maxOutputTokens: 800,
        providerCostCeilingMinor: 700,
    }),
    backend('nutrition_calculation', 'calculate', 'pro', {
        requiredCapability: 'nutrition.analytics',
    }),
    provider('nutrition_calculation', 'explain', 'pro', 'economy', 1, {
        requiredCapability: 'nutrition.analytics',
        maxInputBytes: 10 * 1024,
        maxOutputTokens: 500,
        providerCostCeilingMinor: 100,
    }),
    backend('portion_cost_calculation', 'calculate', 'pro', {
        requiredCapability: 'finance.analytics',
    }),
    provider('portion_cost_calculation', 'explain', 'pro', 'economy', 1, {
        requiredCapability: 'finance.analytics',
        maxInputBytes: 10 * 1024,
        maxOutputTokens: 500,
        providerCostCeilingMinor: 100,
    }),
    disabled('seasonal_analysis'),
    disabled('document_analysis'),
] as const satisfies ReadonlyArray<AiTaskModeDefinition>;

export type AiTaskModeV4 = (typeof aiTaskModesV4)[number]['mode'];

export function aiTaskModeKey(task: AiTaskType, mode: string) {
    return `${task}/${mode}`;
}

export function aiTaskModeV4(task: AiTaskType, mode: string): AiTaskModeDefinition | undefined {
    return aiTaskModesV4.find((definition) => definition.task === task && definition.mode === mode);
}

export function assertAiTaskPolicyV4() {
    const keys = new Set<string>();
    const coveredTasks = new Set<AiTaskType>();

    for (const definition of aiTaskModesV4) {
        const key = aiTaskModeKey(definition.task, definition.mode);
        if (keys.has(key)) throw new Error(`Duplicate AI task/mode: ${key}`);
        keys.add(key);
        coveredTasks.add(definition.task);

        if (definition.route === 'backend') {
            if (definition.actionCost !== 0 || definition.providerProfileVersion !== null) {
                throw new Error(`Backend AI task/mode must be free and providerless: ${key}`);
            }
        } else if (definition.route === 'disabled') {
            if (definition.minimumPlan !== null || definition.actionCost !== null) {
                throw new Error(`Disabled AI task/mode must not be executable: ${key}`);
            }
        } else {
            const profile = aiV4ProviderProfiles[definition.route];
            if (definition.providerProfileVersion !== profile.version || profile.fallbackProfileVersion !== null) {
                throw new Error(`AI task/mode must use its fixed profile without fallback: ${key}`);
            }
            if (
                definition.maxInputBytes > profile.maxInputBytes ||
                definition.maxOutputTokens === null ||
                definition.maxOutputTokens > profile.maxOutputTokens
            ) {
                throw new Error(`AI task/mode exceeds provider profile limits: ${key}`);
            }
        }
    }

    for (const task of aiTaskTypeSchema.options) {
        if (!coveredTasks.has(task)) throw new Error(`AI task is missing from v4 policy: ${task}`);
    }
}

assertAiTaskPolicyV4();
