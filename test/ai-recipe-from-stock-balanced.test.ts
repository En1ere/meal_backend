import { MODULE_METADATA } from '@nestjs/common/constants.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AiCapabilityModule } from '../src/contexts/integrations/ai-capability.module.js';
import {
    AI_V2_RECIPE_FROM_STOCK_MAX_OUTPUT_TOKENS,
    AiProviderSimulator,
    AiV2RecipeFromStockExecutor,
    aiV2RecipeFromStockResultSchema,
    parseAiV2PreviewRequest,
    recipeFromStockProviderRequest,
    validateRecipeFromStockProviderResult,
    type AiV2PersistedReadOutcome,
    type AiV2RecipeFromStockShortlist,
    type ProviderSubmitOutcome,
} from '../src/modules/ai/public.js';

const shortlist: AiV2RecipeFromStockShortlist = {
    id: '00000000-0000-4000-8000-000000000501',
    inventoryScope: 'personal',
    scopeId: '00000000-0000-4000-8000-000000000502',
    goal: 'быстрый ужин',
    inventoryTruncated: false,
    stockItems: [
        {
            key: 1,
            ingredientId: '00000000-0000-4000-8000-000000000503',
            ingredientVersion: 3,
            name: 'Томат',
            quantityKnown: true,
            quantity: '500',
            unit: 'g',
        },
        {
            key: 2,
            ingredientId: '00000000-0000-4000-8000-000000000504',
            ingredientVersion: 2,
            name: 'Рис',
            quantityKnown: false,
            quantity: null,
            unit: 'g',
        },
    ],
    stockRefs: [
        { batchId: '00000000-0000-4000-8000-000000000505', batchVersion: 4 },
        { batchId: '00000000-0000-4000-8000-000000000506', batchVersion: 1 },
    ],
    candidates: [
        {
            recipeId: '00000000-0000-4000-8000-000000000507',
            recipeVersion: 2,
            revisionId: '00000000-0000-4000-8000-000000000508',
            revisionVersion: 1,
            title: 'Рис с овощами',
            requiredCount: 4,
            matchedRequiredCount: 2,
        },
    ],
};

void test('recipe-from-stock contracts bind generation to a backend shortlist', () => {
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'recipe_from_stock',
            mode: 'select_existing',
            input: { inventoryScope: 'personal', goal: 'быстрый ужин' },
        }),
        {
            task: 'recipe_from_stock',
            mode: 'select_existing',
            input: { inventoryScope: 'personal', goal: 'быстрый ужин', maxResults: 5 },
        },
    );
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'recipe_from_stock',
            mode: 'generate_new',
            input: { shortlistId: shortlist.id },
        }),
        {
            task: 'recipe_from_stock',
            mode: 'generate_new',
            input: { shortlistId: shortlist.id, servings: 2 },
        },
    );
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'recipe_from_stock',
            mode: 'generate_new',
            input: { shortlistId: shortlist.id, inventoryScope: 'personal', stock: [] },
        }),
    );
});

void test('balanced provider receives only bounded aggregate stock keys', () => {
    const request = recipeFromStockProviderRequest({
        clientRequestId: '00000000-0000-4000-8000-000000000509',
        profileVersion: 'yandexgpt-5.1-balanced-v1',
        shortlist,
        servings: 3,
    });
    assert.deepEqual(JSON.parse(request.input), {
        servings: 3,
        goal: 'быстрый ужин',
        stock: [
            { key: 1, name: 'Томат', quantity: '500', unit: 'g' },
            { key: 2, name: 'Рис', quantity: null, unit: 'g' },
        ],
    });
    assert.equal(request.profileVersion, 'yandexgpt-5.1-balanced-v1');
    assert.equal(request.maxOutputTokens, AI_V2_RECIPE_FROM_STOCK_MAX_OUTPUT_TOKENS);
    assert.doesNotMatch(request.input, /00000000|batch|location|history|ingredientId|scopeId|Version/u);
});

void test('backend maps frozen stock keys and rejects duplicates or excess quantity', () => {
    const raw = {
        schemaVersion: 'ai-result-contract-v2:recipe_from_stock:generate_new',
        title: 'Рис с томатами',
        ingredients: [
            { stockKey: 1, quantity: 300 },
            { stockKey: 2, quantity: 200 },
        ],
        steps: ['Подготовить продукты.', 'Приготовить до готовности.'],
    };
    assert.deepEqual(validateRecipeFromStockProviderResult(raw, 150, shortlist, 3), {
        schemaVersion: 'ai-result-contract-v2:recipe_from_stock:generate_new',
        title: 'Рис с томатами',
        servings: 3,
        ingredients: [
            { stockKey: 1, name: 'Томат', quantity: 300, unit: 'g' },
            { stockKey: 2, name: 'Рис', quantity: 200, unit: 'g' },
        ],
        steps: ['Подготовить продукты.', 'Приготовить до готовности.'],
        warningCodes: ['allergen_review_required', 'stock_quantity_unknown'],
        recoveryCode: 'review_recipe',
    });
    assert.equal(
        validateRecipeFromStockProviderResult(
            { ...raw, ingredients: [{ stockKey: 1, quantity: 600 }] },
            100,
            shortlist,
            3,
        ),
        null,
    );
    assert.equal(
        validateRecipeFromStockProviderResult(
            {
                ...raw,
                ingredients: [
                    { stockKey: 1, quantity: 100 },
                    { stockKey: 1, quantity: 100 },
                ],
            },
            100,
            shortlist,
            3,
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

void test('balanced simulator persists only a validated recipe preview', async () => {
    const store = new MemoryStore();
    const provider = new AiProviderSimulator();
    provider.enqueue({
        kind: 'success',
        result: {
            schemaVersion: 'ai-result-contract-v2:recipe_from_stock:generate_new',
            title: 'Томатный рис',
            ingredients: [
                { stockKey: 1, quantity: 200 },
                { stockKey: 2, quantity: 150 },
            ],
            steps: ['Соединить продукты и приготовить.'],
        },
    });
    const executor = new AiV2RecipeFromStockExecutor(store as never, provider);
    const submitted = await executor.submit({
        operationId: '00000000-0000-4000-8000-000000000510',
        dispatchVersion: 1,
        clientRequestId: '00000000-0000-4000-8000-000000000511',
        shortlist,
        servings: 2,
    });
    assert.ok(submitted);
    await executor.read({
        operationId: '00000000-0000-4000-8000-000000000510',
        dispatchVersion: submitted.nextVersion,
        shortlist,
        servings: 2,
    });
    assert.equal(store.readOutcome?.kind, 'succeeded');
    if (store.readOutcome?.kind === 'succeeded') {
        const result = aiV2RecipeFromStockResultSchema.parse(store.readOutcome.validatedResultSnapshot);
        assert.equal(result.title, 'Томатный рис');
        assert.equal(result.servings, 2);
    }
});

void test('selection stays SQL-only and generation has no public controller or domain write', () => {
    const source = readFileSync(
        fileURLToPath(new URL('../../src/modules/ai/ai-recipe-from-stock-internal.service.ts', import.meta.url)),
        'utf8',
    );
    assert.match(source, /meal\.inventory_batches/u);
    assert.match(source, /meal\.recipe_ingredients/u);
    assert.match(source, /matchedRequiredCount/u);
    assert.match(source, /matchedRequiredCount === candidate\.requiredCount/u);
    assert.match(source, /conversation\.user_id=\$\{userId\}::uuid/u);
    assert.match(source, /row\.version !== reference\.batchVersion/u);
    assert.match(source, /row\.version !== item\.ingredientVersion/u);
    assert.match(source, /simulator-balanced-v1/u);
    assert.match(source, /reserved_projection=reserved_projection\+2/u);
    assert.doesNotMatch(source, /insertInto\('recipes'\)|insert into meal\.recipes|inventory_movements/u);
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiCapabilityModule) ?? []) as unknown[];
    assert.equal(
        controllers.some((controller) => String(controller).includes('RecipeFromStock')),
        false,
    );
});
