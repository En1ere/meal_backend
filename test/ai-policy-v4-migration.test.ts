import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migration = readFileSync('database/migrations/039_ai_policy_v4_foundation.sql', 'utf8');

void test('schema v39 stores immutable v4 task identity without rewriting legacy rows', () => {
    assert.match(migration, /ADD COLUMN contract_version smallint NOT NULL DEFAULT 1/);
    assert.match(migration, /ADD COLUMN task_code varchar\(64\)/);
    assert.match(migration, /ADD COLUMN task_mode varchar\(64\)/);
    assert.match(migration, /contract_version=1 AND task_code IS NULL AND task_mode IS NULL/);
    assert.match(migration, /contract_version=2 AND task_code IS NOT NULL AND task_mode IS NOT NULL/);
    assert.match(migration, /AI task contract identity is immutable/);
    assert.doesNotMatch(migration, /UPDATE meal\.ai_tasks|DELETE FROM meal\.ai_|DROP TABLE/i);
});

void test('schema v39 freezes route and policy versions for contract v2 only', () => {
    for (const column of [
        'execution_route',
        'routing_policy_version',
        'price_policy_version',
        'result_schema_version',
        'safety_policy_version',
        'cache_policy_version',
        'provider_cost_state',
        'provider_cost_currency',
    ]) {
        assert.match(migration, new RegExp(`ADD COLUMN ${column}`));
    }
    assert.match(migration, /contract_version IN \(0,1,2\)/);
    assert.match(migration, /WHERE contract_version=2/);
    assert.match(migration, /AI operation v2 identity is immutable/);
    assert.match(migration, /execution_route='backend' AND provider_profile_version IS NULL/);
    assert.match(migration, /execution_route='economy'.*yandex-alice-flash-economy-v1/s);
    assert.match(migration, /execution_route='balanced'.*yandexgpt-5\.1-balanced-v1/s);
});

void test('schema v39 separates released user quota from provider cost hold without a provider identity', () => {
    assert.match(migration, /lifecycle_state='unknown'.*'released'.*'reconciliation_hold'/s);
    assert.match(
        migration,
        /provider_request_id IS NULL AND financial_state='released' AND provider_cost_state='estimated_hold'/,
    );
    assert.match(migration, /provider_request_id IS NOT NULL AND financial_state='reconciliation_hold'/);
    assert.match(migration, /provider_cost_state IN\('none','estimated_hold','actual','released'\)/);
});

void test('schema v39 registers every v4 policy snapshot and keeps worker authority narrow', () => {
    for (const policy of [
        "'cost',\n  4",
        "'context',\n  2",
        "'routing',1",
        "'price',1",
        "'result',2",
        "'safety',1",
        "'cache',1",
    ]) {
        assert.ok(migration.includes(policy));
    }
    const applicationGrants = readFileSync('database/application-grants.sql', 'utf8');
    const workerGrants = readFileSync('deploy/provision-ai-worker-runtime.sh', 'utf8');
    assert.match(applicationGrants, /execution_route,[\s\S]*provider_cost_state,provider_cost_currency/);
    assert.match(workerGrants, /provider_cost,provider_cost_state/);
    assert.doesNotMatch(workerGrants, /update\([^)]*execution_route/i);
    assert.doesNotMatch(workerGrants, /update\([^)]*provider_cost_currency/i);
});

void test('schema v39 manifest hash binds the additive migration', () => {
    const manifest = JSON.parse(readFileSync('database/manifest.json', 'utf8')) as {
        totalTables: number;
        foreignKeys: number;
        migrations: Array<{ version: number; file: string; sha256: string }>;
    };
    assert.equal(manifest.totalTables, 229);
    assert.equal(manifest.foreignKeys, 523);
    assert.deepEqual(
        manifest.migrations.find((entry) => entry.version === 39),
        {
            version: 39,
            file: '039_ai_policy_v4_foundation.sql',
            sha256: createHash('sha256').update(migration).digest('hex'),
        },
    );
});
