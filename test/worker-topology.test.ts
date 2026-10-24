import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    WORKER_TOPOLOGY_VERSION,
    WorkerTopologyError,
    planWorkerInvocation,
    workerTaskIdSchema,
    workerTopology,
    workerTopologySchema,
} from '../src/modules/operational-runtime/worker-topology.js';

const request = {
    topologyVersion: WORKER_TOPOLOGY_VERSION,
    task: 'scheduled-news',
    deploymentId: 'production-primary',
    requestedAt: '2026-10-09T09:00:00.000Z',
    apply: true,
    maxItems: 25,
    timeoutSeconds: 120,
    destructiveApproval: null,
} as const;

void test('worker topology covers every task exactly once and keeps all activation opt-in', () => {
    const topology = workerTopology();
    assert.equal(workerTopologySchema.safeParse(topology).success, true);
    assert.deepEqual(topology.tasks.map((task) => task.id).sort(), [...workerTaskIdSchema.options].sort());
    assert.equal(
        topology.tasks.every((task) => task.defaultEnabled === false),
        true,
    );
});

void test('external commands are fixed argv while embedded loops require explicit environment flags', () => {
    for (const task of workerTopology().tasks) {
        if (task.executionMode === 'external_one_shot') {
            assert.equal(task.argv?.[0], 'node');
            assert.equal(task.argv?.at(-1), '--apply');
            assert.equal(task.activationEnvironment, null);
        } else {
            assert.equal(task.argv, null);
            assert.match(task.activationEnvironment ?? '', /_ENABLED$/);
        }
    }
});

void test('safe invocation plan is bounded by the immutable task policy', () => {
    const plan = planWorkerInvocation(request);
    assert.equal(plan.task, 'scheduled-news');
    assert.equal(plan.overlapPolicy, 'skip_locked');
    assert.deepEqual(plan.argv, ['node', 'scripts/process-operational-maintenance.mjs', 'news', '--apply']);
    assert.throws(
        () => planWorkerInvocation({ ...request, maxItems: 26 }),
        (error: unknown) => error instanceof WorkerTopologyError && error.code === 'limit_exceeded',
    );
    assert.equal(workerTopology().tasks.find((task) => task.id === 'scheduled-news')?.batchLimit, 25);
    assert.throws(
        () => planWorkerInvocation({ ...request, task: 'ai-reconciliation' }),
        (error: unknown) => error instanceof WorkerTopologyError && error.code === 'not_one_shot',
    );
});

void test('invocation rejects dry-run ambiguity, unknown fields and stale topology versions', () => {
    assert.throws(() => planWorkerInvocation({ ...request, apply: false }));
    assert.throws(() => planWorkerInvocation({ ...request, topologyVersion: 2 }));
    assert.throws(() => planWorkerInvocation({ ...request, token: 'must-not-cross-boundary' }));
});

void test('destructive retention requires a versioned approval and other tasks reject one', () => {
    const retention = { ...request, task: 'account-retention', maxItems: 25, timeoutSeconds: 900 } as const;
    assert.throws(
        () => planWorkerInvocation(retention),
        (error: unknown) => error instanceof WorkerTopologyError && error.code === 'approval_required',
    );
    const approved = planWorkerInvocation({
        ...retention,
        destructiveApproval: { changeTicket: 'OPS-2048', policyVersion: 3 },
    });
    assert.equal(approved.destructive, true);
    assert.throws(
        () => planWorkerInvocation({ ...request, destructiveApproval: { changeTicket: 'OPS-2048', policyVersion: 3 } }),
        (error: unknown) => error instanceof WorkerTopologyError && error.code === 'approval_required',
    );
});

void test('topology projection contains no credentials, URLs or arbitrary scheduler expressions', () => {
    const serialized = JSON.stringify(workerTopology());
    assert.doesNotMatch(serialized, /token|secret|password|https?:|cron/i);
});
