import { MODULE_METADATA } from '@nestjs/common/constants.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    AI_V2_STORAGE_MAX_OUTPUT_TOKENS,
    AiProviderSimulator,
    AiV2StorageAdviceExecutor,
    aiV2StorageExplainResultSchema,
    parseAiV2PreviewRequest,
    storageAdviceProviderRequest,
    validateStorageAdviceProviderResult,
    type AiV2PersistedReadOutcome,
    type AiV2StorageVerdict,
    type ProviderSubmitOutcome,
} from '../src/modules/ai/public.js';
import { AiCapabilityModule } from '../src/contexts/integrations/ai-capability.module.js';

const verdict: AiV2StorageVerdict = {
    id: '00000000-0000-4000-8000-000000000201',
    productId: '00000000-0000-4000-8000-000000000202',
    productVersion: 4,
    productName: 'Молоко пастеризованное',
    variantId: '00000000-0000-4000-8000-000000000203',
    variantVersion: 2,
    ingredientId: '00000000-0000-4000-8000-000000000204',
    ingredientVersion: 8,
    ingredientName: 'Молоко',
    compositionId: '00000000-0000-4000-8000-000000000205',
    compositionRevision: 3,
    storageType: 'fridge' as const,
    shelfLifeDays: null,
    warningCodes: ['shelf_life_unknown'],
    recoveryCode: 'check_product_label',
};

void test('storage contracts separate cost-zero rule from minimal verdict-only explanation', () => {
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'storage_advice',
            mode: 'rule',
            input: { productId: verdict.productId },
        }),
        { task: 'storage_advice', mode: 'rule', input: { productId: verdict.productId } },
    );
    assert.deepEqual(
        parseAiV2PreviewRequest({ task: 'storage_advice', mode: 'explain', input: { verdictId: verdict.id } }),
        { task: 'storage_advice', mode: 'explain', input: { verdictId: verdict.id } },
    );
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'storage_advice',
            mode: 'explain',
            input: { verdictId: verdict.id, productId: verdict.productId, history: [] },
        }),
    );
});

void test('provider sees only an immutable backend verdict without catalog identities or history', () => {
    const request = storageAdviceProviderRequest({
        clientRequestId: '00000000-0000-4000-8000-000000000206',
        profileVersion: 'yandex-alice-flash-economy-v1',
        verdict,
    });
    assert.deepEqual(JSON.parse(request.input), {
        product: verdict.productName,
        ingredient: verdict.ingredientName,
        storageType: 'fridge',
        shelfLifeDays: null,
        warningCodes: ['shelf_life_unknown'],
        recoveryCode: 'check_product_label',
    });
    assert.equal(request.maxOutputTokens, AI_V2_STORAGE_MAX_OUTPUT_TOKENS);
    assert.doesNotMatch(request.input, /Id|Version|revision|history|profile|context/u);
    assert.match(request.instructions, /не придумывай срок, температуру или безопасность/u);
});

void test('storage result is strict, bounded and rejects invented time or temperature facts', () => {
    const result = {
        schemaVersion: 'ai-result-contract-v2:storage_advice:explain',
        explanation: 'Каталог указывает холодильник, а точный срок нужно проверить на этикетке.',
        warningCodes: ['shelf_life_unknown'] as const,
        recoveryCode: 'check_product_label' as const,
    };
    assert.deepEqual(validateStorageAdviceProviderResult(result, 100), result);
    assert.equal(validateStorageAdviceProviderResult(result, AI_V2_STORAGE_MAX_OUTPUT_TOKENS + 1), null);
    assert.equal(validateStorageAdviceProviderResult({ ...result, explanation: 'Храните 3 дня.' }, 100), null);
    assert.equal(
        validateStorageAdviceProviderResult({ ...result, explanation: 'Храните при пяти градусах.' }, 100),
        null,
    );
    assert.equal(validateStorageAdviceProviderResult({ ...result, applied: true }, 100), null);
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

void test('simulator result cannot replace backend warning or recovery codes', async () => {
    const store = new MemoryStore();
    const provider = new AiProviderSimulator();
    provider.enqueue({
        kind: 'success',
        result: {
            schemaVersion: 'ai-result-contract-v2:storage_advice:explain',
            explanation: 'Каталог указывает холодильник, а точный срок нужно проверить на этикетке.',
            warningCodes: ['composition_unknown'],
            recoveryCode: 'use_conservative_storage',
        },
    });
    const executor = new AiV2StorageAdviceExecutor(store as never, provider);
    const submitted = await executor.submit({
        operationId: '00000000-0000-4000-8000-000000000207',
        dispatchVersion: 1,
        clientRequestId: '00000000-0000-4000-8000-000000000208',
        verdict,
    });
    assert.ok(submitted);
    await executor.read({
        operationId: '00000000-0000-4000-8000-000000000207',
        dispatchVersion: submitted.nextVersion,
        verdict,
    });
    assert.equal(store.readOutcome?.kind, 'succeeded');
    if (store.readOutcome?.kind === 'succeeded') {
        const result = aiV2StorageExplainResultSchema.parse(store.readOutcome.validatedResultSnapshot);
        assert.deepEqual(result.warningCodes, ['shelf_life_unknown']);
        assert.equal(result.recoveryCode, 'check_product_label');
    }
});

void test('backend rule is version-bound, SQL-only and storage advice stays off public controllers', () => {
    const source = readFileSync(
        fileURLToPath(new URL('../../src/modules/ai/ai-storage-advice-internal.service.ts', import.meta.url)),
        'utf8',
    );
    assert.match(source, /ingredient\.default_storage_type "storageType"/u);
    assert.match(source, /when version\.product_id=product\.id then 1/u);
    assert.match(source, /conversation\.user_id=\$\{userId\}::uuid/u);
    assert.match(source, /JSON\.stringify\(current\) !== JSON\.stringify\(verdict\)/u);
    assert.match(source, /shelfLifeDays: null/u);
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiCapabilityModule) ?? []) as unknown[];
    assert.equal(
        controllers.some((controller) => String(controller).includes('StorageAdvice')),
        false,
    );
});
