import { MODULE_METADATA } from '@nestjs/common/constants.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AiMealPlanCapabilityModule } from '../src/contexts/integrations/ai-meal-plan-capability.module.js';
import { aiV2ShoppingListFromRecipesInputSchema } from '../src/modules/ai/public.js';
import { aiV2ShoppingListFromRecipesResultSchema } from '../src/modules/ai-meal-plan/public.js';
import { aggregateRecipeShoppingLines, type RecipeShoppingSourceLine } from '../src/modules/shopping/public.js';

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

const line = (overrides: Partial<RecipeShoppingSourceLine> = {}): RecipeShoppingSourceLine => ({
    lineId: uuid(1),
    position: 0,
    name: 'Мука',
    quantity: '500',
    ingredientId: uuid(10),
    variantId: null,
    productId: null,
    sourceRecipeId: null,
    unitId: uuid(20),
    unit: 'g',
    unitDimension: 'mass',
    unitFactor: '1',
    unitApproximate: false,
    baseUnit: 'g',
    revisionId: uuid(30),
    portions: 4,
    ...overrides,
});

void test('recipe shopping input is minimal, bounded and rejects duplicate recipes', () => {
    assert.deepEqual(aiV2ShoppingListFromRecipesInputSchema.parse({ recipeIds: [uuid(1), uuid(2)] }), {
        recipeIds: [uuid(1), uuid(2)],
    });
    assert.throws(() => aiV2ShoppingListFromRecipesInputSchema.parse({ recipeIds: [uuid(1), uuid(1)] }));
    assert.throws(() => aiV2ShoppingListFromRecipesInputSchema.parse({ recipeIds: [uuid(1)], servings: 2 }));
    assert.throws(() => aiV2ShoppingListFromRecipesInputSchema.parse({ recipeIds: [] }));
    assert.throws(() =>
        aiV2ShoppingListFromRecipesInputSchema.parse({
            recipeIds: Array.from({ length: 21 }, (_, index) => uuid(index + 1)),
        }),
    );
});

void test('recipe aggregation converts only exact compatible units and preserves origins', () => {
    const result = aggregateRecipeShoppingLines([
        line(),
        line({
            lineId: uuid(2),
            quantity: '1',
            unitId: uuid(21),
            unit: 'kg',
            unitFactor: '1000',
            revisionId: uuid(31),
            portions: 2,
        }),
    ]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.quantity, '1500');
    assert.equal(result.items[0]?.unit, 'g');
    assert.deepEqual(result.items[0]?.recipeOrigin, [
        { revisionId: uuid(30), portions: 4, quantity: '500' },
        { revisionId: uuid(31), portions: 2, quantity: '1000' },
    ]);
    assert.equal(result.quantityCheckRequired, false);
    assert.equal(result.incompatibleUnitsPreserved, false);
});

void test('unknown quantities and incompatible units stay explicit instead of being invented', () => {
    const result = aggregateRecipeShoppingLines([
        line({ quantity: null }),
        line({
            lineId: uuid(2),
            unitId: uuid(22),
            unit: 'pcs',
            unitDimension: 'count',
            unitFactor: '1',
            baseUnit: 'pcs',
        }),
    ]);
    assert.equal(result.items.length, 2);
    assert.equal(result.items.find((item) => item.unit === 'g')?.quantity, null);
    assert.equal(result.items.find((item) => item.unit === 'g')?.needsQuantityCheck, true);
    assert.equal(result.quantityCheckRequired, true);
    assert.equal(result.incompatibleUnitsPreserved, true);
});

void test('different catalog identities never merge only because names match', () => {
    const result = aggregateRecipeShoppingLines([
        line({ productId: uuid(40), ingredientId: uuid(10) }),
        line({ lineId: uuid(2), productId: uuid(41), ingredientId: uuid(10) }),
    ]);
    assert.equal(result.items.length, 2);
});

void test('recipe shopping result is a minimal domain preview', () => {
    const aggregated = aggregateRecipeShoppingLines([line()]);
    const result = aiV2ShoppingListFromRecipesResultSchema.parse({
        schemaVersion: 'ai-result-contract-v2:shopping_list_generation:from_recipes',
        data: { recipeIds: [uuid(100)], items: aggregated.items },
        warningCodes: [],
    });
    assert.equal(result.data.items[0]?.estimatedPriceMinor, null);
    assert.doesNotMatch(JSON.stringify(result), /provider|model|prompt|inventoryScope|financial/u);
});

void test('recipe shopping execution is version-bound, providerless and creates no shopping domain rows', () => {
    const service = readFileSync(
        fileURLToPath(
            new URL('../../src/modules/ai-meal-plan/ai-shopping-recipes-backend.service.ts', import.meta.url),
        ),
        'utf8',
    );
    const http = readFileSync(
        fileURLToPath(new URL('../../src/modules/ai-meal-plan/ai-v2.http.ts', import.meta.url)),
        'utf8',
    );
    assert.match(service, /publication\.version::integer "publicationVersion"/u);
    assert.match(service, /line\.version::integer "lineVersion"/u);
    assert.match(service, /unit\.version::integer "unitVersion"/u);
    assert.match(service, /source\.sourceSnapshotHash !== snapshot\.sourceEvidence\.sourceSnapshotHash/u);
    assert.match(service, /and not line\.optional/u);
    assert.match(service, /0,0,'completed'/u);
    assert.match(service, /'succeeded','none'/u);
    assert.match(service, /'none',null/u);
    assert.doesNotMatch(service, /AiProvider|ai_provider_dispatches|ai_buckets|ai_ledger|inventory_batches/u);
    assert.doesNotMatch(service, /insert into meal\.shopping_lists|insert into meal\.shopping_items/u);
    assert.doesNotMatch(http, /from_recipes/u);
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiMealPlanCapabilityModule) ??
        []) as unknown[];
    assert.equal(controllers.length, 1);
});
