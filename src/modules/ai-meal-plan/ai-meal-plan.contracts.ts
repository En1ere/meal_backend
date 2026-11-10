import { z } from 'zod';
import { aiV2RunRequestSchema, aiV2ShoppingListFromMealPlanInputSchema, type AiV2RunRequest } from '../ai/public.js';
import { planQuerySchema, planShoppingPreviewResultSchema } from '../meal-plan/public.js';

export const aiV2MealPlanPreviewRequestSchema = z.strictObject({
    task: z.literal('shopping_list_generation'),
    mode: z.literal('from_meal_plan'),
    input: aiV2ShoppingListFromMealPlanInputSchema,
});

export const aiV2MealPlanPreviewSchema = z.strictObject({
    id: z.uuid(),
    task: z.literal('shopping_list_generation'),
    mode: z.literal('from_meal_plan'),
    route: z.literal('backend'),
    cost: z.literal(0),
    expiresAt: z.iso.datetime(),
    policyVersion: z.literal('ai-task-policy-v4'),
});

export const aiV2ShoppingListFromMealPlanResultSchema = z.strictObject({
    schemaVersion: z.literal('ai-result-contract-v2:shopping_list_generation:from_meal_plan'),
    data: z.strictObject({
        mealPlanId: z.uuid(),
        version: z.number().int().positive(),
        selection: planQuerySchema,
        preview: planShoppingPreviewResultSchema,
    }),
    warningCodes: z.array(z.enum(['price_incomplete', 'quantity_check_required'])).max(2),
});

export const aiV2MealPlanOperationSchema = z.strictObject({
    item: z.strictObject({
        id: z.uuid(),
        taskId: z.uuid(),
        task: z.literal('shopping_list_generation'),
        mode: z.literal('from_meal_plan'),
        state: z.literal('succeeded'),
        result: aiV2ShoppingListFromMealPlanResultSchema,
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        version: z.number().int().positive(),
    }),
});

export { aiV2RunRequestSchema };
export type AiV2MealPlanPreviewRequest = z.infer<typeof aiV2MealPlanPreviewRequestSchema>;
export type AiV2MealPlanPreview = z.infer<typeof aiV2MealPlanPreviewSchema>;
export type AiV2ShoppingListFromMealPlanResult = z.infer<typeof aiV2ShoppingListFromMealPlanResultSchema>;
export type AiV2MealPlanOperation = z.infer<typeof aiV2MealPlanOperationSchema>;
export type AiV2MealPlanRunRequest = AiV2RunRequest;
