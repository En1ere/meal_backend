import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    AI_CONTEXT_POLICY_VERSION,
    AI_TASK_RULE_VERSION,
    aiTaskContextPolicies,
    aiTasks,
} from '../src/modules/ai/public.js';
import { adminAiControlPlaneSchema } from '../src/modules/admin-ai/public.js';

void test('admin AI control plane projects every task without secrets or arbitrary provider fields', () => {
    const parsed = adminAiControlPlaneSchema.parse({
        schemaVersion: 2,
        generatedAt: '2026-11-06T17:20:00.000Z',
        executionAvailable: true,
        provider: { configured: true, kind: 'openai_compatible', model: 'gpt-6-luna' },
        policies: {
            task: { version: AI_TASK_RULE_VERSION, effectiveAt: '2026-11-06T00:00:00.000Z' },
            context: { version: AI_CONTEXT_POLICY_VERSION, effectiveAt: '2026-11-06T00:00:00.000Z' },
        },
        usage: {
            last24Hours: { tasks: 1, actions: 2, completed: 1, refunded: 0, failed: 0 },
            last30Days: { tasks: 2, actions: 4, completed: 1, refunded: 1, failed: 0 },
        },
        statuses: [{ status: 'completed', count: 1 }],
        operations: {
            lifecycle: [
                { state: 'queued', count: 1 },
                { state: 'unknown', count: 1 },
            ],
            financial: [
                { state: 'reserved', count: 1 },
                { state: 'reconciliation_hold', count: 1 },
            ],
            oldestQueuedAt: '2026-11-06T17:00:00.000Z',
            oldestRunningAt: null,
            unknownCount: 1,
            reconciliationHoldCount: 1,
        },
        tasks: aiTasks.map((task) => ({
            code: task.code,
            label: task.label,
            taskClass: task.taskClass,
            cost: task.cost,
            availableOn: task.minimumPlan === null ? [] : ['free'],
            requiredContext: [...aiTaskContextPolicies[task.code].required],
            optionalContext: [...aiTaskContextPolicies[task.code].optional],
        })),
    });
    assert.equal(parsed.tasks.length, 18);
    assert.equal(parsed.operations.reconciliationHoldCount, 1);
    assert.equal('token' in parsed.provider, false);
});

void test('admin AI endpoint is read-only, MFA guarded, audited and aggregate-only', () => {
    const [http, service, boundary] = [
        readFileSync(new URL('../../src/modules/admin-ai/admin-ai.http.ts', import.meta.url), 'utf8'),
        readFileSync(new URL('../../src/modules/admin-ai/admin-ai.service.ts', import.meta.url), 'utf8'),
        readFileSync(new URL('../../src/modules/admin-auth/admin-read-boundary.service.ts', import.meta.url), 'utf8'),
    ];
    assert.match(http, /@UseGuards\(AdminSessionGuard\)/);
    assert.match(http, /@Get\(\)/);
    assert.doesNotMatch(http, /@(Post|Put|Patch|Delete)\(/);
    assert.match(service, /admin\.ai\.read/);
    assert.match(service, /count\(t\.id\)/);
    assert.match(service, /financial_state='reconciliation_hold'/);
    assert.doesNotMatch(service, /prompt|goal|personalContext|AI_API_TOKEN/);
    assert.match(boundary, /'admin\.ai\.read'/);
});
