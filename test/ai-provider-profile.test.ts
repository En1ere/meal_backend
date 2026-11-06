import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiTokenBudget } from '../src/modules/ai/public.js';
import { aiMoneyUnits, aiProviderCost, aiProviderProfile } from '../src/shared/config/ai-provider-profile.js';
import { readConfig } from '../src/app/config.js';

void test('Luna profile prices every task class with an eight-decimal conservative ceiling', () => {
    const profile = aiProviderProfile('openai-gpt-6-luna-standard-2026-11-07');
    assert.equal(profile.model, 'gpt-6-luna');
    assert.deepEqual(
        ([1, 2, 3, 4, 5] as const).map((cost) => {
            const budget = aiTokenBudget(cost);
            return aiProviderCost(profile, {
                inputTokens: budget.maxInputTokens,
                outputTokens: budget.maxOutputTokens,
            });
        }),
        ['0.00155000', '0.00310000', '0.00570000', '0.00830000', '0.01140000'],
    );
});

void test('provider money parser is exact and profile registry rejects unversioned values', () => {
    assert.equal(aiMoneyUnits('10.12345678'), 1_012_345_678n);
    assert.throws(() => aiMoneyUnits('0.000000001'));
    assert.throws(() => aiProviderProfile('gpt-6-luna'));
});

void test('background execution requires an explicit positive budget and a matching versioned model profile', () => {
    const base = {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AI_API_BASE_URL: 'https://api.openai.test/v1/',
        AI_MODEL: 'gpt-6-luna',
        AI_PROVIDER_PROFILE_VERSION: 'openai-gpt-6-luna-standard-2026-11-07',
        AI_BACKGROUND_EXECUTION_ENABLED: 'true',
    } satisfies NodeJS.ProcessEnv;
    assert.throws(() => readConfig(base), /monthly budget/);
    assert.equal(readConfig({ ...base, AI_MONTHLY_BUDGET_USD: '10.00' }).AI_MONTHLY_BUDGET_USD, '10.00');
    assert.throws(() => readConfig({ ...base, AI_MODEL: 'gpt-6.1-sol', AI_MONTHLY_BUDGET_USD: '10.00' }), /must match/);
});
