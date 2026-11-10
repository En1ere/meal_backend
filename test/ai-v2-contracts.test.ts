import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    AI_TASK_POLICY_V4,
    aiV2InputSchemas,
    aiV2PreviewSchema,
    aiV2ResultEnvelopeSchema,
    aiV2RunRequestSchema,
    aiV2ShoppingListFromMealPlanInputSchema,
    parseAiV2PreviewRequest,
} from '../src/modules/ai/public.js';
import {
    aiV2MealPlanOperationSchema,
    aiV2MealPlanPreviewRequestSchema,
    aiV2MealPlanPreviewSchema,
    aiV2ShoppingListFromMealPlanResultSchema,
} from '../src/modules/ai-meal-plan/public.js';

const previewId = '018f47a0-34a7-7b8d-9c10-111111111111';
const sourceId = '018f47a0-34a7-7b8d-9c10-222222222222';

void test('v2 has a strict input schema for every executable v4 task/mode', () => {
    assert.equal(Object.keys(aiV2InputSchemas).length, 27);
});

void test('v2 preview request parses only the selected task/mode input', () => {
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'meal_plan_generation',
            mode: 'replace_slot',
            input: {
                mealPlanId: previewId,
                slotId: sourceId,
            },
            context: { sourceIds: [sourceId] },
        }),
        {
            task: 'meal_plan_generation',
            mode: 'replace_slot',
            input: {
                mealPlanId: previewId,
                slotId: sourceId,
            },
            context: { sourceIds: [sourceId] },
        },
    );

    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'meal_plan_generation',
            mode: 'replace_slot',
            input: { mealPlanId: previewId, slotId: sourceId, provider: 'custom' },
        }),
    );
    assert.throws(
        () => parseAiV2PreviewRequest({ task: 'seasonal_analysis', mode: 'disabled', input: {} }),
        /not executable/u,
    );
});

void test('v2 preview and run contracts contain no provider or model selection', () => {
    assert.deepEqual(
        aiV2PreviewSchema.parse({
            id: previewId,
            task: 'shopping_list_generation',
            mode: 'from_meal_plan',
            route: 'backend',
            cost: 0,
            sources: [{ id: sourceId, label: 'План питания', itemCount: 1, truncated: false }],
            expiresAt: '2026-11-09T10:00:00.000Z',
            policyVersion: AI_TASK_POLICY_V4,
        }).cost,
        0,
    );
    assert.deepEqual(aiV2RunRequestSchema.parse({ previewId, idempotencyKey: sourceId }), {
        previewId,
        idempotencyKey: sourceId,
    });
    assert.throws(() => aiV2RunRequestSchema.parse({ previewId, idempotencyKey: sourceId, model: 'custom' }));
});

void test('v2 result envelope is minimal and rejects unversioned warnings or extra fields', () => {
    assert.deepEqual(
        aiV2ResultEnvelopeSchema.parse({
            schemaVersion: 'ai-result-contract-v2:shopping_list_generation:from_meal_plan',
            data: { itemCount: 4 },
            warningCodes: ['price_missing'],
        }),
        {
            schemaVersion: 'ai-result-contract-v2:shopping_list_generation:from_meal_plan',
            data: { itemCount: 4 },
            warningCodes: ['price_missing'],
        },
    );
    assert.throws(() =>
        aiV2ResultEnvelopeSchema.parse({
            schemaVersion: 'v2',
            data: {},
            warningCodes: ['Not valid'],
            debug: true,
        }),
    );
});

void test('shopping-list backend contracts bind an exact plan revision and reuse the domain preview', () => {
    const input = {
        mealPlanId: previewId,
        version: 3,
        selection: {
            scope: 'private' as const,
            view: 'week' as const,
            date: '2026-11-09',
            timezone: 'Asia/Yekaterinburg',
        },
    };
    assert.deepEqual(aiV2ShoppingListFromMealPlanInputSchema.parse(input), input);
    assert.throws(() => aiV2ShoppingListFromMealPlanInputSchema.parse({ mealPlanId: previewId }));

    const result = {
        schemaVersion: 'ai-result-contract-v2:shopping_list_generation:from_meal_plan' as const,
        data: {
            ...input,
            preview: {
                previewToken: sourceId,
                expiresAt: '2026-11-09T10:10:00.000Z',
                items: [],
                estimatedPriceMinor: 0,
                priceComplete: true,
            },
        },
        warningCodes: [],
    };
    assert.deepEqual(aiV2ShoppingListFromMealPlanResultSchema.parse(result), result);
    assert.throws(() =>
        aiV2ShoppingListFromMealPlanResultSchema.parse({
            ...result,
            warningCodes: ['provider_debug'],
        }),
    );

    const publicPreview = {
        id: previewId,
        task: 'shopping_list_generation' as const,
        mode: 'from_meal_plan' as const,
        route: 'backend' as const,
        cost: 0 as const,
        expiresAt: '2026-11-10T10:10:00.000Z',
        policyVersion: 'ai-task-policy-v4' as const,
    };
    assert.deepEqual(
        aiV2MealPlanPreviewRequestSchema.parse({
            task: publicPreview.task,
            mode: publicPreview.mode,
            input,
        }),
        { task: publicPreview.task, mode: publicPreview.mode, input },
    );
    assert.deepEqual(aiV2MealPlanPreviewSchema.parse(publicPreview), publicPreview);
    assert.throws(() => aiV2MealPlanPreviewSchema.parse({ ...publicPreview, sources: [] }));

    const publicOperation = {
        item: {
            id: sourceId,
            taskId: previewId,
            task: publicPreview.task,
            mode: publicPreview.mode,
            state: 'succeeded' as const,
            result,
            createdAt: '2026-11-10T10:00:00.000Z',
            updatedAt: '2026-11-10T10:00:00.000Z',
            expiresAt: '2026-12-10T10:00:00.000Z',
            version: 1,
        },
    };
    assert.deepEqual(aiV2MealPlanOperationSchema.parse(publicOperation), publicOperation);
    assert.throws(() =>
        aiV2MealPlanOperationSchema.parse({
            item: { ...publicOperation.item, providerCostState: 'none' },
        }),
    );
});
