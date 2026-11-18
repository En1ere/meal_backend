import { MODULE_METADATA } from '@nestjs/common/constants.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AiCapabilityModule } from '../src/contexts/integrations/ai-capability.module.js';
import {
    AI_V2_REGISTRY_ANALYSIS_MAX_OUTPUT_TOKENS,
    AiProviderSimulator,
    AiV2RegistryAnalysisExecutor,
    aiV2RegistryExplainResultSchema,
    parseAiV2PreviewRequest,
    registryAnalysisProviderRequest,
    registryWarningCodes,
    validateRegistryAnalysisProviderResult,
    type AiV2PersistedReadOutcome,
    type AiV2RegistryFactsSnapshot,
    type ProviderSubmitOutcome,
} from '../src/modules/ai/public.js';

const snapshot: AiV2RegistryFactsSnapshot = {
    id: '00000000-0000-4000-8000-000000000b01',
    scope: 'personal',
    scopeId: '00000000-0000-4000-8000-000000000b02',
    scopeVersion: 3,
    query: 'Покажи состояние моих запасов',
    asOfDate: '2026-11-18',
    sourceCount: 12,
    sourceHash: 'a'.repeat(64),
    facts: [
        { key: 'active_batches', value: 12, unit: 'batches' },
        { key: 'distinct_items', value: 9, unit: 'items' },
        { key: 'expired_batches', value: 1, unit: 'batches' },
        { key: 'expiring_7d_batches', value: 2, unit: 'batches' },
        { key: 'unknown_quantity_batches', value: 3, unit: 'batches' },
        { key: 'unknown_expiry_batches', value: 4, unit: 'batches' },
        { key: 'opened_batches', value: 5, unit: 'batches' },
    ],
    warningCodes: ['expired_items_present', 'unknown_quantity_present', 'unknown_expiry_present'],
};

void test('registry contracts separate backend facts from frozen explanation', () => {
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'registry_analysis',
            mode: 'facts',
            input: { query: 'Покажи состояние моих запасов' },
        }),
        { task: 'registry_analysis', mode: 'facts', input: { query: 'Покажи состояние моих запасов' } },
    );
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'registry_analysis',
            mode: 'explain',
            input: { factsId: snapshot.id, question: 'На что обратить внимание?' },
        }),
        {
            task: 'registry_analysis',
            mode: 'explain',
            input: { factsId: snapshot.id, question: 'На что обратить внимание?' },
        },
    );
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'registry_analysis',
            mode: 'explain',
            input: { factsId: snapshot.id, scope: 'family', rawRows: [] },
        }),
    );
});

void test('backend warning codes derive only from fixed aggregate values', () => {
    assert.deepEqual(registryWarningCodes(snapshot.facts), [
        'expired_items_present',
        'unknown_quantity_present',
        'unknown_expiry_present',
    ]);
    assert.deepEqual(registryWarningCodes(snapshot.facts.map((fact) => ({ ...fact, value: 0 }))), []);
});

void test('economy provider receives aggregates without scope identity or raw rows', () => {
    const request = registryAnalysisProviderRequest({
        clientRequestId: '00000000-0000-4000-8000-000000000b03',
        profileVersion: 'yandex-alice-flash-economy-v1',
        snapshot,
        question: 'На что обратить внимание?',
    });
    assert.deepEqual(JSON.parse(request.input), {
        query: snapshot.query,
        facts: snapshot.facts,
        warningCodes: snapshot.warningCodes,
        question: 'На что обратить внимание?',
    });
    assert.equal(request.maxOutputTokens, AI_V2_REGISTRY_ANALYSIS_MAX_OUTPUT_TOKENS);
    assert.doesNotMatch(request.input, /00000000|scopeId|sourceHash|batchId|history|profile|rawRows/u);
});

void test('backend preserves facts and rejects numeric, duplicate or unknown model references', () => {
    const valid = validateRegistryAnalysisProviderResult(
        {
            schemaVersion: 'ai-result-contract-v2:registry_analysis:explain',
            explanation: 'Сначала проверьте просроченные позиции и уточните неполные данные.',
            referencedFactKeys: ['expired_batches', 'unknown_quantity_batches'],
        },
        120,
        snapshot,
    );
    assert.deepEqual(valid?.facts, snapshot.facts);
    assert.equal(
        validateRegistryAnalysisProviderResult(
            {
                schemaVersion: 'ai-result-contract-v2:registry_analysis:explain',
                explanation: 'Просрочена 1 партия.',
                referencedFactKeys: ['expired_batches'],
            },
            120,
            snapshot,
        ),
        null,
    );
    assert.equal(
        validateRegistryAnalysisProviderResult(
            {
                schemaVersion: 'ai-result-contract-v2:registry_analysis:explain',
                explanation: 'Просрочена одна партия.',
                referencedFactKeys: ['expired_batches'],
            },
            120,
            snapshot,
        ),
        null,
    );
    assert.equal(
        validateRegistryAnalysisProviderResult(
            {
                schemaVersion: 'ai-result-contract-v2:registry_analysis:explain',
                explanation: 'Проверьте просроченные позиции.',
                referencedFactKeys: ['expired_batches', 'expired_batches'],
            },
            120,
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

void test('economy simulator persists facts resolved by the backend', async () => {
    const store = new MemoryStore();
    const provider = new AiProviderSimulator();
    provider.enqueue({
        kind: 'success',
        result: {
            schemaVersion: 'ai-result-contract-v2:registry_analysis:explain',
            explanation: 'Сначала проверьте просроченные позиции и уточните неполные данные.',
            referencedFactKeys: ['expired_batches', 'unknown_quantity_batches'],
        },
    });
    const executor = new AiV2RegistryAnalysisExecutor(store as never, provider);
    const submitted = await executor.submit({
        operationId: '00000000-0000-4000-8000-000000000b04',
        dispatchVersion: 1,
        clientRequestId: '00000000-0000-4000-8000-000000000b05',
        snapshot,
    });
    assert.ok(submitted);
    await executor.read({
        operationId: '00000000-0000-4000-8000-000000000b04',
        dispatchVersion: submitted.nextVersion,
        snapshot,
    });
    assert.equal(store.readOutcome?.kind, 'succeeded');
    if (store.readOutcome?.kind === 'succeeded')
        assert.equal(
            aiV2RegistryExplainResultSchema.parse(store.readOutcome.validatedResultSnapshot).facts[0]?.value,
            12,
        );
});

void test('facts are personal, SQL-only, version-bound and expose no public route', () => {
    const source = readFileSync(
        fileURLToPath(new URL('../../src/modules/ai/ai-registry-analysis-internal.service.ts', import.meta.url)),
        'utf8',
    );
    assert.match(source, /kind='private' and user_id=\$\{userId\}::uuid/u);
    assert.match(source, /scopeVersion/u);
    assert.match(source, /sourceHash/u);
    assert.match(source, /count\(distinct coalesce/u);
    assert.match(source, /limit 5001/u);
    assert.match(source, /simulator-economy-v1/u);
    assert.doesNotMatch(source, /kind='family'|insertInto\('inventory_batches'\)|update meal\.inventory_batches/u);
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiCapabilityModule) ?? []) as unknown[];
    assert.equal(
        controllers.some((controller) => String(controller).includes('RegistryAnalysis')),
        false,
    );
});
