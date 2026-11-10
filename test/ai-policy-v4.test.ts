import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    AI_TASK_POLICY_V4,
    aiTaskModeV4,
    aiTaskModesV4,
    aiV4ProviderProfiles,
    assertAiTaskPolicyV4,
} from '../src/modules/ai/public.js';

void test('AI task policy v4 covers every approved task/mode exactly once', () => {
    assert.equal(AI_TASK_POLICY_V4, 'ai-task-policy-v4');
    assert.equal(aiTaskModesV4.length, 29);
    assert.equal(
        new Set(aiTaskModesV4.map((definition) => `${definition.task}/${definition.mode}`)).size,
        aiTaskModesV4.length,
    );
    assert.equal(new Set(aiTaskModesV4.map((definition) => definition.task)).size, 18);
    assert.doesNotThrow(assertAiTaskPolicyV4);
});

void test('backend modes are free and providerless while disabled modes are not executable', () => {
    const backendModes = aiTaskModesV4.filter((definition) => definition.route === 'backend');
    assert.equal(backendModes.length, 12);
    for (const definition of backendModes) {
        assert.equal(definition.actionCost, 0);
        assert.equal(definition.providerProfileVersion, null);
        assert.equal(definition.providerCostCeilingMinor, null);
    }

    const disabledModes = aiTaskModesV4.filter((definition) => definition.route === 'disabled');
    assert.deepEqual(
        disabledModes.map((definition) => definition.task),
        ['seasonal_analysis', 'document_analysis'],
    );
    for (const definition of disabledModes) {
        assert.equal(definition.minimumPlan, null);
        assert.equal(definition.actionCost, null);
        assert.equal(definition.resultSchemaVersion, null);
    }
});

void test('provider modes use one fixed profile and remain inside profile ceilings', () => {
    for (const definition of aiTaskModesV4) {
        if (definition.route !== 'economy' && definition.route !== 'balanced') continue;
        const profile = aiV4ProviderProfiles[definition.route];
        assert.equal(definition.providerProfileVersion, profile.version);
        assert.equal(profile.fallbackProfileVersion, null);
        assert.ok(definition.maxInputBytes <= profile.maxInputBytes);
        assert.ok(definition.maxOutputTokens !== null);
        assert.ok(definition.maxOutputTokens <= profile.maxOutputTokens);
    }
});

void test('approved zero-cost artifacts and meal-plan clarification do not charge the user', () => {
    assert.equal(aiTaskModeV4('review_summary', 'public_summary')?.actionCost, 0);
    assert.equal(aiTaskModeV4('meal_plan_generation', 'replace_slot')?.actionCost, 0);
    assert.deepEqual(aiTaskModeV4('meal_plan_generation', 'generate')?.clarification, {
        includedMessages: 2,
        intervalSeconds: 600,
    });
});
