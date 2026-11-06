import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const processor = readFileSync('src/modules/ai/ai-operation.processor.ts', 'utf8');
const compose = readFileSync('deploy/compose.ai-worker.yml', 'utf8');
const productionCompose = readFileSync('deploy/compose.production.yml', 'utf8');
const provision = readFileSync('deploy/provision-ai-worker-runtime.sh', 'utf8');
const grants = readFileSync('database/application-grants.sql', 'utf8');

void test('AI worker claims bounded queue work with serializable leases and fencing', () => {
    assert.match(processor, /setIsolationLevel\('serializable'\)/);
    assert.match(processor, /for update of o skip locked/i);
    assert.match(processor, /lifecycle_state='running'/);
    assert.match(processor, /lease_token=\$\{job\.leaseToken\}::uuid/);
    assert.match(processor, /lease_until>now\(\) for update/);
    assert.match(processor, /attempt_count=\$\{attemptNo\}/);
});

void test('AI worker rechecks access, tariff and sensitive consents before provider dispatch', () => {
    assert.match(processor, /scope in \('account','ai'\)/);
    assert.match(processor, /aiTaskAvailable\(aiTask\(job\.taskType\), plan\)/);
    assert.match(processor, /kind='ai_data_access'/);
    assert.match(processor, /kind='special_category'/);
    assert.match(processor, /if \(!\(await this\.authorized\(job\)\)\)/);
});

void test('AI worker renders continuation history and restores an included clarification on confirmed failure', () => {
    assert.match(processor, /o\.command_kind "commandKind"/);
    assert.match(processor, /job\.commandKind === 'continuation'/);
    assert.match(processor, /order by m\.created_at desc,m\.id desc limit 40/);
    assert.match(processor, /greatest\(0,clarifications_used-1\)/);
    assert.match(processor, /Продолжи ту же цель беседы/);
});

void test('AI worker holds unknown outcomes and only releases confirmed failures', () => {
    assert.match(processor, /lifecycle_state='unknown'/);
    assert.match(processor, /financial_state='reconciliation_hold'/);
    assert.match(processor, /error\.disposition === 'release'/);
    assert.match(processor, /return this\.unknown\(job\)/);
    assert.doesNotMatch(processor, /unknown[\s\S]{0,300}kind,'release'/);
});

void test('AI worker is an isolated egress container with file-mounted secrets and a least-privilege role', () => {
    assert.match(compose, /DATABASE_URL_FILE: \/run\/secrets\/ai_worker_database_url/);
    assert.match(compose, /AI_API_TOKEN_FILE: \/run\/secrets\/ai_api_token/);
    assert.match(productionCompose, /AI_BACKGROUND_EXECUTION_ENABLED: \$\{AI_WORKER_ENABLED:-false\}/);
    assert.match(compose, /networks: \[meal-db, meal-egress\]/);
    assert.match(compose, /read_only: true/);
    assert.match(compose, /cap_drop: \[ALL\]/);
    assert.match(provision, /create role meal_ai_worker nologin noinherit/);
    assert.match(provision, /create role meal_ai_runtime login noinherit/);
    assert.match(provision, /grant meal_ai_worker to meal_ai_runtime with inherit false,set true/);
    assert.match(provision, /grant update\(lifecycle_state,financial_state/);
    assert.doesNotMatch(grants, /INSERT ON[^;]*ai_operation_attempts[^;]*TO meal_app/s);
    assert.doesNotMatch(grants, /UPDATE\([^)]*lease_token[^)]*\) ON meal\.ai_operations TO meal_app/s);
});
