import { MODULE_METADATA } from '@nestjs/common/constants.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AiCapabilityModule } from '../src/contexts/integrations/ai-capability.module.js';
import {
    AI_V2_NUTRITION_MAX_INPUT_BYTES,
    AI_V2_NUTRITION_MAX_OUTPUT_TOKENS,
    AiProviderSimulator,
    AiV2NutritionCalculationExecutor,
    aiV2NutritionExplainResultSchema,
    calculateNutritionValues,
    canonicalNutritionSnapshot,
    nutritionProviderRequest,
    parseAiV2PreviewRequest,
    scaleNutritionDecimal,
    validateNutritionProviderResult,
    type AiV2NutritionSnapshot,
    type AiV2PersistedReadOutcome,
    type ProviderSubmitOutcome,
} from '../src/modules/ai/public.js';

const snapshot: AiV2NutritionSnapshot = {
    calculationId: '00000000-0000-4000-8000-000000000c01',
    algorithmVersion: 'nutrition-snapshot-scaling-v1',
    servings: 1.5,
    sourceHash: 'c'.repeat(64),
    source: {
        recipeId: '00000000-0000-4000-8000-000000000c02',
        recipeVersion: 2,
        revisionId: '00000000-0000-4000-8000-000000000c03',
        revisionVersion: 3,
        publicationId: '00000000-0000-4000-8000-000000000c04',
        publicationVersion: 4,
        baseServings: 4,
        nutrition: { kcal: '100', protein: '8', fat: null, carbs: '16', basis: 'recipe' },
        sourceStatus: 'calculated',
    },
    values: { energyKcal: '37.5', proteinG: '3', fatG: null, carbohydrateG: '6' },
    completeness: 'partial',
    warningCodes: ['nutrition_partially_known'],
};

void test('nutrition contracts stay strict and reject noisy servings', () => {
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'nutrition_calculation',
            mode: 'calculate',
            input: { recipeId: snapshot.source.recipeId },
        }),
        {
            task: 'nutrition_calculation',
            mode: 'calculate',
            input: { recipeId: snapshot.source.recipeId, servings: 1 },
        },
    );
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'nutrition_calculation',
            mode: 'calculate',
            input: { recipeId: snapshot.source.recipeId, servings: 1e-7 },
        }),
    );
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'nutrition_calculation',
            mode: 'explain',
            input: { calculationId: snapshot.calculationId, history: [] },
        }),
    );
});

void test('fixed-point scaling preserves exact values and null is never zero', () => {
    assert.equal(scaleNutritionDecimal('100', 1.5, 4, 'recipe'), '37.5');
    assert.equal(scaleNutritionDecimal('10.12345678', 2, 4, 'recipe'), '5.06172839');
    assert.equal(scaleNutritionDecimal('12.5', 3, 4, 'serving'), '37.5');
    assert.equal(scaleNutritionDecimal(null, 50, 1, 'serving'), null);
    assert.deepEqual(
        calculateNutritionValues({
            nutrition: snapshot.source.nutrition,
            sourceStatus: 'calculated',
            servings: 1.5,
            baseServings: 4,
        }),
        {
            values: snapshot.values,
            completeness: 'partial',
            warningCodes: ['nutrition_partially_known'],
        },
    );
});

void test('nutrition snapshots are canonicalized and fail closed on extra fields', () => {
    assert.deepEqual(
        canonicalNutritionSnapshot({ kcal: '100', protein: null, fat: null, carbs: null, basis: 'recipe' }),
        {
            nutrition: { kcal: '100', protein: null, fat: null, carbs: null, basis: 'recipe' },
            sourceStatus: 'calculated',
        },
    );
    assert.deepEqual(
        canonicalNutritionSnapshot({
            status: 'base-unadjusted',
            base: { kcal: '100', protein: null, fat: null, carbs: null, basis: 'recipe' },
            uncoveredIngredientIds: ['missing'],
        }),
        {
            nutrition: { kcal: '100', protein: null, fat: null, carbs: null, basis: 'recipe' },
            sourceStatus: 'base-unadjusted',
        },
    );
    assert.deepEqual(
        canonicalNutritionSnapshot({
            kcal: '100',
            protein: null,
            fat: null,
            carbs: null,
            basis: 'recipe',
            privateNote: 'do not hash or expose',
        }),
        { nutrition: null, sourceStatus: 'unavailable' },
    );
});

void test('economy provider receives only frozen facts in a bounded payload', () => {
    const request = nutritionProviderRequest({
        clientRequestId: '00000000-0000-4000-8000-000000000c05',
        profileVersion: 'yandex-alice-flash-economy-v1',
        snapshot,
        question: 'Что здесь важно?',
    });
    assert.deepEqual(JSON.parse(request.input), {
        facts: [
            { key: 'energy_kcal', value: '37.5', unit: 'kcal' },
            { key: 'protein_g', value: '3', unit: 'g' },
            { key: 'carbohydrate_g', value: '6', unit: 'g' },
        ],
        completeness: 'partial',
        missingKeys: ['fat_g'],
        question: 'Что здесь важно?',
    });
    assert.equal(request.maxOutputTokens, AI_V2_NUTRITION_MAX_OUTPUT_TOKENS);
    assert.ok(Buffer.byteLength(request.input, 'utf8') <= AI_V2_NUTRITION_MAX_INPUT_BYTES);
    assert.doesNotMatch(request.input, /00000000|recipeId|revisionId|publicationId|sourceHash|profile|history|target/u);
});

void test('backend rejects numeric, unit-bearing, duplicate and unknown model claims', () => {
    const valid = validateNutritionProviderResult(
        {
            schemaVersion: 'ai-result-contract-v2:nutrition_calculation:explain',
            explanation: 'Расчёт показывает доступные показатели, а отсутствующее значение требует проверки источника.',
            referencedFactKeys: ['energy_kcal', 'fat_g'],
        },
        100,
        snapshot,
    );
    assert.equal(valid, null, 'missing facts cannot be referenced');
    const accepted = validateNutritionProviderResult(
        {
            schemaVersion: 'ai-result-contract-v2:nutrition_calculation:explain',
            explanation: 'Доступные показатели согласованы, а отсутствующее значение требует проверки источника.',
            referencedFactKeys: ['energy_kcal', 'protein_g'],
        },
        100,
        snapshot,
    );
    assert.deepEqual(accepted?.values, snapshot.values);
    for (const explanation of [
        'Значение равно 37.5.',
        'Указано сто калорий.',
        'Проверьте 5 г белка.',
        'https://x.test',
    ])
        assert.equal(
            validateNutritionProviderResult(
                {
                    schemaVersion: 'ai-result-contract-v2:nutrition_calculation:explain',
                    explanation,
                    referencedFactKeys: ['protein_g'],
                },
                100,
                snapshot,
            ),
            null,
        );
});

class MemoryStore {
    readOutcome: AiV2PersistedReadOutcome | null = null;
    providerResponseId: string | null = null;
    async claimSubmit(input: { expectedVersion: number }) {
        await Promise.resolve();
        return { version: input.expectedVersion + 1 };
    }
    async recordSubmit(input: { outcome: ProviderSubmitOutcome }) {
        await Promise.resolve();
        this.providerResponseId = input.outcome.kind === 'accepted' ? input.outcome.providerResponseId : null;
    }
    async claimRead(input: { expectedVersion: number }) {
        await Promise.resolve();
        return { version: input.expectedVersion + 1, providerResponseId: this.providerResponseId };
    }
    async recordRead(input: { outcome: AiV2PersistedReadOutcome }) {
        await Promise.resolve();
        this.readOutcome = input.outcome;
    }
}

void test('economy simulator persists only backend-frozen nutrition facts', async () => {
    const store = new MemoryStore();
    const provider = new AiProviderSimulator();
    provider.enqueue({
        kind: 'success',
        result: {
            schemaVersion: 'ai-result-contract-v2:nutrition_calculation:explain',
            explanation: 'Доступные показатели согласованы, а отсутствующее значение требует проверки источника.',
            referencedFactKeys: ['energy_kcal', 'protein_g'],
        },
    });
    const executor = new AiV2NutritionCalculationExecutor(store as never, provider);
    const submitted = await executor.submit({
        operationId: '00000000-0000-4000-8000-000000000c06',
        dispatchVersion: 1,
        clientRequestId: '00000000-0000-4000-8000-000000000c07',
        snapshot,
    });
    assert.ok(submitted);
    await executor.read({
        operationId: '00000000-0000-4000-8000-000000000c06',
        dispatchVersion: submitted.nextVersion,
        snapshot,
    });
    assert.equal(store.readOutcome?.kind, 'succeeded');
    if (store.readOutcome?.kind === 'succeeded')
        assert.deepEqual(
            aiV2NutritionExplainResultSchema.parse(store.readOutcome.validatedResultSnapshot).values,
            snapshot.values,
        );
});

void test('persistence is Pro-only, version-bound and keeps calculate providerless', () => {
    const source = readFileSync(
        fileURLToPath(new URL('../../src/modules/ai/ai-nutrition-calculation-internal.service.ts', import.meta.url)),
        'utf8',
    );
    assert.match(source, /entitlement\.plan !== 'pro'/u);
    assert.match(source, /revision\.nutrition_snapshot/u);
    assert.match(source, /publication\.version/u);
    assert.match(source, /kind<>'family_reserve'/u);
    assert.match(source, /estimated_cost_rub[\s\S]*1\.00000000/u);
    assert.match(source, /await this\.assertAccess\(tx, userId\);[\s\S]*const existing/u);
    assert.match(source, /financial_state[\s\S]*'none'/u);
    assert.match(source, /on conflict\(conversation_id,client_message_key\) do nothing/u);
    assert.doesNotMatch(source, /insertInto\('nutrition_|update meal\.nutrition_|insertInto\('recipe_/u);
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiCapabilityModule) ?? []) as unknown[];
    assert.equal(
        controllers.some((controller) => String(controller).includes('NutritionCalculation')),
        false,
    );
});
