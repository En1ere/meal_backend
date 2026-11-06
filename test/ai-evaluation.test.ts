import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import {
    AI_EVALUATION_FIXTURES,
    AI_EVALUATION_SUITE_VERSION,
    summarizeAiEvaluation,
} from '../src/modules/ai/public.js';

const evidence = (overrides: Record<string, unknown> = {}) => ({
    suiteVersion: AI_EVALUATION_SUITE_VERSION,
    runId: randomUUID(),
    profileVersion: 'openai-gpt-6-luna-standard-2026-11-07',
    startedAt: '2026-11-07T00:00:00.000Z',
    completedAt: '2026-11-07T00:10:00.000Z',
    reviewerMethod: 'manual_double_check',
    cases: AI_EVALUATION_FIXTURES.map((fixture, index) => ({
        fixtureId: fixture.id,
        providerRequestIdHash: createHash('sha256').update(`request-${index}`).digest('hex'),
        actualModel: 'gpt-6-luna-2026-10-01',
        serviceTier: 'default',
        latencyMs: 1_000 + index * 100,
        inputTokens: 1_000,
        outputTokens: 500,
        reasoningTokens: 100,
        schemaValid: true,
        refusal: false,
        criteria: fixture.criteria.map((criterion) => ({ criterionId: criterion.id, passed: true })),
        reviewedAt: '2026-11-07T00:20:00.000Z',
    })),
    ...overrides,
});

void test('AI model evaluation requires the complete identical fixture suite and exact pricing', () => {
    const summary = summarizeAiEvaluation(evidence());
    assert.equal(summary.fixtureCoverage.full, true);
    assert.equal(summary.promotionGate.passed, true);
    assert.equal(summary.promotionGate.decision, 'manual_owner_approval_required');
    assert.equal(summary.schemaSuccessRate, 1);
    assert.equal(summary.safetySuccessRate, 1);
    assert.equal(summary.providerCostUsd, '0.00280000');
    assert.equal(summary.costPerSuccessfulTaskUsd, '0.00035000');
});

void test('AI model evaluation fails closed on missing evidence, safety failure and duplicate fixture', () => {
    const partial = evidence({ cases: (evidence().cases as unknown[]).slice(0, -1) });
    assert.equal(summarizeAiEvaluation(partial).promotionGate.passed, false);

    const unsafe = evidence();
    const first = unsafe.cases[0]!;
    first.criteria = first.criteria.map((criterion, index) =>
        index === 1 ? { ...criterion, passed: false } : criterion,
    );
    const unsafeSummary = summarizeAiEvaluation(unsafe);
    assert.equal(unsafeSummary.safetySuccessRate < 1, true);
    assert.equal(unsafeSummary.promotionGate.passed, false);

    const duplicate = evidence();
    duplicate.cases[1] = { ...duplicate.cases[1]!, fixtureId: duplicate.cases[0]!.fixtureId };
    assert.throws(() => summarizeAiEvaluation(duplicate), /Duplicate AI evaluation fixture/);

    const wrongModel = evidence();
    wrongModel.cases[0] = { ...wrongModel.cases[0]!, actualModel: 'gpt-6.1-sol' };
    assert.throws(() => summarizeAiEvaluation(wrongModel), /Model\/profile mismatch/);

    const duplicateRequest = evidence();
    duplicateRequest.cases[1] = {
        ...duplicateRequest.cases[1]!,
        providerRequestIdHash: duplicateRequest.cases[0]!.providerRequestIdHash,
    };
    assert.throws(() => summarizeAiEvaluation(duplicateRequest), /Duplicate provider request evidence/);
});

void test('AI evaluation evidence never contains raw result, prompt or provider request identity fields', () => {
    const serialized = JSON.stringify(evidence());
    assert.doesNotMatch(serialized, /"(?:answer|result|prompt|providerRequestId)"/);
    assert.match(serialized, /providerRequestIdHash/);
});
