import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migration = readFileSync('database/migrations/037_ai_operation_lifecycle.sql', 'utf8');

void test('schema v37 separates canonical AI lifecycle from financial state and preserves unknown outcomes', () => {
    assert.match(
        migration,
        /lifecycle_state IN \('accepted','queued','running','succeeded','failed','cancelled','unknown'\)/,
    );
    assert.match(migration, /financial_state IN \('none','reserved','captured','released','reconciliation_hold'\)/);
    assert.match(migration, /lifecycle_state='unknown' AND financial_state IN \('none','reconciliation_hold'\)/);
    assert.match(migration, /status=CASE WHEN o\.status IN \('succeeded','failed'\).*ELSE 'unknown' END/s);
    assert.doesNotMatch(migration, /lifecycle_state='unknown'.*financial_state='released'/s);
});

void test('schema v37 queue uses bounded lease, fencing evidence and partial v1 idempotency', () => {
    assert.match(migration, /WHERE contract_version=1/);
    assert.match(migration, /WHERE lifecycle_state='queued'/);
    assert.match(migration, /WHERE lifecycle_state='running'/);
    assert.match(migration, /lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL/);
    assert.match(migration, /attempt_count BETWEEN 0 AND 10/);
    assert.match(migration, /client_request_id uuid NOT NULL UNIQUE/);
    assert.match(migration, /lease_token uuid NOT NULL/);
    assert.match(
        migration,
        /state IN \('prepared','submitted','polling','succeeded','failed','unknown','reconciled'\)/,
    );
    assert.match(migration, /OLD\.state='prepared' AND NEW\.state IN \('submitted','failed','unknown'\)/);
});

void test('schema v37 attempt evidence is bounded and excludes private AI content', () => {
    assert.match(migration, /requested_model varchar\(128\)/);
    assert.match(migration, /input_tokens integer CHECK/);
    assert.match(migration, /estimated_cost numeric\(24,8\)/);
    assert.match(migration, /Sanitized provider attempt evidence with immutable identity and terminal rows/);
    assert.doesNotMatch(migration, /prompt\s+(?:text|jsonb)/i);
    assert.doesNotMatch(migration, /personal_context\s+(?:text|jsonb)/i);
    assert.doesNotMatch(migration, /provider_response\s+(?:text|jsonb)/i);
});

void test('runtime keeps expired or ambiguous provider outcomes on reconciliation hold', () => {
    const reconciliation = readFileSync('src/modules/ai/ai-reconciliation.service.ts', 'utf8');
    const service = readFileSync('src/modules/ai/ai.service.ts', 'utf8');
    assert.match(reconciliation, /lifecycle_state='running'/);
    assert.match(reconciliation, /lifecycle_state='unknown'/);
    assert.match(reconciliation, /financial_state='reconciliation_hold'/);
    assert.match(reconciliation, /for update skip locked/i);
    assert.doesNotMatch(reconciliation, /reconcileInterrupted|refunded|financial_state='released'/);
    assert.match(service, /o\.lifecycle_state as "lifecycleState"/);
    assert.match(service, /o\.financial_state as "financialState"/);
    assert.doesNotMatch(service, /async reconcileInterrupted/);
});

void test('dedicated AI worker config requires file-mounted secrets and bounded leases', () => {
    const config = readFileSync('src/modules/ai/ai-worker.config.ts', 'utf8');
    assert.match(config, /AI_API_TOKEN_FILE/);
    assert.match(config, /DATABASE_URL_FILE/);
    assert.match(config, /secrets must use \*_FILE/);
    assert.match(config, /AI_WORKER_LEASE_SECONDS/);
    assert.match(config, /credential-free HTTPS URL/);
    assert.doesNotMatch(config, /env\.AI_API_TOKEN\s*\?\?/);
});

void test('schema v37 manifest hash and counts bind the prepared migration', () => {
    const manifest = JSON.parse(readFileSync('database/manifest.json', 'utf8')) as {
        domainTables: number;
        totalTables: number;
        foreignKeys: number;
        migrations: Array<{ version: number; file: string; sha256: string }>;
    };
    assert.equal(manifest.domainTables, 223);
    assert.equal(manifest.totalTables, 228);
    assert.equal(manifest.foreignKeys, 522);
    assert.deepEqual(manifest.migrations.at(-1), {
        version: 37,
        file: '037_ai_operation_lifecycle.sql',
        sha256: createHash('sha256').update(migration).digest('hex'),
    });
});
