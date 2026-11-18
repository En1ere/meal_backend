import { MODULE_METADATA } from '@nestjs/common/constants.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AiCapabilityModule } from '../src/contexts/integrations/ai-capability.module.js';
import {
    AI_V2_RECIPE_ADAPTATION_MAX_OUTPUT_TOKENS,
    AiProviderSimulator,
    AiV2RecipeAdaptationExecutor,
    aiV2RecipeAdaptationResultSchema,
    parseAiV2PreviewRequest,
    recipeAdaptationProviderRequest,
    scaleRecipeAdaptationIngredients,
    validateRecipeAdaptationProviderResult,
    type AiV2PersistedReadOutcome,
    type AiV2RecipeAdaptationSnapshot,
    type ProviderSubmitOutcome,
} from '../src/modules/ai/public.js';

const snapshot: AiV2RecipeAdaptationSnapshot = {
    id: '00000000-0000-4000-8000-000000000a01',
    recipeId: '00000000-0000-4000-8000-000000000a02',
    recipeVersion: 2,
    revisionId: '00000000-0000-4000-8000-000000000a03',
    revisionVersion: 4,
    publicationId: '00000000-0000-4000-8000-000000000a04',
    publicationVersion: 1,
    title: 'Овощное рагу',
    sourceServings: 2,
    servings: 4,
    allergenComplete: true,
    ingredients: [
        {
            key: 1,
            lineId: '00000000-0000-4000-8000-000000000a05',
            lineVersion: 3,
            name: 'Томат',
            quantity: '400',
            unit: 'g',
            optional: false,
        },
        {
            key: 2,
            lineId: '00000000-0000-4000-8000-000000000a06',
            lineVersion: 1,
            name: 'Соль',
            quantity: null,
            unit: null,
            optional: true,
        },
    ],
    steps: [
        {
            stepId: '00000000-0000-4000-8000-000000000a07',
            stepVersion: 1,
            position: 0,
            text: 'Нарежьте овощи и потушите.',
        },
    ],
};

void test('adaptation contracts bind scale to a revision and adapt to a frozen snapshot', () => {
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'recipe_adaptation',
            mode: 'scale',
            input: { recipeId: snapshot.recipeId, revisionId: snapshot.revisionId, servings: 4 },
        }),
        {
            task: 'recipe_adaptation',
            mode: 'scale',
            input: { recipeId: snapshot.recipeId, revisionId: snapshot.revisionId, servings: 4 },
        },
    );
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'recipe_adaptation',
            mode: 'adapt',
            input: { snapshotId: snapshot.id, instruction: 'сделай приготовление быстрее' },
        }),
        {
            task: 'recipe_adaptation',
            mode: 'adapt',
            input: { snapshotId: snapshot.id, instruction: 'сделай приготовление быстрее' },
        },
    );
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'recipe_adaptation',
            mode: 'adapt',
            input: { recipeId: snapshot.recipeId, instruction: 'сделай приготовление быстрее' },
        }),
    );
});

void test('backend scaling uses exact recipe decimal arithmetic', () => {
    const ingredients = scaleRecipeAdaptationIngredients(
        [
            {
                lineId: snapshot.ingredients[0]!.lineId,
                lineVersion: 1,
                name: 'Томат',
                quantity: '0.33333333',
                unit: 'kg',
                optional: false,
            },
        ],
        3,
        7,
    );
    assert.equal(ingredients[0]?.quantity, '0.77777777');
    assert.equal(ingredients[0]?.key, 1);
});

void test('balanced provider sees only ordinal recipe facts and the culinary instruction', () => {
    const request = recipeAdaptationProviderRequest({
        clientRequestId: '00000000-0000-4000-8000-000000000a08',
        profileVersion: 'yandexgpt-5.1-balanced-v1',
        snapshot,
        instruction: 'сделай приготовление быстрее',
    });
    assert.deepEqual(JSON.parse(request.input), {
        recipe: {
            title: 'Овощное рагу',
            servings: 4,
            ingredients: [
                { key: 1, name: 'Томат', quantity: '400', unit: 'g', optional: false },
                { key: 2, name: 'Соль', quantity: null, unit: null, optional: true },
            ],
            steps: ['Нарежьте овощи и потушите.'],
        },
        instruction: 'сделай приготовление быстрее',
    });
    assert.equal(request.maxOutputTokens, AI_V2_RECIPE_ADAPTATION_MAX_OUTPUT_TOKENS);
    assert.doesNotMatch(request.input, /00000000|lineId|revisionId|publicationId|history|profile/u);
});

void test('backend rejects new, missing, duplicate and invented-quantity ingredients', () => {
    const valid = {
        schemaVersion: 'ai-result-contract-v2:recipe_adaptation:adapt',
        title: 'Быстрое овощное рагу',
        ingredients: [
            { ingredientKey: 1, quantity: '380' },
            { ingredientKey: 2, quantity: null },
        ],
        steps: ['Нарежьте овощи мельче и потушите.'],
    };
    assert.ok(validateRecipeAdaptationProviderResult(valid, 300, snapshot));
    assert.equal(
        validateRecipeAdaptationProviderResult(
            { ...valid, ingredients: [{ ingredientKey: 1, quantity: '380' }] },
            300,
            snapshot,
        ),
        null,
    );
    assert.equal(
        validateRecipeAdaptationProviderResult(
            {
                ...valid,
                ingredients: [
                    { ingredientKey: 1, quantity: '380' },
                    { ingredientKey: 3, quantity: '1' },
                ],
            },
            300,
            snapshot,
        ),
        null,
    );
    assert.equal(
        validateRecipeAdaptationProviderResult(
            {
                ...valid,
                ingredients: [
                    { ingredientKey: 1, quantity: '380' },
                    { ingredientKey: 2, quantity: '1' },
                ],
            },
            300,
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

void test('balanced simulator persists only a backend-resolved recipe preview', async () => {
    const store = new MemoryStore();
    const provider = new AiProviderSimulator();
    provider.enqueue({
        kind: 'success',
        result: {
            schemaVersion: 'ai-result-contract-v2:recipe_adaptation:adapt',
            title: 'Быстрое овощное рагу',
            ingredients: [
                { ingredientKey: 1, quantity: '380' },
                { ingredientKey: 2, quantity: null },
            ],
            steps: ['Нарежьте овощи мельче и потушите.'],
        },
    });
    const executor = new AiV2RecipeAdaptationExecutor(store as never, provider);
    const submitted = await executor.submit({
        operationId: '00000000-0000-4000-8000-000000000a09',
        dispatchVersion: 1,
        clientRequestId: '00000000-0000-4000-8000-000000000a10',
        snapshot,
        instruction: 'сделай приготовление быстрее',
    });
    assert.ok(submitted);
    await executor.read({
        operationId: '00000000-0000-4000-8000-000000000a09',
        dispatchVersion: submitted.nextVersion,
        snapshot,
    });
    assert.equal(store.readOutcome?.kind, 'succeeded');
    if (store.readOutcome?.kind === 'succeeded')
        assert.equal(
            aiV2RecipeAdaptationResultSchema.parse(store.readOutcome.validatedResultSnapshot).ingredients[0]?.name,
            'Томат',
        );
});

void test('adaptation stays internal, version-bound and has no recipe write path', () => {
    const source = readFileSync(
        fileURLToPath(new URL('../../src/modules/ai/ai-recipe-adaptation-internal.service.ts', import.meta.url)),
        'utf8',
    );
    assert.match(source, /current_publication\.published_at desc,current_publication\.id desc/u);
    assert.match(source, /line\.version::integer "lineVersion"/u);
    assert.match(source, /stepVersion/u);
    assert.match(source, /allergensComplete/u);
    assert.match(source, /classifyCulinaryQuestion/u);
    assert.match(source, /simulator-balanced-v1/u);
    assert.doesNotMatch(source, /insertInto\('recipes'\)|insert into meal\.recipes|update meal\.recipe_/u);
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiCapabilityModule) ?? []) as unknown[];
    assert.equal(
        controllers.some((controller) => String(controller).includes('RecipeAdaptation')),
        false,
    );
});
