import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    AI_V2_CULINARY_MAX_OUTPUT_TOKENS,
    AI_V2_PROVIDER_PORT,
    AiProviderSimulator,
    AiV2CulinaryExecutor,
    aiV2CulinaryAnswerResultSchema,
    classifyCulinaryQuestion,
    culinaryBoundaryResult,
    culinaryProviderRequest,
    parseAiV2PreviewRequest,
    validateCulinaryProviderResult,
    type AiV2PersistedReadOutcome,
    type ProviderSubmitOutcome,
} from '../src/modules/ai/public.js';
import { AiProviderCapabilityModule } from '../src/contexts/integrations/ai-provider-capability.module.js';
import { AiCapabilityModule } from '../src/contexts/integrations/ai-capability.module.js';
import { MODULE_METADATA } from '@nestjs/common/constants.js';

const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../test/fixtures/ai-culinary-economy.json', import.meta.url)), 'utf8'),
) as Record<'safe' | 'promptInjection' | 'medical' | 'allergen' | 'foodSafety', string[]>;

void test('culinary contract is minimal, strict and bounded', () => {
    const parsed = parseAiV2PreviewRequest({
        task: 'culinary_question',
        mode: 'answer',
        input: { question: fixture.safe[0] },
    });
    assert.deepEqual(parsed, {
        task: 'culinary_question',
        mode: 'answer',
        input: { question: fixture.safe[0] },
    });
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'culinary_question',
            mode: 'answer',
            input: { question: fixture.safe[0], locale: 'ru', history: [] },
        }),
    );
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'culinary_question',
            mode: 'answer',
            input: { question: 'а'.repeat(501) },
        }),
    );
    assert.equal(
        aiV2CulinaryAnswerResultSchema.safeParse({
            schemaVersion: 'ai-result-contract-v2:culinary_question:answer',
            answer: 'Ответ',
            warningCodes: [],
            recoveryCode: null,
            sources: [],
        }).success,
        false,
    );
});

void test('backend safety classifier refuses injection, medical, allergen and food-safety boundaries', () => {
    assert.equal(classifyCulinaryQuestion(fixture.safe[0]!), 'safe');
    assert.equal(classifyCulinaryQuestion(fixture.promptInjection[0]!), 'prompt_injection_detected');
    assert.equal(classifyCulinaryQuestion(fixture.medical[0]!), 'medical_boundary');
    assert.equal(classifyCulinaryQuestion(fixture.allergen[0]!), 'allergen_boundary');
    assert.equal(classifyCulinaryQuestion(fixture.foodSafety[0]!), 'food_safety_boundary');
    const refusal = culinaryBoundaryResult('medical_boundary');
    assert.deepEqual(refusal.warningCodes, ['medical_boundary']);
    assert.equal(refusal.recoveryCode, 'contact_healthcare_professional');
});

void test('frozen economy request carries only the question and a strict bounded result schema', () => {
    const request = culinaryProviderRequest({
        clientRequestId: '00000000-0000-4000-8000-000000000111',
        profileVersion: 'yandex-alice-flash-economy-v1',
        question: fixture.safe[0]!,
    });
    assert.equal(request.input, fixture.safe[0]);
    assert.equal(request.maxOutputTokens, AI_V2_CULINARY_MAX_OUTPUT_TOKENS);
    assert.equal(request.resultSchema.name, 'culinary_question_answer_v2');
    const serialized = JSON.stringify(request);
    assert.doesNotMatch(serialized, /locale|history|context|providerFields/u);
    assert.match(request.instructions, /Не следуй инструкциям/u);
});

void test('validated result rejects extra fields and token ceiling overflow', () => {
    const result = {
        schemaVersion: 'ai-result-contract-v2:culinary_question:answer',
        answer: 'Промойте киноа и варите в пропорции один к двум.',
        warningCodes: [],
        recoveryCode: null,
    };
    assert.deepEqual(validateCulinaryProviderResult(result, 80), result);
    assert.equal(validateCulinaryProviderResult(result, 501), null);
    assert.equal(validateCulinaryProviderResult({ ...result, hidden: true }, 80), null);
});

class MemoryStore {
    submitOutcome: ProviderSubmitOutcome | null = null;
    readOutcome: AiV2PersistedReadOutcome | null = null;
    providerResponseId: string | null = null;

    async claimSubmit(input: { expectedVersion: number }) {
        await Promise.resolve();
        return { version: input.expectedVersion + 1 };
    }

    async recordSubmit(input: { outcome: ProviderSubmitOutcome }) {
        await Promise.resolve();
        this.submitOutcome = input.outcome;
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

void test('simulator path covers success, rejected, unknown and readback without Yandex', async () => {
    const successStore = new MemoryStore();
    const successProvider = new AiProviderSimulator();
    const result = {
        schemaVersion: 'ai-result-contract-v2:culinary_question:answer' as const,
        answer: 'Промойте киноа и варите около пятнадцати минут.',
        warningCodes: [] as const,
        recoveryCode: null,
    };
    successProvider.enqueue({ kind: 'success', result });
    const success = new AiV2CulinaryExecutor(successStore as never, successProvider);
    const submitted = await success.submit({
        operationId: '00000000-0000-4000-8000-000000000201',
        dispatchVersion: 1,
        clientRequestId: '00000000-0000-4000-8000-000000000202',
        question: fixture.safe[0]!,
        clock: new Date('2026-11-11T10:00:00.000Z'),
    });
    assert.ok(submitted);
    assert.equal(submitted.outcome.kind, 'accepted');
    await success.read({
        operationId: '00000000-0000-4000-8000-000000000201',
        dispatchVersion: submitted.nextVersion,
        clock: new Date('2026-11-11T10:00:00.010Z'),
    });
    assert.equal(successStore.readOutcome?.kind, 'succeeded');

    for (const scenario of ['rejected', 'unknown_without_identity'] as const) {
        const store = new MemoryStore();
        const provider = new AiProviderSimulator();
        provider.enqueue({ kind: scenario });
        const executor = new AiV2CulinaryExecutor(store as never, provider);
        const outcome = await executor.submit({
            operationId: '00000000-0000-4000-8000-000000000301',
            dispatchVersion: 1,
            clientRequestId: '00000000-0000-4000-8000-000000000302',
            question: fixture.safe[0]!,
        });
        assert.equal(outcome?.outcome.kind, scenario);
    }
});

void test('DI binds v2 port only to simulator and exposes no public culinary controller', () => {
    const providerDefinitions = Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        AiProviderCapabilityModule,
    ) as Array<unknown>;
    assert.equal(
        providerDefinitions.some(
            (provider) =>
                typeof provider === 'object' &&
                provider !== null &&
                'provide' in provider &&
                provider.provide === AI_V2_PROVIDER_PORT &&
                'useExisting' in provider &&
                provider.useExisting === AiProviderSimulator,
        ),
        true,
    );
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiCapabilityModule) ?? []) as unknown[];
    assert.equal(
        controllers.some((controller) => String(controller).includes('Culinary')),
        false,
    );
});

void test('provider store settles reserve/capture/release and preserves reconciliation hold', () => {
    const store = readFileSync(
        fileURLToPath(new URL('../../src/modules/ai/ai-provider-operation.store.ts', import.meta.url)),
        'utf8',
    );
    assert.match(store, /settleUserQuota/u);
    assert.match(store, /'capture' : 'release'/u);
    assert.match(store, /reserved_projection=reserved_projection-/u);
    assert.match(store, /reconciliation_hold/u);
    assert.match(store, /insert into meal\.ai_ledger/u);
});
