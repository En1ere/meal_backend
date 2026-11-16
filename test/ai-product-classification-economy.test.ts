import { MODULE_METADATA } from '@nestjs/common/constants.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    AI_V2_PRODUCT_CLASSIFICATION_MAX_OUTPUT_TOKENS,
    AiProviderSimulator,
    AiV2ProductClassificationExecutor,
    aiV2ProductClassificationResultSchema,
    parseAiV2PreviewRequest,
    productClassificationProviderRequest,
    validateProductClassificationProviderResult,
    type AiV2PersistedReadOutcome,
    type AiV2ProductClassificationShortlist,
    type ProviderSubmitOutcome,
} from '../src/modules/ai/public.js';
import { AiCapabilityModule } from '../src/contexts/integrations/ai-capability.module.js';

const shortlist: AiV2ProductClassificationShortlist = {
    id: '00000000-0000-4000-8000-000000000401',
    query: 'томат',
    candidates: [
        {
            key: 1,
            ingredientId: '00000000-0000-4000-8000-000000000402',
            ingredientVersion: 3,
            name: 'Томат',
            categoryId: '00000000-0000-4000-8000-000000000403',
            categoryVersion: 2,
            matchKind: 'exact',
        },
        {
            key: 2,
            ingredientId: '00000000-0000-4000-8000-000000000404',
            ingredientVersion: 5,
            name: 'Томатная паста',
            categoryId: '00000000-0000-4000-8000-000000000403',
            categoryVersion: 2,
            matchKind: 'prefix',
        },
    ],
};

void test('classification contract separates backend query from shortlist-only model classification', () => {
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'product_classification',
            mode: 'candidates',
            input: { query: 'томат' },
        }),
        { task: 'product_classification', mode: 'candidates', input: { query: 'томат' } },
    );
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'product_classification',
            mode: 'classify',
            input: { shortlistId: shortlist.id },
        }),
        { task: 'product_classification', mode: 'classify', input: { shortlistId: shortlist.id } },
    );
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'product_classification',
            mode: 'classify',
            input: { shortlistId: shortlist.id, query: 'другой', candidates: [] },
        }),
    );
});

void test('provider receives short ordinal keys and names without catalog IDs or versions', () => {
    const request = productClassificationProviderRequest({
        clientRequestId: '00000000-0000-4000-8000-000000000405',
        profileVersion: 'yandex-alice-flash-economy-v1',
        shortlist,
    });
    assert.deepEqual(JSON.parse(request.input), {
        query: 'томат',
        candidates: [
            { key: 1, name: 'Томат' },
            { key: 2, name: 'Томатная паста' },
        ],
    });
    assert.equal(request.maxOutputTokens, AI_V2_PRODUCT_CLASSIFICATION_MAX_OUTPUT_TOKENS);
    assert.doesNotMatch(request.input, /00000000|ingredientId|Version|categoryId|history|profile|context/u);
});

void test('backend accepts only a frozen shortlist key or explicit no-match', () => {
    const selected = validateProductClassificationProviderResult(
        {
            schemaVersion: 'ai-result-contract-v2:product_classification:classify',
            selectedKey: 2,
            confidence: 'high',
        },
        40,
        shortlist,
    );
    assert.deepEqual(selected, {
        schemaVersion: 'ai-result-contract-v2:product_classification:classify',
        selectedCandidateId: shortlist.candidates[1]?.ingredientId,
        selectedName: 'Томатная паста',
        confidence: 'high',
        warningCodes: [],
        recoveryCode: 'review_selection',
    });
    assert.deepEqual(
        validateProductClassificationProviderResult(
            {
                schemaVersion: 'ai-result-contract-v2:product_classification:classify',
                selectedKey: null,
                confidence: 'low',
            },
            30,
            shortlist,
        ),
        {
            schemaVersion: 'ai-result-contract-v2:product_classification:classify',
            selectedCandidateId: null,
            selectedName: null,
            confidence: 'low',
            warningCodes: ['no_match'],
            recoveryCode: 'refine_query',
        },
    );
    assert.equal(
        validateProductClassificationProviderResult(
            {
                schemaVersion: 'ai-result-contract-v2:product_classification:classify',
                selectedKey: 8,
                confidence: 'high',
            },
            30,
            shortlist,
        ),
        null,
    );
    assert.equal(
        validateProductClassificationProviderResult(
            {
                schemaVersion: 'ai-result-contract-v2:product_classification:classify',
                selectedKey: 1,
                confidence: 'high',
            },
            AI_V2_PRODUCT_CLASSIFICATION_MAX_OUTPUT_TOKENS + 1,
            shortlist,
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

void test('simulator executor persists only a backend-resolved catalog candidate', async () => {
    const store = new MemoryStore();
    const provider = new AiProviderSimulator();
    provider.enqueue({
        kind: 'success',
        result: {
            schemaVersion: 'ai-result-contract-v2:product_classification:classify',
            selectedKey: 1,
            confidence: 'medium',
        },
    });
    const executor = new AiV2ProductClassificationExecutor(store as never, provider);
    const submitted = await executor.submit({
        operationId: '00000000-0000-4000-8000-000000000406',
        dispatchVersion: 1,
        clientRequestId: '00000000-0000-4000-8000-000000000407',
        shortlist,
    });
    assert.ok(submitted);
    await executor.read({
        operationId: '00000000-0000-4000-8000-000000000406',
        dispatchVersion: submitted.nextVersion,
        shortlist,
    });
    assert.equal(store.readOutcome?.kind, 'succeeded');
    if (store.readOutcome?.kind === 'succeeded') {
        const result = aiV2ProductClassificationResultSchema.parse(store.readOutcome.validatedResultSnapshot);
        assert.equal(result.selectedCandidateId, shortlist.candidates[0]?.ingredientId);
        assert.equal(result.selectedName, 'Томат');
    }
});

void test('shortlist is SQL-only, owner/version-bound and no public classifier is exposed', () => {
    const source = readFileSync(
        fileURLToPath(new URL('../../src/modules/ai/ai-product-classification-internal.service.ts', import.meta.url)),
        'utf8',
    );
    assert.match(source, /jsonb_array_elements_text/u);
    assert.match(source, /lower\(ingredient\.name\)=lower/u);
    assert.match(source, /conversation\.user_id=\$\{userId\}::uuid/u);
    assert.match(source, /row\.ingredientVersion !== candidate\.ingredientVersion/u);
    assert.match(source, /row\.categoryVersion !== candidate\.categoryVersion/u);
    assert.match(source, /limit 8/u);
    assert.match(source, /exact\.length === 1/u);
    assert.match(source, /!shortlist\.candidates\.length/u);
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiCapabilityModule) ?? []) as unknown[];
    assert.equal(
        controllers.some((controller) => String(controller).includes('ProductClassification')),
        false,
    );
});
