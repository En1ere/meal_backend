import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const text = (path: string) => readFile(path, 'utf8');

void test('schema v40 permits zero cost only for a frozen contract-v2 backend task', async () => {
    const [migration, manifestText] = await Promise.all([
        text('database/migrations/040_ai_backend_zero_cost.sql'),
        text('database/manifest.json'),
    ]);
    const manifest = JSON.parse(manifestText) as {
        migrations: ReadonlyArray<{ version: number; file: string; sha256: string }>;
    };
    const entry = manifest.migrations.at(-1);

    assert.match(migration, /ADD COLUMN source_snapshot_hash char\(64\)/u);
    assert.match(migration, /cost BETWEEN 0 AND 5/u);
    assert.match(migration, /task\.contract_version=2 AND task\.accepted_cost=0/u);
    assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM/u);
    assert.deepEqual(entry, {
        version: 40,
        file: '040_ai_backend_zero_cost.sql',
        sha256: createHash('sha256').update(migration).digest('hex'),
    });
});

void test('the first v2 backend executor reuses meal-plan SQL and has no provider or quota path', async () => {
    const [service, mealPlan, legacy] = await Promise.all([
        text('src/modules/ai-meal-plan/ai-meal-plan-backend.service.ts'),
        text('src/modules/meal-plan/meal-plan.service.ts'),
        text('src/modules/ai/ai.service.ts'),
    ]);

    assert.match(service, /mealPlans\.aiShoppingPreview/u);
    assert.match(service, /values\(\$\{intervalId\}::uuid,\$\{startedAt\},\$\{intervalEndsAt\},0,0,'completed'/u);
    assert.match(service, /2,'initial',\$\{requestHash\},'succeeded','none'/u);
    assert.match(service, /\$\{task\.cachePolicyVersion\},'none',null/u);
    assert.doesNotMatch(service, /AiProvider|ai_buckets|ai_ledger/u);
    assert.match(mealPlan, /async shoppingReview/u);
    assert.match(mealPlan, /aiShoppingPreview/u);
    assert.match(legacy, /t\.contract_version=1/u);
    assert.match(legacy, /o\.contract_version=1/u);
});
