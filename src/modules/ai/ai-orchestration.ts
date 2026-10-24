import type { AiTaskType } from './ai.contracts.js';

export const AI_TASK_RULE_VERSION = 'ai-task-policy-v2';

export const aiTasks = [
    { code: 'culinary_question', label: 'Кулинарный вопрос', taskClass: 'standard', cost: 1 },
    { code: 'substitution', label: 'Подбор замены', taskClass: 'standard', cost: 1 },
    { code: 'storage_advice', label: 'Совет по хранению', taskClass: 'standard', cost: 1 },
    { code: 'ingredient_extraction', label: 'Извлечение ингредиентов', taskClass: 'standard', cost: 1 },
    { code: 'product_classification', label: 'Классификация продукта', taskClass: 'standard', cost: 1 },
    { code: 'recipe_from_stock', label: 'Рецепт из запасов', taskClass: 'advanced', cost: 2 },
    { code: 'nutrition_calculation', label: 'Расчёт КБЖУ', taskClass: 'advanced', cost: 2 },
    { code: 'personal_recommendation', label: 'Персональная рекомендация', taskClass: 'advanced', cost: 2 },
    { code: 'beverage_pairing', label: 'Подбор напитка', taskClass: 'advanced', cost: 2 },
    { code: 'portion_cost_calculation', label: 'Порции и стоимость', taskClass: 'advanced', cost: 2 },
    { code: 'recipe_adaptation', label: 'Адаптация рецепта', taskClass: 'advanced', cost: 2 },
    { code: 'shopping_list_generation', label: 'Список покупок', taskClass: 'heavy', cost: 3 },
    { code: 'registry_analysis', label: 'Анализ реестра', taskClass: 'heavy', cost: 3 },
    { code: 'review_summary', label: 'Саммаризация отзывов', taskClass: 'heavy', cost: 3 },
    { code: 'meal_plan_generation', label: 'План питания', taskClass: 'heavy', cost: 4 },
    { code: 'seasonal_analysis', label: 'Анализ сезонности', taskClass: 'heavy', cost: 4 },
    { code: 'event_menu', label: 'Меню для события', taskClass: 'heavy', cost: 4 },
    { code: 'document_analysis', label: 'Анализ документа', taskClass: 'heavy', cost: 5 },
] as const satisfies ReadonlyArray<{
    code: AiTaskType;
    label: string;
    taskClass: 'standard' | 'advanced' | 'heavy';
    cost: 1 | 2 | 3 | 4 | 5;
}>;

const tokenBudgets = {
    1: { maxInputTokens: 8_000, maxOutputTokens: 1_500 },
    2: { maxInputTokens: 16_000, maxOutputTokens: 3_000 },
    3: { maxInputTokens: 32_000, maxOutputTokens: 5_000 },
    4: { maxInputTokens: 48_000, maxOutputTokens: 7_000 },
    5: { maxInputTokens: 64_000, maxOutputTokens: 10_000 },
} as const;

export function aiTokenBudget(cost: 1 | 2 | 3 | 4 | 5) {
    return tokenBudgets[cost];
}

export type AiContextManifest = {
    personalDataUsed: boolean;
    sources: Array<{
        kind: 'user_prompt' | 'personal_inventory';
        label: string;
        itemCount: number;
        truncated: boolean;
    }>;
};

export function aiTask(taskType: AiTaskType) {
    return aiTasks.find((task) => task.code === taskType)!;
}

export function aiOrchestration(taskType: AiTaskType, priority: 'normal' | 'pro', context: AiContextManifest) {
    const task = aiTask(taskType);
    return {
        ruleVersion: AI_TASK_RULE_VERSION,
        taskClass: task.taskClass,
        priority,
        target: {
            provider: 'openai' as const,
            model: 'gpt-6-luna' as const,
            transport: 'responses' as const,
            reasoningEffort: 'low' as const,
        },
        tokenBudget: aiTokenBudget(task.cost),
        context,
        compensation: {
            providerFailure: 'release_reserved_actions' as const,
            internalRetryCost: 0 as const,
        },
    };
}
