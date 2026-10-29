import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { readConfig } from '../src/app/config.js';
import { WorkerModule } from '../src/app/worker.module.js';
import { WorkerRuntimeFactory } from '../src/infrastructure/workers/worker-runtime.factory.js';
import {
    readWorkerSchedulerConfig,
    WorkerScheduler,
    type ScheduledTaskId,
    type SchedulerExecution,
    type WorkerSchedulerConfig,
    type WorkerSchedulerExecutor,
    type WorkerSchedulerState,
} from '../src/modules/operational-runtime/worker-scheduler.js';

const baseEnv = {
    WORKER_OWNER_ID: 'worker-test',
    AI_RECONCILIATION_ENABLED: 'false',
    COOKING_LIFECYCLE_ENABLED: 'false',
};

void test('scheduler is fail-closed and activates only the explicit safe allowlist', () => {
    const disabled = readWorkerSchedulerConfig(baseEnv);
    assert.deepEqual(disabled.schedules, []);
    const enabled = readWorkerSchedulerConfig({
        ...baseEnv,
        WORKER_SCHEDULE_ALLOWLIST: 'scheduled-news,cooking-lifecycle',
    });
    assert.deepEqual(
        enabled.schedules.map((item) => item.id),
        ['scheduled-news', 'cooking-lifecycle'],
    );
    assert.throws(
        () => readWorkerSchedulerConfig({ ...baseEnv, WORKER_SCHEDULE_ALLOWLIST: 'exports' }),
        /Invalid option/,
    );
    assert.throws(
        () => readWorkerSchedulerConfig({ ...baseEnv, COOKING_LIFECYCLE_ENABLED: 'true' }),
        /Embedded worker modes/,
    );
    assert.throws(() => readWorkerSchedulerConfig({ ...baseEnv, WORKER_OWNER_ID: '' }), /stable WORKER_OWNER_ID/);
});

void test('schedule intervals are bounded by topology and scheduler limits', () => {
    assert.throws(
        () =>
            readWorkerSchedulerConfig({
                ...baseEnv,
                WORKER_SCHEDULE_ALLOWLIST: 'incident-ignore-expiry',
                WORKER_SCHEDULE_INCIDENTS_SECONDS: '60',
            }),
        /WORKER_SCHEDULE_INCIDENTS_SECONDS/,
    );
    assert.throws(
        () => readWorkerSchedulerConfig({ ...baseEnv, WORKER_STATE_FILE: '/tmp/health.json' }),
        /WORKER_STATE_FILE/,
    );
});

void test('minimal worker module resolves without HTTP authentication or provider secrets', async () => {
    const context = await NestFactory.createApplicationContext(
        WorkerModule.configure(
            readConfig({
                NODE_ENV: 'test',
                WORKER_OWNER_ID: 'worker-test',
                AI_RECONCILIATION_ENABLED: 'false',
                COOKING_LIFECYCLE_ENABLED: 'false',
                LOG_LEVEL: 'silent',
            }),
        ),
        { logger: false },
    );
    assert.ok(context.get(WorkerRuntimeFactory));
    await context.close();
});

class FakeExecutor implements WorkerSchedulerExecutor {
    readonly calls: ScheduledTaskId[] = [];
    shutdownGrace: number | null = null;
    results: SchedulerExecution[] = [];
    onRun: (() => void) | undefined;
    run(task: ScheduledTaskId): Promise<SchedulerExecution> {
        this.calls.push(task);
        this.onRun?.();
        return Promise.resolve(this.results.shift() ?? { outcome: 'success', observation: null });
    }
    shutdown(graceMs: number): Promise<void> {
        this.shutdownGrace = graceMs;
        return Promise.resolve();
    }
}

const config = (ids: ScheduledTaskId[]): WorkerSchedulerConfig => ({
    schedules: ids.map((id) => ({ id, intervalMs: 60_000, hardTimeoutMs: 70_000 })),
    jitterMs: 0,
    maximumBackoffMs: 300_000,
    poisonFailures: 3,
    poisonCooldownMs: 900_000,
    heartbeatMs: 15_000,
    shutdownGraceMs: 30_000,
    stateFile: '/run/meal-worker/health.json',
});

void test('restart is safe, overlap is neutral and lease loss/timeout back off', async () => {
    const writes: WorkerSchedulerState[] = [];
    const executor = new FakeExecutor();
    executor.results = [
        { outcome: 'failure', observation: null },
        { outcome: 'skipped_overlap', observation: null },
        { outcome: 'timeout', observation: null },
    ];
    const scheduler = new WorkerScheduler(
        config(['scheduled-news']),
        executor,
        (state) => {
            writes.push(state);
            return Promise.resolve();
        },
        1_000,
        () => 0,
        () => 0,
    );
    await scheduler.runDue(61_000);
    assert.equal(writes.at(-1)?.tasks[0]?.consecutiveFailures, 1);
    await scheduler.runDue(121_000);
    assert.equal(writes.at(-1)?.tasks[0]?.consecutiveFailures, 1);
    assert.equal(writes.at(-1)?.tasks[0]?.lastOutcome, 'skipped_overlap');
    await scheduler.runDue(181_000);
    assert.equal(writes.at(-1)?.tasks[0]?.consecutiveFailures, 2);
    const restarted = new WorkerScheduler(
        config(['scheduled-news']),
        new FakeExecutor(),
        () => Promise.resolve(),
        181_000,
        () => 0,
        () => 181_000,
    );
    assert.equal(restarted.snapshot(181_000).tasks[0]?.nextRunAt, new Date(241_000).toISOString());
});

void test('first run is delayed and a long execution never causes an immediate catch-up run', async () => {
    let clock = 0;
    const executor = new FakeExecutor();
    executor.onRun = () => {
        clock = 180_000;
    };
    const scheduler = new WorkerScheduler(
        config(['scheduled-news']),
        executor,
        () => Promise.resolve(),
        0,
        () => 0,
        () => clock,
    );
    assert.equal(scheduler.snapshot(0).tasks[0]?.nextRunAt, new Date(60_000).toISOString());
    assert.equal(await scheduler.runDue(59_999), null);
    assert.equal(await scheduler.runDue(60_000), 'scheduled-news');
    assert.equal(scheduler.snapshot(clock).tasks[0]?.nextRunAt, new Date(240_000).toISOString());
    assert.equal(await scheduler.runDue(180_000), null);
    assert.equal(executor.calls.length, 1);
});

void test('repeated failure poisons one task without blocking another', async () => {
    const executor = new FakeExecutor();
    executor.results = [
        { outcome: 'failure', observation: null },
        { outcome: 'success', observation: null },
        { outcome: 'failure', observation: null },
        { outcome: 'success', observation: null },
        { outcome: 'success', observation: null },
        { outcome: 'failure', observation: null },
    ];
    let latest: WorkerSchedulerState | undefined;
    const scheduler = new WorkerScheduler(
        config(['scheduled-news', 'scheduled-sanctions']),
        executor,
        (state) => {
            latest = state;
            return Promise.resolve();
        },
        0,
        () => 0,
        () => 0,
    );
    await scheduler.runDue(60_000);
    await scheduler.runDue(60_000);
    await scheduler.runDue(120_000);
    await scheduler.runDue(120_000);
    await scheduler.runDue(180_000);
    await scheduler.runDue(240_000);
    const news = latest?.tasks.find((task) => task.id === 'scheduled-news');
    assert.equal(news?.consecutiveFailures, 3);
    assert.ok(news?.poisonedUntil);
    await scheduler.runDue(240_000);
    assert.equal(executor.calls.at(-1), 'scheduled-sanctions');
});

void test('graceful shutdown publishes stopping/stopped evidence and terminates the child boundary', async () => {
    const states: WorkerSchedulerState[] = [];
    const executor = new FakeExecutor();
    const scheduler = new WorkerScheduler(config([]), executor, (state) => {
        states.push(state);
        return Promise.resolve();
    });
    await scheduler.shutdown(10_000);
    assert.deepEqual(
        states.map((state) => state.status),
        ['stopping', 'stopped'],
    );
    assert.equal(executor.shutdownGrace, 30_000);
});

void test('production compose isolates and hardens the worker without ingress or embedded loops', async () => {
    const compose = await readFile(new URL('../../deploy/compose.production.yml', import.meta.url), 'utf8');
    const worker = compose.slice(compose.indexOf('    worker:'), compose.indexOf('    frontend:'));
    assert.match(worker, /image: \$\{BACKEND_IMAGE:\?/);
    assert.match(worker, /user: node/);
    assert.match(worker, /read_only: true/);
    assert.match(worker, /cap_drop: \[ALL\]/);
    assert.match(worker, /networks: \[meal-db\]/);
    assert.match(worker, /WORKER_SCHEDULE_ALLOWLIST: \$\{WORKER_SCHEDULE_ALLOWLIST:-\}/);
    assert.match(worker, /WORKER_DATABASE_POOL_SIZE: \$\{WORKER_DATABASE_POOL_SIZE:-2\}/);
    assert.match(worker, /AI_RECONCILIATION_ENABLED: 'false'/);
    assert.match(worker, /COOKING_LIFECYCLE_ENABLED: 'false'/);
    assert.match(worker, /check-worker-health\.mjs/);
    assert.doesNotMatch(worker, /ports:|email-changes|exports|account-retention|ai-reconciliation/);
    assert.doesNotMatch(worker, /backend_security_key|backend_mfa_encryption_key/);
    const retention = await readFile(new URL('../../scripts/process-account-retention.mjs', import.meta.url), 'utf8');
    assert.match(retention, /planWorkerInvocation/);
    assert.match(retention, /--approval-ticket=/);
    assert.match(retention, /--approval-policy-version=/);
});
