import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import {
    DisabledWorkerLeaseProvider,
    SanitizedJsonWorkerRuntimeSink,
    executeEmbeddedWorker,
    executeOneShotWorker,
    evaluateWorkerHealth,
    type AcquiredWorkerLease,
    type WorkerLeaseProvider,
    type WorkerLeaseRequest,
    workerLeaseRequestSchema,
    workerLeaseSeconds,
    workerRunObservationSchema,
} from '../src/modules/operational-runtime/worker-runtime.js';
import {
    BACKUP_RECOVERY_CONTRACT_VERSION,
    DisabledBackupProvider,
    recoveryReadiness,
    recoverySetSchema,
    restoreDrillEvidenceSchema,
    restoreDrillPlanSchema,
} from '../src/modules/operational-runtime/backup-recovery.js';
import {
    PRODUCTION_ACCEPTANCE_VERSION,
    productionAcceptanceEvidenceSchema,
    productionAcceptanceManifest,
    productionAcceptanceReadiness,
    productionAcceptanceTargetSchema,
} from '../src/modules/operational-runtime/production-acceptance.js';

const now = '2026-10-09T10:00:00.000Z';
const successRun = {
    topologyVersion: 1,
    task: 'scheduled-news',
    executionMode: 'external_one_shot',
    outcome: 'success',
    failureKind: null,
    startedAt: '2026-10-09T09:59:50.000Z',
    finishedAt: now,
    durationMs: 10_000,
    attempted: 3,
    succeeded: 3,
    deferred: 0,
    failed: 0,
} as const;

void test('worker lease requests are topology-bound and disabled lease fails closed', async () => {
    const request = {
        topologyVersion: 1,
        task: 'scheduled-news',
        ownerId: 'worker-primary',
        requestedAt: now,
        leaseSeconds: 180,
    };
    assert.equal(workerLeaseRequestSchema.safeParse(request).success, true);
    assert.equal(workerLeaseRequestSchema.safeParse({ ...request, leaseSeconds: 179 }).success, false);
    assert.equal(workerLeaseRequestSchema.safeParse({ ...request, token: 'forbidden' }).success, false);
    assert.equal(workerLeaseSeconds('scheduled-news'), 180);
    const disabled = new DisabledWorkerLeaseProvider();
    await assert.rejects(disabled.acquire(request as never), ServiceUnavailableException);
    assert.equal(await disabled.renew(request as never, {} as never), false);
    assert.equal(await disabled.release(request as never, {} as never), false);
});

class FakeLeaseProvider implements WorkerLeaseProvider {
    released = 0;
    renewed = 0;
    constructor(private readonly lease: Awaited<ReturnType<WorkerLeaseProvider['acquire']>>) {}
    status() {
        return { configured: true, provider: 'test' } as const;
    }
    acquire(request: WorkerLeaseRequest) {
        void request;
        return Promise.resolve(this.lease);
    }
    renew(request: WorkerLeaseRequest, lease: AcquiredWorkerLease) {
        void request;
        void lease;
        this.renewed++;
        return Promise.resolve(true);
    }
    release(request: WorkerLeaseRequest, lease: AcquiredWorkerLease) {
        void request;
        void lease;
        this.released++;
        return Promise.resolve(true);
    }
}

const acquiredLease = {
    acquired: true,
    leaseId: '00000000-0000-4000-8000-000000000001',
    fencingToken: '1',
    acquiredAt: now,
    expiresAt: '2026-10-09T10:03:00.000Z',
} as const;

void test('one-shot runtime executes under a lease, releases it and emits only the strict observation', async () => {
    const lease = new FakeLeaseProvider(acquiredLease);
    const lines: string[] = [];
    const result = await executeOneShotWorker({
        task: 'scheduled-news',
        ownerId: 'worker-primary',
        leaseProvider: lease,
        sink: new SanitizedJsonWorkerRuntimeSink((line) => lines.push(line)),
        run: () => Promise.resolve({ inspected: 2, published: 1, skipped: 1, privatePayload: 'not-observed' }),
        counters: (value) => ({
            attempted: value.inspected,
            succeeded: value.published,
            deferred: value.skipped,
            failed: 0,
        }),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.observation.outcome, 'success');
    assert.equal(lease.released, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /"event":"worker.run"/);
    assert.doesNotMatch(lines[0]!, /privatePayload|not-observed|leaseId|ownerId/);
});

void test('one-shot runtime skips an overlapping lease without invoking the task', async () => {
    let invoked = false;
    const result = await executeOneShotWorker({
        task: 'scheduled-news',
        ownerId: 'worker-secondary',
        leaseProvider: new FakeLeaseProvider({ acquired: false, reason: 'held' }),
        sink: new SanitizedJsonWorkerRuntimeSink(() => undefined),
        run: () => {
            invoked = true;
            return Promise.resolve(1);
        },
        counters: () => ({ attempted: 1, succeeded: 1, deferred: 0, failed: 0 }),
    });
    assert.equal(invoked, false);
    assert.equal(result.status, 'skipped');
    assert.equal(result.observation.outcome, 'skipped_overlap');
});

void test('one-shot runtime fails closed when fenced release loses ownership', async () => {
    const lease = new FakeLeaseProvider(acquiredLease);
    lease.release = () => Promise.resolve(false);
    const lines: string[] = [];
    const result = await executeOneShotWorker({
        task: 'scheduled-news',
        ownerId: 'worker-fenced',
        leaseProvider: lease,
        sink: new SanitizedJsonWorkerRuntimeSink((line) => lines.push(line)),
        run: () => Promise.resolve(1),
        counters: () => ({ attempted: 1, succeeded: 1, deferred: 0, failed: 0 }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.observation.failureKind, 'lease');
    assert.match(lines[1]!, /"reason":"lease_lost"/);
});

void test('one-shot runtime result is independent from a failed telemetry sink', async () => {
    const result = await executeOneShotWorker({
        task: 'scheduled-news',
        ownerId: 'worker-sink-failure',
        leaseProvider: new FakeLeaseProvider(acquiredLease),
        sink: {
            status: () => ({ configured: true, provider: 'failing-test' }),
            record: () => Promise.reject(new Error('sink unavailable')),
            alert: () => Promise.reject(new Error('sink unavailable')),
        },
        run: () => Promise.resolve(1),
        counters: () => ({ attempted: 1, succeeded: 1, deferred: 0, failed: 0 }),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.observation.outcome, 'success');
});

void test('embedded runtime uses the same shared lease boundary and topology mode', async () => {
    const lease = new FakeLeaseProvider({
        ...acquiredLease,
        expiresAt: '2026-10-09T10:02:00.000Z',
    });
    const result = await executeEmbeddedWorker({
        task: 'ai-reconciliation',
        ownerId: 'worker-embedded',
        leaseProvider: lease,
        sink: new SanitizedJsonWorkerRuntimeSink(() => undefined),
        run: () => Promise.resolve({ reconciled: 2 }),
        counters: (value) => ({ attempted: value.reconciled, succeeded: value.reconciled, deferred: 0, failed: 0 }),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.observation.executionMode, 'embedded_interval');
    assert.equal(lease.released, 1);
    await assert.rejects(
        executeEmbeddedWorker({
            task: 'scheduled-news',
            ownerId: 'worker-wrong-mode',
            leaseProvider: lease,
            sink: new SanitizedJsonWorkerRuntimeSink(() => undefined),
            run: () => Promise.resolve(0),
            counters: () => ({ attempted: 0, succeeded: 0, deferred: 0, failed: 0 }),
        }),
        /execution mode/,
    );
});

void test('one-shot runtime fails closed on timeout and emits a sanitized alert', async () => {
    const lines: string[] = [];
    let runSettled = false;
    const result = await executeOneShotWorker({
        task: 'scheduled-news',
        ownerId: 'worker-timeout',
        leaseProvider: new FakeLeaseProvider(acquiredLease),
        sink: new SanitizedJsonWorkerRuntimeSink((line) => lines.push(line)),
        run: () =>
            new Promise<number>((resolve) =>
                setTimeout(() => {
                    runSettled = true;
                    resolve(1);
                }, 30),
            ),
        counters: () => ({ attempted: 1, succeeded: 1, deferred: 0, failed: 0 }),
        timeoutMs: 2,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.observation.outcome, 'timeout');
    assert.equal(runSettled, true);
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /"event":"worker.alert"/);
    assert.doesNotMatch(lines.join(''), /worker_timeout|stack|payload/);
});

void test('worker observations are strict and balance bounded counters', () => {
    assert.equal(workerRunObservationSchema.safeParse(successRun).success, true);
    assert.equal(workerRunObservationSchema.safeParse({ ...successRun, attempted: 4 }).success, false);
    assert.equal(
        workerRunObservationSchema.safeParse({ ...successRun, executionMode: 'embedded_interval' }).success,
        false,
    );
    assert.equal(workerRunObservationSchema.safeParse({ ...successRun, payload: { private: true } }).success, false);
});

void test('prepared worker lease migration is manifest-bound and grants no delete privilege', () => {
    const migration = readFileSync('database/migrations/024_worker_leases.sql');
    const manifest = JSON.parse(readFileSync('database/manifest.json', 'utf8')) as {
        totalTables: number;
        foreignKeys: number;
        migrations: Array<{ version: number; file: string; sha256: string }>;
    };
    const grants = readFileSync('database/application-grants.sql', 'utf8');
    assert.deepEqual(
        manifest.migrations.find((item) => item.version === 24),
        {
            version: 24,
            file: '024_worker_leases.sql',
            sha256: createHash('sha256').update(migration).digest('hex'),
        },
    );
    assert.equal(manifest.totalTables, 212);
    assert.equal(manifest.foreignKeys, 488);
    assert.match(grants, /GRANT SELECT,INSERT ON meal\.worker_leases TO meal_app/);
    assert.doesNotMatch(grants, /GRANT DELETE ON meal\.worker_leases/);
});

void test('worker health distinguishes disabled, fresh, stale, repeated failure and invalid clock', () => {
    const base = {
        task: 'scheduled-news' as const,
        enabled: true,
        activatedAt: new Date(now),
        observations: [successRun],
    };
    assert.equal(evaluateWorkerHealth({ ...base, enabled: false }).status, 'disabled');
    assert.equal(evaluateWorkerHealth({ ...base, clock: new Date('2026-10-09T10:01:00.000Z') }).status, 'healthy');
    assert.equal(evaluateWorkerHealth({ ...base, clock: new Date('2026-10-09T10:07:00.000Z') }).status, 'critical');
    assert.equal(
        evaluateWorkerHealth({ ...base, clock: new Date('2026-10-09T09:50:00.000Z') }).reason,
        'clock_invalid',
    );
    const failure = {
        ...successRun,
        outcome: 'failure' as const,
        failureKind: 'internal' as const,
        succeeded: 0,
        failed: 3,
    };
    assert.equal(evaluateWorkerHealth({ ...base, observations: [failure, failure, failure] }).status, 'critical');
});

const artifacts = [
    'postgres_custom_dump',
    'media_archive',
    'media_manifest',
    'migration_manifest',
    'grants_manifest',
].map((kind, index) => ({
    kind,
    artifactId: `00000000-0000-4000-8000-00000000000${index}`,
    locator: `offsite/recovery/artifact-${index}`,
    createdAt: now,
    sizeBytes: 100,
    checksum: `sha256:${String(index).repeat(64)}`,
    encrypted: true,
    immutable: true,
    offsite: true,
    retentionPolicyVersion: 1,
}));
const recoverySet = {
    contractVersion: BACKUP_RECOVERY_CONTRACT_VERSION,
    state: 'ready',
    database: 'meal_planner_postgres',
    postgresMajor: 18,
    schemaVersion: 30,
    migrationManifestChecksum: `sha256:${'a'.repeat(64)}`,
    snapshotAt: now,
    secrets: 'excluded',
    artifacts,
};
const gates = {
    artifactHashes: true,
    schemaVersion: true,
    tableCount212: true,
    foreignKeyCount488: true,
    applicationRole: true,
    domainSmoke: true,
    mediaCoverage: true,
};

void test('recovery set requires one encrypted immutable offsite artifact of every kind', () => {
    assert.equal(recoverySetSchema.safeParse(recoverySet).success, true);
    assert.equal(recoverySetSchema.safeParse({ ...recoverySet, contractVersion: 2 }).success, false);
    assert.equal(recoverySetSchema.safeParse({ ...recoverySet, contractVersion: 4 }).success, false);
    assert.equal(recoverySetSchema.safeParse({ ...recoverySet, schemaVersion: 29 }).success, false);
    assert.equal(recoverySetSchema.safeParse({ ...recoverySet, schemaVersion: 31 }).success, false);
    assert.equal(recoverySetSchema.safeParse({ ...recoverySet, artifacts: artifacts.slice(1) }).success, false);
    assert.equal(recoverySetSchema.safeParse({ ...recoverySet, secrets: 'included' }).success, false);
});

void test('restore planning allows only an empty isolated test target and complete evidence', () => {
    const plan = {
        contractVersion: BACKUP_RECOVERY_CONTRACT_VERSION,
        targetEnvironment: 'ephemeral_test',
        targetDatabase: 'meal_planner_postgres',
        isolatedTarget: true,
        emptyTargetConfirmed: true,
        sourceMutationAllowed: false,
        timeoutSeconds: 3600,
        changeTicket: 'OPS-2048',
        policyVersion: 1,
        recoverySet,
    };
    assert.equal(restoreDrillPlanSchema.safeParse(plan).success, true);
    assert.equal(restoreDrillPlanSchema.safeParse({ ...plan, targetEnvironment: 'production' }).success, false);
    assert.equal(
        restoreDrillEvidenceSchema.safeParse({
            contractVersion: BACKUP_RECOVERY_CONTRACT_VERSION,
            outcome: 'passed',
            sourceUnchanged: true,
            policyVersion: 1,
            recoverySetSnapshotAt: now,
            migrationManifestChecksum: recoverySet.migrationManifestChecksum,
            measuredRestoreSeconds: 600,
            recoveredSnapshotAt: now,
            gates: { ...gates, mediaCoverage: false },
        }).success,
        false,
    );
});

void test('recovery readiness needs approved objectives, a valid set and measured passing drill', async () => {
    const evidence = {
        contractVersion: BACKUP_RECOVERY_CONTRACT_VERSION,
        outcome: 'passed',
        sourceUnchanged: true,
        policyVersion: 1,
        recoverySetSnapshotAt: now,
        migrationManifestChecksum: recoverySet.migrationManifestChecksum,
        measuredRestoreSeconds: 600,
        recoveredSnapshotAt: now,
        gates,
    };
    const policy = {
        policyVersion: 1,
        rpoSeconds: 3600,
        rtoSeconds: 900,
        approvedAt: now,
        approvedByRole: 'operations',
    };
    assert.deepEqual(recoveryReadiness({ policy: null, recoverySet, lastDrill: evidence }), {
        status: 'blocked',
        reason: 'objectives_unapproved',
    });
    assert.deepEqual(
        recoveryReadiness({ policy, recoverySet, lastDrill: evidence, clock: new Date('2026-10-09T10:30:00Z') }),
        { status: 'ready', reason: 'verified' },
    );
    assert.deepEqual(
        recoveryReadiness({
            policy,
            recoverySet,
            lastDrill: { ...evidence, recoverySetSnapshotAt: '2026-10-09T09:00:00.000Z' },
            clock: new Date('2026-10-09T10:30:00Z'),
        }),
        { status: 'blocked', reason: 'restore_unproven' },
    );
    await assert.rejects(new DisabledBackupProvider().lookup('set-1'), ServiceUnavailableException);
});

const acceptanceTarget = {
    version: PRODUCTION_ACCEPTANCE_VERSION,
    publicOrigin: 'https://meal.example',
    adminOrigin: 'https://admin.meal.example',
    apiOrigin: 'https://api.meal.example',
    release: { root: '0.0.150', back: '0.0.76', front: '0.0.69', admin: '0.0.74', openapi: '0.0.58' },
    allowMutations: false,
    acknowledgedAt: now,
};

void test('production acceptance target requires exact public HTTPS origins and no mutations', () => {
    assert.equal(productionAcceptanceTargetSchema.safeParse(acceptanceTarget).success, true);
    assert.equal(
        productionAcceptanceTargetSchema.safeParse({ ...acceptanceTarget, publicOrigin: 'http://localhost:3000' })
            .success,
        false,
    );
    assert.equal(
        productionAcceptanceTargetSchema.safeParse({ ...acceptanceTarget, allowMutations: true }).success,
        false,
    );
});

void test('production acceptance passes only with every check on desktop and mobile', () => {
    const results = productionAcceptanceManifest.devices.flatMap((device) =>
        productionAcceptanceManifest.checks.map((check) => ({ device, check, passed: true })),
    );
    const evidence = {
        version: PRODUCTION_ACCEPTANCE_VERSION,
        target: acceptanceTarget,
        executedAt: now,
        mutationRequests: 0,
        results,
    };
    assert.equal(productionAcceptanceEvidenceSchema.safeParse(evidence).success, true);
    assert.deepEqual(productionAcceptanceReadiness(evidence), { status: 'passed' });
    assert.deepEqual(productionAcceptanceReadiness({ ...evidence, results: results.slice(1) }), {
        status: 'blocked',
        reason: 'not_executed_or_failed',
    });
    assert.deepEqual(productionAcceptanceReadiness({ ...evidence, results: [...results.slice(0, -1), results[0]] }), {
        status: 'blocked',
        reason: 'not_executed_or_failed',
    });
});
