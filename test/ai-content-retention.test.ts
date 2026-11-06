import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { workerTopology } from '../src/modules/operational-runtime/public.js';

const migration = readFileSync('database/migrations/038_ai_content_retention.sql', 'utf8');
const service = readFileSync('src/modules/ai/ai-content-retention.service.ts', 'utf8');

void test('schema v38 records irreversible AI content purge without deleting financial evidence', () => {
    assert.match(migration, /ai_tasks ADD COLUMN content_purged_at timestamptz/);
    assert.match(migration, /ai_messages ADD COLUMN content_purged_at timestamptz/);
    assert.match(migration, /ai_operations ADD COLUMN content_purged_at timestamptz/);
    assert.match(migration, /ai-content-retention/);
    assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM meal\.ai_|provider_cost.*null|token_usage.*null/i);
    const manifest = JSON.parse(readFileSync('database/manifest.json', 'utf8')) as {
        migrations: Array<{ version: number; file: string; sha256: string }>;
    };
    assert.deepEqual(manifest.migrations.at(-1), {
        version: 38,
        file: '038_ai_content_retention.sql',
        sha256: createHash('sha256').update(migration).digest('hex'),
    });
});

void test('AI retention is bounded, leased, legal-hold aware and idempotent', () => {
    assert.match(service, /maximumBatchSize = 100/);
    assert.match(service, /task\.created_at<=\$\{clock\}::timestamptz-interval '30 days'/);
    assert.match(service, /operation\.expires_at>\$\{clock\}::timestamptz/);
    assert.match(service, /hold\.kind='legal_hold' and hold\.status in\('active','approved'\)/);
    assert.match(service, /for update of task skip locked/i);
    assert.match(service, /task\.content_purged_at is null/);
    assert.match(service, /set body='',content_purged_at=/);
    assert.match(service, /set result_snapshot=null,content_purged_at=/);
    assert.match(service, /'contentExpired',true/);
    assert.doesNotMatch(service, /provider_request_id|provider_cost|token_usage|ai_ledger/);
});

void test('AI retention is an explicit destructive daily worker and continuation fails closed after purge', () => {
    const task = workerTopology().tasks.find((candidate) => candidate.id === 'ai-content-retention');
    assert.deepEqual(task, {
        id: 'ai-content-retention',
        executionMode: 'external_one_shot',
        argv: ['node', 'scripts/run-scheduled-task.mjs', 'ai-content-retention', '--apply'],
        activationEnvironment: null,
        defaultEnabled: false,
        mutating: true,
        destructive: true,
        overlapPolicy: 'skip_locked',
        batchLimit: 100,
        timeoutSeconds: 300,
        minimumIntervalSeconds: 86_400,
        requirements: [
            'database',
            'application_grants',
            'published_retention_policy',
            'admin_approval',
            'legal_hold_check',
        ],
    });
    const aiService = readFileSync('src/modules/ai/ai.service.ts', 'utf8');
    assert.match(aiService, /t\.accepted_at is not null and t\.content_purged_at is null/);
    assert.match(aiService, /t\.status='preview' and t\.content_purged_at is null/);
});
