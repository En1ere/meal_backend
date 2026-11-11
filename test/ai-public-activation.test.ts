import assert from 'node:assert/strict';
import { ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readConfig } from '../src/app/config.js';
import {
    AiV2PublicActivationGate,
    aiV2CulinaryPublicOperationSchema,
    aiV2CulinaryPublicPreviewSchema,
    culinaryPublicActivationDecision,
    type AiV2ProviderRuntime,
} from '../src/modules/ai/public.js';

const simulator: AiV2ProviderRuntime = {
    kind: 'simulator',
    readiness: 'ready',
    profileVersions: ['yandex-alice-flash-economy-v1'],
};

const evidence = {
    AI_V2_CULINARY_PUBLIC_ENABLED: true,
    AI_V2_CULINARY_STORE_FALSE_READBACK_EVIDENCE: 'yandex-store-false-readback-v1',
    AI_V2_CULINARY_EVAL_EVIDENCE: 'ai-culinary-eval-v1',
    AI_V2_CULINARY_LEGAL_EVIDENCE: 'ai-yandex-ru-processing-v1',
    AI_V2_CULINARY_ROLLBACK_EVIDENCE: 'ai-culinary-rollback-v1',
    AI_V2_CULINARY_MONTHLY_BUDGET_RUB: '1000.00',
} as const;

void test('public culinary activation defaults off and one enable flag fails startup', () => {
    assert.equal(readConfig({ NODE_ENV: 'test' }).AI_V2_CULINARY_PUBLIC_ENABLED, false);
    assert.throws(
        () => readConfig({ NODE_ENV: 'test', AI_V2_CULINARY_PUBLIC_ENABLED: 'true' }),
        /requires readback, eval, legal, rollback and RUB budget evidence/u,
    );
    assert.throws(
        () => readConfig({ NODE_ENV: 'test', AI_V2_CULINARY_MONTHLY_BUDGET_RUB: '0' }),
        /must be greater than zero/u,
    );
});

void test('API key or complete evidence cannot activate a simulator runtime', () => {
    const withKeyOnly = readConfig({
        NODE_ENV: 'test',
        AI_API_TOKEN: 'not-a-real-key',
        AI_API_BASE_URL: 'https://api.example.test/v1/',
        AI_MODEL: 'gpt-6-luna',
        AI_PROVIDER_PROFILE_VERSION: 'openai-gpt-6-luna-standard-2026-11-07',
    });
    assert.equal(culinaryPublicActivationDecision(withKeyOnly, simulator).ready, false);
    const decision = culinaryPublicActivationDecision(evidence, simulator);
    assert.equal(decision.ready, false);
    assert.deepEqual(decision.blockers, ['provider_runtime_not_yandex']);
    const gate = new AiV2PublicActivationGate(evidence, simulator);
    assert.throws(() => gate.assertCulinaryReady(), ServiceUnavailableException);
});

void test('activation becomes eligible only with all evidence and a ready exact Yandex economy runtime', () => {
    const yandex: AiV2ProviderRuntime = {
        kind: 'yandex',
        readiness: 'ready',
        profileVersions: ['yandex-alice-flash-economy-v1'],
    };
    assert.deepEqual(culinaryPublicActivationDecision(evidence, yandex), { ready: true, blockers: [] });
    assert.equal(
        culinaryPublicActivationDecision({ ...evidence, AI_V2_CULINARY_EVAL_EVIDENCE: undefined }, yandex).ready,
        false,
    );
});

void test('future public culinary responses expose no provider, financial or detector internals', () => {
    const preview = {
        id: '00000000-0000-4000-8000-000000000401',
        task: 'culinary_question',
        mode: 'answer',
        cost: 1,
        expiresAt: '2026-11-11T18:00:00.000Z',
        policyVersion: 'ai-task-policy-v4',
    };
    assert.equal(aiV2CulinaryPublicPreviewSchema.safeParse(preview).success, true);
    assert.equal(aiV2CulinaryPublicPreviewSchema.safeParse({ ...preview, provider: 'yandex' }).success, false);
    const operation = {
        item: {
            id: '00000000-0000-4000-8000-000000000402',
            taskId: preview.id,
            task: 'culinary_question',
            mode: 'answer',
            state: 'queued',
            result: null,
            createdAt: '2026-11-11T17:00:00.000Z',
            updatedAt: '2026-11-11T17:00:00.000Z',
            expiresAt: '2026-12-11T17:00:00.000Z',
            version: 1,
        },
    };
    assert.equal(aiV2CulinaryPublicOperationSchema.safeParse(operation).success, true);
    assert.equal(
        aiV2CulinaryPublicOperationSchema.safeParse({
            item: { ...operation.item, providerRequestId: 'hidden', financialState: 'reserved' },
        }).success,
        false,
    );
});

void test('deployment and OpenAPI remain fail closed for the culinary model route', () => {
    const compose = readFileSync('deploy/compose.production.yml', 'utf8');
    const openapi = JSON.parse(readFileSync('contracts/openapi.json', 'utf8')) as {
        paths: Record<string, { post?: { requestBody?: unknown } }>;
    };
    assert.match(compose, /AI_V2_CULINARY_PUBLIC_ENABLED: 'false'/u);
    const publicV2Preview = JSON.stringify(openapi.paths['/api/v1/ai/v2/preview']?.post?.requestBody);
    assert.doesNotMatch(publicV2Preview, /culinary_question/u);
    assert.match(publicV2Preview, /shopping_list_generation/u);
});
