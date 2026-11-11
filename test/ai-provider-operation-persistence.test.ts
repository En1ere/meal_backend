import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
    aiV2ProviderNextCommand,
    aiV2ProviderTransitionAllowed,
    type AiV2ProviderDispatchState,
} from '../src/modules/ai/public.js';

const text = (path: string) => readFile(path, 'utf8');

void test('schema v41 stores one sanitized provider dispatch per contract-v2 model operation', async () => {
    const migration = await text('database/migrations/041_ai_provider_dispatch.sql');
    assert.match(migration, /CREATE TABLE meal\.ai_provider_dispatches/u);
    assert.match(migration, /operation_id uuid PRIMARY KEY REFERENCES meal\.ai_operations/u);
    assert.match(migration, /client_request_id uuid NOT NULL UNIQUE/u);
    assert.match(migration, /provider_response_id varchar\(200\)/u);
    assert.match(migration, /contract_version<>2 OR operation\.execution_route NOT IN\('economy','balanced'\)/u);
    assert.match(migration, /NEW\.estimated_cost_rub>operation\.provider_cost_ceiling_minor::numeric\/100/u);
    assert.doesNotMatch(migration, /prompt\s+(?:text|jsonb)|context\s+(?:text|jsonb)|raw_(?:response|error)/iu);
});

void test('schema v41 permits exactly one submit and readback only after immutable provider identity', async () => {
    const migration = await text('database/migrations/041_ai_provider_dispatch.sql');
    assert.match(migration, /OLD\.state='prepared' AND NEW\.state='submit_claimed'/u);
    assert.match(
        migration,
        /OLD\.state='submit_claimed' AND NEW\.state IN\('accepted','rejected','unknown_without_identity'\)/u,
    );
    assert.match(
        migration,
        /OLD\.state IN\('accepted','queued','running','read_unknown'\) AND NEW\.state='read_claimed'/u,
    );
    assert.match(migration, /AI provider response identity is immutable/u);
    assert.match(migration, /terminal AI provider dispatch is immutable/u);
    assert.doesNotMatch(migration, /unknown_without_identity'\s*AND NEW\.state='submit_claimed/u);
});

void test('provider dispatch state machine has no retry-submit, fallback or escalation path', () => {
    const terminal: AiV2ProviderDispatchState[] = [
        'succeeded',
        'failed',
        'cancelled',
        'incomplete',
        'rejected',
        'unknown_without_identity',
    ];
    assert.equal(aiV2ProviderTransitionAllowed('prepared', 'submit_claimed'), true);
    assert.equal(aiV2ProviderTransitionAllowed('submit_claimed', 'unknown_without_identity'), true);
    assert.equal(aiV2ProviderTransitionAllowed('unknown_without_identity', 'submit_claimed'), false);
    assert.equal(aiV2ProviderNextCommand('unknown_without_identity'), 'none');
    assert.equal(aiV2ProviderNextCommand('read_unknown'), 'read');
    for (const state of terminal) assert.equal(aiV2ProviderNextCommand(state), 'none');
});

void test('v2 store uses serializable CAS and separates no-id unknown from ID readback unknown', async () => {
    const [store, migration39, migration41] = await Promise.all([
        text('src/modules/ai/ai-provider-operation.store.ts'),
        text('database/migrations/039_ai_policy_v4_foundation.sql'),
        text('database/migrations/041_ai_provider_dispatch.sql'),
    ]);
    assert.match(store, /setIsolationLevel\('serializable'\)/u);
    assert.match(store, /state='prepared'[\s\S]*version=\$\{input\.expectedVersion\}/u);
    assert.match(store, /state='submit_claimed'[\s\S]*lease_token=\$\{input\.leaseToken\}/u);
    assert.match(
        store,
        /state in\('accepted','queued','running','read_unknown'\)[\s\S]*provider_response_id is not null/u,
    );
    assert.match(store, /unknown_without_identity'[\s\S]*provider_cost_state=\$\{unknown \? 'estimated_hold'/u);
    assert.match(store, /state='read_unknown'[\s\S]*provider_outcome_unknown/u);
    assert.match(
        migration39,
        /provider_request_id IS NULL AND financial_state='released' AND provider_cost_state='estimated_hold'/u,
    );
    assert.match(migration41, /CREATE TRIGGER zz_prepare_contract_v2/u);
});

void test('expired submit becomes no-identity unknown while expired read remains GET-reconcilable', async () => {
    const [store, reconciliation] = await Promise.all([
        text('src/modules/ai/ai-provider-operation.store.ts'),
        text('src/modules/ai/ai-reconciliation.service.ts'),
    ]);
    assert.match(store, /state in\('submit_claimed','read_claimed'\)[\s\S]*lease_until<=\$\{input\.clock\}/u);
    assert.match(store, /row\.state === 'submit_claimed'[\s\S]*'unknown_without_identity'/u);
    assert.match(store, /recordUnknownRead\(tx, input, \{ kind: 'unknown'/u);
    assert.match(store, /expectedVersion[\s\S]*leaseToken/u);
    assert.match(reconciliation, /meal\.ai_provider_dispatches/u);
    assert.match(reconciliation, /providerOperations\.expireClaim/u);
    assert.match(reconciliation, /contract_version in\(0,1\)/u);
    assert.doesNotMatch(reconciliation, /YandexAiAdapter|\.submit\(|\.read\(/u);
});

void test('schema v41 manifest hash and counts bind the additive migration', async () => {
    const [migration, manifestText] = await Promise.all([
        text('database/migrations/041_ai_provider_dispatch.sql'),
        text('database/manifest.json'),
    ]);
    const manifest = JSON.parse(manifestText) as {
        domainTables: number;
        totalTables: number;
        foreignKeys: number;
        migrations: ReadonlyArray<{ version: number; file: string; sha256: string }>;
    };
    assert.equal(manifest.domainTables, 224);
    assert.equal(manifest.totalTables, 229);
    assert.equal(manifest.foreignKeys, 523);
    assert.deepEqual(manifest.migrations.at(-1), {
        version: 41,
        file: '041_ai_provider_dispatch.sql',
        sha256: createHash('sha256').update(migration).digest('hex'),
    });
});
