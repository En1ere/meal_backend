import { MODULE_METADATA } from '@nestjs/common/constants.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AiCapabilityModule } from '../src/contexts/integrations/ai-capability.module.js';
import {
    AI_V2_BEVERAGE_PAIRING_MAX_OUTPUT_TOKENS,
    AiProviderSimulator,
    AiV2BeveragePairingExecutor,
    aiV2BeveragePairingResultSchema,
    beveragePairingProviderRequest,
    containsAlcoholMarker,
    parseAiV2PreviewRequest,
    validateBeveragePairingProviderResult,
    type AiV2BeveragePairingShortlist,
    type AiV2PersistedReadOutcome,
    type ProviderSubmitOutcome,
} from '../src/modules/ai/public.js';

const shortlist: AiV2BeveragePairingShortlist = {
    id: '00000000-0000-4000-8000-000000000901',
    recipeId: '00000000-0000-4000-8000-000000000902',
    recipeVersion: 2,
    revisionId: '00000000-0000-4000-8000-000000000903',
    revisionVersion: 4,
    publicationId: '00000000-0000-4000-8000-000000000904',
    publicationVersion: 1,
    recipeTitle: 'Овощное рагу',
    recipeCategory: 'Ужин',
    recipeTags: ['vegetarian'],
    recipeIngredients: ['Томат', 'Кабачок'],
    alcoholBlocked: false,
    candidates: [
        {
            key: 1,
            variantId: '00000000-0000-4000-8000-000000000905',
            variantVersion: 3,
            ingredientId: '00000000-0000-4000-8000-000000000906',
            ingredientVersion: 2,
            categoryId: '00000000-0000-4000-8000-000000000907',
            categoryVersion: 1,
            name: 'Холодный чай',
        },
        {
            key: 2,
            variantId: '00000000-0000-4000-8000-000000000908',
            variantVersion: 1,
            ingredientId: '00000000-0000-4000-8000-000000000909',
            ingredientVersion: 5,
            categoryId: '00000000-0000-4000-8000-000000000907',
            categoryVersion: 1,
            name: 'Минеральная вода',
        },
    ],
};

void test('beverage pairing contract binds custom selection to a frozen shortlist', () => {
    assert.deepEqual(
        parseAiV2PreviewRequest({ task: 'beverage_pairing', mode: 'catalog', input: { recipeId: shortlist.recipeId } }),
        { task: 'beverage_pairing', mode: 'catalog', input: { recipeId: shortlist.recipeId } },
    );
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'beverage_pairing',
            mode: 'custom',
            input: { shortlistId: shortlist.id, preferences: 'что-нибудь лёгкое' },
        }),
        {
            task: 'beverage_pairing',
            mode: 'custom',
            input: { shortlistId: shortlist.id, preferences: 'что-нибудь лёгкое' },
        },
    );
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'beverage_pairing',
            mode: 'custom',
            input: { shortlistId: shortlist.id, recipeId: shortlist.recipeId, candidates: [] },
        }),
    );
});

void test('provider receives recipe facts and ordinal names without catalog identity', () => {
    const request = beveragePairingProviderRequest({
        clientRequestId: '00000000-0000-4000-8000-000000000910',
        profileVersion: 'yandex-alice-flash-economy-v1',
        shortlist,
        preferences: 'что-нибудь лёгкое',
    });
    assert.deepEqual(JSON.parse(request.input), {
        recipe: {
            title: 'Овощное рагу',
            category: 'Ужин',
            tags: ['vegetarian'],
            ingredients: ['Томат', 'Кабачок'],
        },
        candidates: [
            { key: 1, name: 'Холодный чай' },
            { key: 2, name: 'Минеральная вода' },
        ],
        preferences: 'что-нибудь лёгкое',
    });
    assert.equal(request.maxOutputTokens, AI_V2_BEVERAGE_PAIRING_MAX_OUTPUT_TOKENS);
    assert.doesNotMatch(request.input, /00000000|variantId|ingredientId|categoryId|Version|history|profile/u);
});

void test('backend permits only frozen non-alcoholic keys and rejects alcohol text', () => {
    const selected = validateBeveragePairingProviderResult(
        {
            schemaVersion: 'ai-result-contract-v2:beverage_pairing:custom',
            selectedKey: 2,
            explanation: 'Нейтральный вкус дополнит овощи.',
        },
        80,
        shortlist,
    );
    assert.deepEqual(selected, {
        schemaVersion: 'ai-result-contract-v2:beverage_pairing:custom',
        selectedCandidateId: shortlist.candidates[1]?.variantId,
        selectedName: 'Минеральная вода',
        explanation: 'Нейтральный вкус дополнит овощи.',
        warningCodes: [],
        recoveryCode: 'review_pairing',
    });
    assert.equal(
        validateBeveragePairingProviderResult(
            {
                schemaVersion: 'ai-result-contract-v2:beverage_pairing:custom',
                selectedKey: 8,
                explanation: 'Подходит.',
            },
            50,
            shortlist,
        ),
        null,
    );
    assert.equal(
        validateBeveragePairingProviderResult(
            {
                schemaVersion: 'ai-result-contract-v2:beverage_pairing:custom',
                selectedKey: 1,
                explanation: 'Можно добавить немного вина.',
            },
            50,
            shortlist,
        ),
        null,
    );
    assert.equal(containsAlcoholMarker('пиво'), true);
    assert.equal(containsAlcoholMarker('травяной чай'), false);
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

void test('economy simulator persists only a backend-resolved beverage candidate', async () => {
    const store = new MemoryStore();
    const provider = new AiProviderSimulator();
    provider.enqueue({
        kind: 'success',
        result: {
            schemaVersion: 'ai-result-contract-v2:beverage_pairing:custom',
            selectedKey: 1,
            explanation: 'Свежий вкус поддержит овощи.',
        },
    });
    const executor = new AiV2BeveragePairingExecutor(store as never, provider);
    const submitted = await executor.submit({
        operationId: '00000000-0000-4000-8000-000000000911',
        dispatchVersion: 1,
        clientRequestId: '00000000-0000-4000-8000-000000000912',
        shortlist,
    });
    assert.ok(submitted);
    await executor.read({
        operationId: '00000000-0000-4000-8000-000000000911',
        dispatchVersion: submitted.nextVersion,
        shortlist,
    });
    assert.equal(store.readOutcome?.kind, 'succeeded');
    if (store.readOutcome?.kind === 'succeeded')
        assert.equal(
            aiV2BeveragePairingResultSchema.parse(store.readOutcome.validatedResultSnapshot).selectedName,
            'Холодный чай',
        );
});

void test('catalog is explicit-flag SQL-only and exposes no public or domain mutation path', () => {
    const source = readFileSync(
        fileURLToPath(new URL('../../src/modules/ai/ai-beverage-pairing-internal.service.ts', import.meta.url)),
        'utf8',
    );
    assert.match(source, /attributes->'beverage'='true'::jsonb/u);
    assert.match(source, /attributes->'alcoholFree'='true'::jsonb/u);
    assert.match(source, /alcoholByVolume/u);
    assert.match(source, /conversation\.user_id=\$\{userId\}::uuid/u);
    assert.match(source, /simulator-economy-v1/u);
    assert.doesNotMatch(source, /insertInto\('ingredient_variants'\)|insert into meal\.ingredient_variants/u);
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiCapabilityModule) ?? []) as unknown[];
    assert.equal(
        controllers.some((controller) => String(controller).includes('BeveragePairing')),
        false,
    );
});
