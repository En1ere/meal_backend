import { MODULE_METADATA } from '@nestjs/common/constants.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AiCapabilityModule } from '../src/contexts/integrations/ai-capability.module.js';
import {
    AI_V2_PORTION_COST_MAX_INPUT_BYTES,
    AI_V2_PORTION_COST_MAX_OUTPUT_TOKENS,
    AiProviderSimulator,
    AiV2PortionCostCalculationExecutor,
    aiV2PortionCostExplainResultSchema,
    calculatePortionCostResult,
    estimatePortionCostMinor,
    parseAiV2PreviewRequest,
    portionCostProviderRequest,
    scalePortionCostQuantity,
    validatePortionCostProviderResult,
    type AiV2PersistedReadOutcome,
    type AiV2PortionCostSnapshot,
    type ProviderSubmitOutcome,
} from '../src/modules/ai/public.js';

const ids = {
    calculation: '00000000-0000-4000-8000-000000000d01',
    recipe: '00000000-0000-4000-8000-000000000d02',
    revision: '00000000-0000-4000-8000-000000000d03',
    publication: '00000000-0000-4000-8000-000000000d04',
    scope: '00000000-0000-4000-8000-000000000d05',
    line1: '00000000-0000-4000-8000-000000000d06',
    line2: '00000000-0000-4000-8000-000000000d07',
    ingredient: '00000000-0000-4000-8000-000000000d08',
    unit: '00000000-0000-4000-8000-000000000d09',
    price: '00000000-0000-4000-8000-000000000d10',
};

const lines: AiV2PortionCostSnapshot['source']['lines'] = [
    {
        lineId: ids.line1,
        lineVersion: 2,
        ingredientId: ids.ingredient,
        ingredientVersion: 3,
        unitId: ids.unit,
        unitVersion: 4,
        quantity: '1.5',
        price: {
            source: 'personal_latest',
            sourceId: ids.price,
            sourceVersion: 5,
            amountMinor: '499',
            perQuantity: '2',
            methodVersion: 'personal-observation-v1',
        },
        reason: 'priced',
    },
    {
        lineId: ids.line2,
        lineVersion: 1,
        ingredientId: ids.ingredient,
        ingredientVersion: 3,
        unitId: ids.unit,
        unitVersion: 4,
        quantity: '1',
        price: null,
        reason: 'price_unavailable',
    },
];

const result = calculatePortionCostResult({
    calculationId: ids.calculation,
    recipeId: ids.recipe,
    revisionId: ids.revision,
    servings: 3,
    lines,
});

const snapshot: AiV2PortionCostSnapshot = {
    calculationId: ids.calculation,
    algorithmVersion: 'portion-cost-fixed-point-v1',
    servings: 3,
    sourceHash: 'd'.repeat(64),
    source: {
        recipeId: ids.recipe,
        recipeVersion: 2,
        revisionId: ids.revision,
        revisionVersion: 3,
        publicationId: ids.publication,
        publicationVersion: 4,
        baseServings: 4,
        privateScopeId: ids.scope,
        privateScopeVersion: 1,
        lines,
    },
    result,
};

void test('portion cost contracts stay strict and default servings', () => {
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'portion_cost_calculation',
            mode: 'calculate',
            input: { recipeId: ids.recipe },
        }),
        {
            task: 'portion_cost_calculation',
            mode: 'calculate',
            input: { recipeId: ids.recipe, servings: 1, currency: 'RUB' },
        },
    );
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'portion_cost_calculation',
            mode: 'calculate',
            input: { recipeId: ids.recipe, servings: 1e-7 },
        }),
    );
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'portion_cost_calculation',
            mode: 'explain',
            input: { calculationId: ids.calculation, history: [] },
        }),
    );
});

void test('fixed-point calculation rounds once and missing prices never become zero', () => {
    assert.equal(scalePortionCostQuantity('2', 3, 4), '1.5');
    assert.equal(estimatePortionCostMinor('499', '1.5', '2'), 374n);
    assert.equal(estimatePortionCostMinor('250', '1.5', '1'), 375n);
    assert.equal(result.knownSubtotalMinor, 374);
    assert.equal(result.estimatedTotalMinor, null);
    assert.equal(result.completeness, 'partial');
    assert.deepEqual(result.reasonCounts, {
        unknownIngredient: 0,
        unknownQuantity: 0,
        unknownUnit: 0,
        priceUnavailable: 1,
    });
});

void test('economy provider receives only qualitative completeness in a bounded payload', () => {
    const request = portionCostProviderRequest({
        clientRequestId: '00000000-0000-4000-8000-000000000d11',
        profileVersion: 'yandex-alice-flash-economy-v1',
        snapshot,
        question: 'Что важно проверить?',
    });
    assert.deepEqual(JSON.parse(request.input), {
        coverage: 'partial',
        approximate: true,
        hasMissingPrices: true,
        missingReasons: ['priceUnavailable'],
        question: 'Что важно проверить?',
    });
    assert.equal(request.maxOutputTokens, AI_V2_PORTION_COST_MAX_OUTPUT_TOKENS);
    assert.ok(Buffer.byteLength(request.input, 'utf8') <= AI_V2_PORTION_COST_MAX_INPUT_BYTES);
    assert.doesNotMatch(
        request.input,
        /00000000|recipe|revision|publication|scope|subtotal|amount|quantity|lineCount/u,
    );
});

void test('backend rejects numeric, money-bearing, duplicate and unknown model claims', () => {
    const accepted = validatePortionCostProviderResult(
        {
            schemaVersion: 'ai-result-contract-v2:portion_cost_calculation:explain',
            explanation: 'Оценка приблизительная и покрывает только позиции с доступной ценой.',
            referencedFactKeys: ['coverage', 'approximation', 'missing_prices'],
        },
        100,
        snapshot,
    );
    assert.equal(accepted?.knownSubtotalMinor, 374);
    for (const explanation of ['Стоимость равна 374.', 'Цена сто рублей.', 'Проверьте 5 г.', 'https://x.test'])
        assert.equal(
            validatePortionCostProviderResult(
                {
                    schemaVersion: 'ai-result-contract-v2:portion_cost_calculation:explain',
                    explanation,
                    referencedFactKeys: ['coverage'],
                },
                100,
                snapshot,
            ),
            null,
        );
    assert.equal(
        validatePortionCostProviderResult(
            {
                schemaVersion: 'ai-result-contract-v2:portion_cost_calculation:explain',
                explanation: 'Оценка приблизительная.',
                referencedFactKeys: ['coverage', 'coverage'],
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

void test('economy simulator persists backend-frozen cost facts', async () => {
    const store = new MemoryStore();
    const provider = new AiProviderSimulator();
    provider.enqueue({
        kind: 'success',
        result: {
            schemaVersion: 'ai-result-contract-v2:portion_cost_calculation:explain',
            explanation: 'Оценка приблизительная и покрывает только позиции с доступной ценой.',
            referencedFactKeys: ['coverage', 'approximation', 'missing_prices'],
        },
    });
    const executor = new AiV2PortionCostCalculationExecutor(store as never, provider);
    const submitted = await executor.submit({
        operationId: '00000000-0000-4000-8000-000000000d12',
        dispatchVersion: 1,
        clientRequestId: '00000000-0000-4000-8000-000000000d13',
        snapshot,
    });
    assert.ok(submitted);
    await executor.read({
        operationId: '00000000-0000-4000-8000-000000000d12',
        dispatchVersion: submitted.nextVersion,
        snapshot,
    });
    assert.equal(store.readOutcome?.kind, 'succeeded');
    if (store.readOutcome?.kind === 'succeeded')
        assert.equal(
            aiV2PortionCostExplainResultSchema.parse(store.readOutcome.validatedResultSnapshot).knownSubtotalMinor,
            374,
        );
});

void test('persistence is Pro-only, exact-source-bound and calculate remains providerless', () => {
    const source = readFileSync(
        fileURLToPath(new URL('../../src/modules/ai/ai-portion-cost-calculation-internal.service.ts', import.meta.url)),
        'utf8',
    );
    assert.match(source, /entitlement\.plan !== 'pro'/u);
    assert.match(source, /publication\.version/u);
    assert.match(source, /variant[\s\S]*product[\s\S]*ingredient/u);
    assert.match(source, /personal_latest/u);
    assert.match(source, /system_median/u);
    assert.match(source, /kind<>'family_reserve'/u);
    assert.match(source, /estimated_cost_rub[\s\S]*1\.00000000/u);
    assert.match(source, /await this\.assertAccess\(tx, userId\);[\s\S]*const existing/u);
    assert.match(source, /financial_state[\s\S]*'none'/u);
    assert.match(source, /on conflict\(conversation_id,client_message_key\) do nothing/u);
    assert.doesNotMatch(source, /insertInto\('finance_|update finance\.|insertInto\('recipe_/u);
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiCapabilityModule) ?? []) as unknown[];
    assert.equal(
        controllers.some((controller) => String(controller).includes('PortionCostCalculation')),
        false,
    );
});
