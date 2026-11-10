import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    AiV2PreviewPolicyError,
    aiV2TaskContractColumns,
    aiV2TaskPreviewSnapshot,
    prepareAiV2Preview,
    type AiV2PreviewEnvironment,
} from '../src/modules/ai/public.js';

const previewId = '018f47a0-34a7-7b8d-9c10-111111111111';
const sourceId = '018f47a0-34a7-7b8d-9c10-222222222222';
const now = new Date('2026-11-09T10:00:00.000Z');
const environment = (overrides: Partial<AiV2PreviewEnvironment> = {}): AiV2PreviewEnvironment => ({
    plan: 'free',
    offeredSources: [{ id: sourceId, label: 'Личные запасы', itemCount: 4, truncated: false }],
    readyProviderProfileVersions: new Set(),
    sourceSnapshotHash: 'a'.repeat(64),
    now,
    previewId,
    ...overrides,
});

void test('backend preview costs zero and does not depend on provider readiness', () => {
    const result = prepareAiV2Preview(
        {
            task: 'recipe_from_stock',
            mode: 'select_existing',
            input: { inventoryScope: 'personal' },
            context: { sourceIds: [sourceId] },
        },
        environment(),
    );
    assert.equal(result.preview.route, 'backend');
    assert.equal(result.preview.cost, 0);
    assert.equal(result.frozen.providerProfileVersion, null);
    assert.equal(result.frozen.providerCostCeilingMinor, 0);
    assert.equal(result.frozen.contextPolicyVersion, 'ai-context-policy-v2');
    assert.match(result.frozen.requestHash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(aiV2TaskContractColumns(result.frozen), {
        contract_version: 2,
        task_code: 'recipe_from_stock',
        task_mode: 'select_existing',
        execution_route: 'backend',
        task_policy_version: 'ai-task-policy-v4',
        context_policy_version: 'ai-context-policy-v2',
        routing_policy_version: 'ai-routing-policy-v1',
        price_policy_version: 'ai-price-policy-v1',
        result_schema_version: 'ai-result-contract-v2:recipe_from_stock:select_existing',
        safety_policy_version: 'ai-safety-policy-v1',
        cache_policy_version: 'ai-cache-policy-v1',
        provider_profile_version: null,
        provider_cost_ceiling_minor: 0,
        source_snapshot_hash: 'a'.repeat(64),
        accepted_cost: 0,
    });
    assert.deepEqual(aiV2TaskPreviewSnapshot(result), {
        contractVersion: 2,
        taskType: 'recipe_from_stock',
        task: 'recipe_from_stock',
        mode: 'select_existing',
        input: { inventoryScope: 'personal', maxResults: 5 },
        sourceIds: [sourceId],
        expiresAt: '2026-11-09T10:10:00.000Z',
    });
});

void test('provider preview freezes one profile and all policy versions without invoking a provider', () => {
    const result = prepareAiV2Preview(
        { task: 'culinary_question', mode: 'answer', input: { question: 'Как сварить киноа?' } },
        environment({ readyProviderProfileVersions: new Set(['yandex-alice-flash-economy-v1']) }),
    );
    assert.equal(result.preview.route, 'economy');
    assert.equal(result.preview.cost, 1);
    assert.equal(result.frozen.providerProfileVersion, 'yandex-alice-flash-economy-v1');
    assert.equal(result.frozen.routingPolicyVersion, 'ai-routing-policy-v1');
    assert.equal(result.frozen.pricePolicyVersion, 'ai-price-policy-v1');
    assert.equal(result.frozen.safetyPolicyVersion, 'ai-safety-policy-v1');
    assert.equal(result.frozen.cachePolicyVersion, 'ai-cache-policy-v1');
});

void test('preview rejects insufficient plan, unavailable profile and unoffered context', () => {
    const plusRequest = {
        task: 'shopping_list_generation',
        mode: 'from_meal_plan',
        input: {
            mealPlanId: previewId,
            version: 1,
            selection: { scope: 'private', view: 'week', date: '2026-11-09', timezone: 'Asia/Yekaterinburg' },
        },
    };
    assert.throws(
        () => prepareAiV2Preview(plusRequest, environment()),
        (error) => error instanceof AiV2PreviewPolicyError && error.code === 'plan_required',
    );
    assert.throws(
        () =>
            prepareAiV2Preview(
                { task: 'culinary_question', mode: 'answer', input: { question: 'Как сварить киноа?' } },
                environment(),
            ),
        (error) => error instanceof AiV2PreviewPolicyError && error.code === 'provider_profile_unavailable',
    );
    assert.throws(
        () =>
            prepareAiV2Preview(
                {
                    task: 'recipe_from_stock',
                    mode: 'select_existing',
                    input: { inventoryScope: 'personal' },
                    context: { sourceIds: ['018f47a0-34a7-7b8d-9c10-999999999999'] },
                },
                environment(),
            ),
        (error) => error instanceof AiV2PreviewPolicyError && error.code === 'source_not_offered',
    );
});

void test('the same task/mode keeps its route when a higher plan uses it', () => {
    const request = {
        task: 'recipe_from_stock',
        mode: 'select_existing',
        input: { inventoryScope: 'personal' },
    };
    assert.equal(prepareAiV2Preview(request, environment({ plan: 'free' })).preview.route, 'backend');
    assert.equal(prepareAiV2Preview(request, environment({ plan: 'pro' })).preview.route, 'backend');
});

void test('disabled task/mode is rejected before any runtime execution', () => {
    assert.throws(
        () => prepareAiV2Preview({ task: 'seasonal_analysis', mode: 'disabled', input: {} }, environment()),
        (error) => error instanceof AiV2PreviewPolicyError && error.code === 'task_mode_unavailable',
    );
});
