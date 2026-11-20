import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const text = (path: string) => readFile(path, 'utf8');

void test('schema v42 preserves none only for zero-cost provider unknown outcomes', async () => {
    const migration = await text('database/migrations/042_ai_zero_cost_provider_unknown.sql');
    assert.match(migration, /DROP CONSTRAINT ck_ai_operations_v2_unknown/u);
    assert.match(
        migration,
        /provider_request_id IS NULL AND financial_state IN\('none','released'\) AND provider_cost_state='estimated_hold'/u,
    );
    assert.match(migration, /provider_request_id IS NOT NULL AND financial_state IN\('none','reconciliation_hold'\)/u);
    assert.match(migration, /SELECT accepted_cost::integer INTO task_cost/u);
    assert.match(migration, /IF task_cost=0 THEN\s+NEW\.financial_state:='none'/u);
    assert.match(migration, /Paid AI operation cannot have a zero-cost unknown outcome/u);
    assert.match(migration, /CREATE TRIGGER zzz_project_zero_cost_unknown BEFORE INSERT OR UPDATE/u);
    assert.match(migration, /REVOKE ALL ON FUNCTION meal\.project_zero_cost_ai_unknown\(\) FROM PUBLIC/u);
    assert.doesNotMatch(migration, /CREATE TABLE|DROP TABLE|GRANT .* ON|ai_buckets|ai_ledger/iu);
});

void test('schema v42 manifest hash binds the additive constraint migration', async () => {
    const [migration, manifestText] = await Promise.all([
        text('database/migrations/042_ai_zero_cost_provider_unknown.sql'),
        text('database/manifest.json'),
    ]);
    const manifest = JSON.parse(manifestText) as {
        totalTables: number;
        foreignKeys: number;
        migrations: Array<{ version: number; file: string; sha256: string }>;
    };
    assert.equal(manifest.totalTables, 229);
    assert.equal(manifest.foreignKeys, 523);
    assert.deepEqual(manifest.migrations.at(-1), {
        version: 42,
        file: '042_ai_zero_cost_provider_unknown.sql',
        sha256: createHash('sha256').update(migration).digest('hex'),
    });
});
