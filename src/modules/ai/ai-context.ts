import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AiContextSourceKind, AiTaskType } from './ai.contracts.js';

export const AI_CONTEXT_POLICY_VERSION = 'ai-context-v1';

export const aiInventoryContextItemSchema = z.strictObject({
    name: z.string().min(1).max(300),
    quantity: z.string().nullable(),
    unit: z.string().min(1).max(50),
});

export const aiPreferencesContextSchema = z.strictObject({
    diets: z.array(z.string().min(1).max(50)).max(20),
    allergens: z.array(z.string().min(1).max(50)).max(30),
    dislikes: z.array(z.string().min(1).max(100)).max(50),
    allergenMode: z.enum(['warn', 'hide']),
    equipment: z.record(z.string().min(1).max(50), z.enum(['yes', 'no', 'unknown'])),
    goals: z.array(z.string().min(1).max(50)).max(20),
});

const nullableNutrientSchema = z
    .string()
    .regex(/^\d+(?:\.\d{1,8})?$/)
    .nullable();
export const aiNutritionContextSchema = z.strictObject({
    goal: z.enum(['maintain', 'lose_weight', 'gain_weight', 'custom']).nullable(),
    target: z
        .strictObject({
            energyKcal: nullableNutrientSchema,
            proteinG: nullableNutrientSchema,
            fatG: nullableNutrientSchema,
            carbohydrateG: nullableNutrientSchema,
            fiberG: nullableNutrientSchema,
        })
        .nullable(),
});

export const aiContextSnapshotSchema = z.strictObject({
    version: z.literal(AI_CONTEXT_POLICY_VERSION),
    inventory: z.array(aiInventoryContextItemSchema).max(50),
    inventoryTruncated: z.boolean(),
    preferences: aiPreferencesContextSchema.nullable(),
    nutrition: aiNutritionContextSchema.nullable(),
    capturedAt: z.iso.datetime(),
});

export type AiContextSnapshot = z.infer<typeof aiContextSnapshotSchema>;

type SourcePolicy = Readonly<{
    required: ReadonlyArray<AiContextSourceKind>;
    optional: ReadonlyArray<AiContextSourceKind>;
}>;

const noPersonalContext: SourcePolicy = { required: [], optional: [] };
const preferencesOptional: SourcePolicy = { required: [], optional: ['preferences'] };

export const aiTaskContextPolicies = {
    culinary_question: preferencesOptional,
    recipe_from_stock: { required: ['personal_inventory'], optional: ['preferences'] },
    substitution: { required: [], optional: ['personal_inventory', 'preferences'] },
    storage_advice: { required: [], optional: ['personal_inventory'] },
    meal_plan_generation: {
        required: [],
        optional: ['personal_inventory', 'preferences', 'nutrition_profile'],
    },
    shopping_list_generation: { required: [], optional: ['personal_inventory', 'preferences'] },
    registry_analysis: { required: ['personal_inventory'], optional: ['preferences'] },
    personal_recommendation: { required: ['preferences'], optional: ['personal_inventory', 'nutrition_profile'] },
    nutrition_calculation: { required: [], optional: ['preferences', 'nutrition_profile'] },
    product_classification: noPersonalContext,
    ingredient_extraction: noPersonalContext,
    review_summary: noPersonalContext,
    beverage_pairing: preferencesOptional,
    event_menu: preferencesOptional,
    portion_cost_calculation: noPersonalContext,
    seasonal_analysis: noPersonalContext,
    recipe_adaptation: { required: [], optional: ['personal_inventory', 'preferences'] },
    document_analysis: noPersonalContext,
} as const satisfies Record<AiTaskType, SourcePolicy>;

export function aiTaskRequiresPersonalData(taskType: AiTaskType) {
    return aiTaskContextPolicies[taskType].required.length > 0;
}

export function parseAiContextSnapshot(value: unknown, capturedAt = new Date().toISOString()): AiContextSnapshot {
    const current = aiContextSnapshotSchema.safeParse(value);
    if (current.success) return current.data;
    const legacy = z.array(aiInventoryContextItemSchema).max(50).safeParse(value);
    if (legacy.success)
        return {
            version: AI_CONTEXT_POLICY_VERSION,
            inventory: legacy.data,
            inventoryTruncated: false,
            preferences: null,
            nutrition: null,
            capturedAt,
        };
    return {
        version: AI_CONTEXT_POLICY_VERSION,
        inventory: [],
        inventoryTruncated: false,
        preferences: null,
        nutrition: null,
        capturedAt,
    };
}

export function aiContextSourceCount(snapshot: AiContextSnapshot, kind: AiContextSourceKind) {
    if (kind === 'user_prompt') return 1;
    if (kind === 'personal_inventory') return snapshot.inventory.length;
    if (kind === 'preferences') {
        const preferences = snapshot.preferences;
        if (!preferences) return 0;
        return (
            preferences.diets.length +
            preferences.allergens.length +
            preferences.dislikes.length +
            Object.keys(preferences.equipment).length +
            preferences.goals.length
        );
    }
    if (kind === 'nutrition_profile') return snapshot.nutrition ? 1 : 0;
    return 0;
}

export function aiContextSnapshotHash(snapshot: AiContextSnapshot) {
    return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function renderAiContext(snapshot: AiContextSnapshot | null) {
    if (!snapshot) return 'Персональный контекст не передан.';
    const sections: string[] = [];
    if (snapshot.inventory.length)
        sections.push(
            `Личные запасы:\n${snapshot.inventory
                .map((item) => `${item.name}: ${item.quantity ?? 'количество неизвестно'} ${item.unit}`)
                .join('\n')}`,
        );
    if (snapshot.preferences) sections.push(`Предпочтения и ограничения:\n${JSON.stringify(snapshot.preferences)}`);
    if (snapshot.nutrition) sections.push(`Профиль и цели питания:\n${JSON.stringify(snapshot.nutrition)}`);
    return sections.length ? sections.join('\n\n') : 'Разрешённый персональный контекст пуст.';
}
