import { z } from 'zod';
import { recipeRecommendationSchema } from '../recommendations/recommendations.contracts.js';

export const onboardingFlowSchema = z.enum(['quick', 'detailed', 'demo']);
export const onboardingStatusSchema = z.enum(['not_started', 'in_progress', 'completed', 'skipped']);
export const onboardingSchema = z.strictObject({
    flow: onboardingFlowSchema.nullable(),
    status: onboardingStatusSchema,
    step: z.number().int().min(0).max(7),
    totalSteps: z.number().int().min(0).max(7),
    version: z.number().int().positive(),
});
export const onboardingUpdateSchema = z
    .strictObject({
        flow: onboardingFlowSchema.nullable(),
        status: onboardingStatusSchema,
        step: z.number().int().min(0).max(7),
        expectedVersion: z.number().int().positive(),
        idempotencyKey: z.uuid(),
    })
    .superRefine((value, context) => {
        const total = value.flow === 'quick' ? 3 : value.flow === 'detailed' ? 5 : value.flow === 'demo' ? 7 : 0;
        if (value.status === 'in_progress' && (!value.flow || value.step < 1 || value.step > total))
            context.addIssue({ code: 'custom', path: ['step'], message: 'Шаг не входит в выбранный сценарий' });
        if (value.status === 'completed' && (!value.flow || value.step !== total))
            context.addIssue({ code: 'custom', path: ['step'], message: 'Завершите последний шаг сценария' });
        if (value.status === 'skipped' && value.step !== 0)
            context.addIssue({ code: 'custom', path: ['step'], message: 'Пропущенный сценарий не содержит шага' });
    });

const equipmentAvailabilitySchema = z.enum(['yes', 'no', 'unknown']);
export const preferencesSchema = z.strictObject({
    diets: z.array(z.string().min(1).max(50)).max(20),
    allergens: z.array(z.string().min(1).max(50)).max(30),
    dislikes: z.array(z.string().min(1).max(100)).max(50),
    allergenMode: z.enum(['warn', 'hide']),
    equipment: z.record(z.string().min(1).max(50), equipmentAvailabilitySchema),
    goals: z.array(z.string().min(1).max(50)).max(20),
    version: z.number().int().positive(),
});
export const preferencesUpdateSchema = preferencesSchema
    .omit({ version: true })
    .extend({ expectedVersion: z.number().int().positive(), idempotencyKey: z.uuid() })
    .strict();
export const preferencesCatalogSchema = z.strictObject({
    diets: z.array(z.strictObject({ code: z.string(), name: z.string() })),
    allergens: z.array(z.strictObject({ code: z.string(), name: z.string() })),
    equipment: z.array(z.strictObject({ code: z.string(), name: z.string() })),
    goals: z.array(z.strictObject({ code: z.string(), name: z.string() })),
});
export const personalizationSchema = z.strictObject({
    onboarding: onboardingSchema,
    preferences: preferencesSchema,
    catalog: preferencesCatalogSchema,
});
export const homeSchema = z.strictObject({
    recommendations: z.array(recipeRecommendationSchema).max(3),
    expiring: z
        .array(z.strictObject({ id: z.uuid(), name: z.string(), expiryOn: z.iso.date(), daysLeft: z.number().int() }))
        .max(3),
    plan: z
        .array(z.strictObject({ id: z.uuid(), date: z.iso.date(), meal: z.string(), title: z.string().nullable() }))
        .max(6),
    activeShoppingLists: z.number().int().nonnegative(),
    inventoryCount: z.number().int().nonnegative(),
    onboarding: onboardingSchema,
});

export const preferenceCatalog = preferencesCatalogSchema.parse({
    diets: [
        { code: 'balanced', name: 'Сбалансированное' },
        { code: 'mediterranean', name: 'Средиземноморское' },
        { code: 'vegetarian', name: 'Вегетарианское' },
        { code: 'vegan', name: 'Веганское' },
        { code: 'low_carb', name: 'Низкоуглеводное' },
        { code: 'spicy', name: 'Острые блюда' },
    ],
    allergens: [
        { code: 'peanut', name: 'Арахис' },
        { code: 'milk', name: 'Молоко' },
        { code: 'egg', name: 'Яйца' },
        { code: 'gluten', name: 'Глютен' },
        { code: 'fish', name: 'Рыба' },
        { code: 'shellfish', name: 'Моллюски' },
        { code: 'soy', name: 'Соя' },
        { code: 'tree_nuts', name: 'Орехи' },
    ],
    equipment: [
        { code: 'oven', name: 'Духовка' },
        { code: 'hob', name: 'Плита' },
        { code: 'blender', name: 'Блендер' },
        { code: 'microwave', name: 'Микроволновка' },
        { code: 'multicooker', name: 'Мультиварка' },
        { code: 'grill', name: 'Гриль' },
    ],
    goals: [
        { code: 'quick', name: 'Быстрее готовить' },
        { code: 'less_waste', name: 'Меньше отходов' },
        { code: 'variety', name: 'Больше разнообразия' },
        { code: 'planning', name: 'Планировать заранее' },
    ],
});
