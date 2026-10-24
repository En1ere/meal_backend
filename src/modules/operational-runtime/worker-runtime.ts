import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { WORKER_TOPOLOGY_VERSION, workerTaskIdSchema, workerTopology } from './worker-topology.js';

export const workerLeaseRequestSchema = z
    .strictObject({
        topologyVersion: z.literal(WORKER_TOPOLOGY_VERSION),
        task: workerTaskIdSchema,
        ownerId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
        requestedAt: z.iso.datetime(),
        leaseSeconds: z.number().int().min(40).max(3_900),
    })
    .superRefine((value, context) => {
        if (value.leaseSeconds !== workerLeaseSeconds(value.task))
            context.addIssue({ code: 'custom', path: ['leaseSeconds'], message: 'Lease must match task topology' });
    });
export const workerLeaseSchema = z.discriminatedUnion('acquired', [
    z.strictObject({ acquired: z.literal(false), reason: z.enum(['held', 'unavailable']) }),
    z.strictObject({
        acquired: z.literal(true),
        leaseId: z.uuid(),
        fencingToken: z.string().regex(/^[1-9][0-9]{0,19}$/),
        acquiredAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
    }),
]);
export type WorkerLeaseRequest = z.infer<typeof workerLeaseRequestSchema>;
export type WorkerLease = z.infer<typeof workerLeaseSchema>;
export type AcquiredWorkerLease = Extract<WorkerLease, { acquired: true }>;

export interface WorkerLeaseProvider {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    acquire(request: WorkerLeaseRequest): Promise<WorkerLease>;
    renew(request: WorkerLeaseRequest, lease: AcquiredWorkerLease): Promise<boolean>;
    release(request: WorkerLeaseRequest, lease: AcquiredWorkerLease): Promise<boolean>;
}

export class DisabledWorkerLeaseProvider implements WorkerLeaseProvider {
    status() {
        return { configured: false, provider: null } as const;
    }
    acquire(request: WorkerLeaseRequest): Promise<WorkerLease> {
        void request;
        return Promise.reject(new ServiceUnavailableException('Worker lease provider is not configured'));
    }
    renew(request: WorkerLeaseRequest, lease: AcquiredWorkerLease): Promise<boolean> {
        void request;
        void lease;
        return Promise.resolve(false);
    }
    release(request: WorkerLeaseRequest, lease: AcquiredWorkerLease): Promise<boolean> {
        void request;
        void lease;
        return Promise.resolve(false);
    }
}

type LeaseRow = {
    leaseId: string;
    fencingToken: string;
    acquiredAt: Date;
    expiresAt: Date;
};

/** PostgreSQL-clock lease. The monotonically increasing fencing token is checked on renew and release. */
export class PostgresWorkerLeaseProvider implements WorkerLeaseProvider {
    constructor(private readonly database: Kysely<DatabaseSchema> | undefined) {}

    status() {
        return { configured: Boolean(this.database), provider: this.database ? 'postgresql' : null } as const;
    }

    async acquire(raw: WorkerLeaseRequest): Promise<WorkerLease> {
        const request = workerLeaseRequestSchema.parse(raw);
        if (!this.database) return { acquired: false, reason: 'unavailable' };
        const leaseId = randomUUID();
        try {
            const result = await this.transaction((tx) =>
                sql<LeaseRow>`
                insert into meal.worker_leases(
                    task,owner_id,lease_id,fencing_token,acquired_at,expires_at,updated_at,version
                ) values(
                    ${request.task},${request.ownerId},${leaseId}::uuid,1,
                    clock_timestamp(),clock_timestamp()+(${request.leaseSeconds}*interval '1 second'),clock_timestamp(),1
                )
                on conflict(task) do update set
                    owner_id=excluded.owner_id,
                    lease_id=excluded.lease_id,
                    fencing_token=meal.worker_leases.fencing_token+1,
                    acquired_at=clock_timestamp(),
                    expires_at=clock_timestamp()+(${request.leaseSeconds}*interval '1 second'),
                    updated_at=clock_timestamp(),
                    version=meal.worker_leases.version+1
                where meal.worker_leases.expires_at<=clock_timestamp()
                returning lease_id as "leaseId",fencing_token::text as "fencingToken",
                          acquired_at as "acquiredAt",expires_at as "expiresAt"
            `.execute(tx),
            );
            const row = result.rows[0];
            if (!row) return { acquired: false, reason: 'held' };
            return workerLeaseSchema.parse({
                acquired: true,
                leaseId: row.leaseId,
                fencingToken: row.fencingToken,
                acquiredAt: row.acquiredAt.toISOString(),
                expiresAt: row.expiresAt.toISOString(),
            });
        } catch {
            return { acquired: false, reason: 'unavailable' };
        }
    }

    async renew(raw: WorkerLeaseRequest, rawLease: AcquiredWorkerLease): Promise<boolean> {
        const request = workerLeaseRequestSchema.parse(raw);
        const lease = workerLeaseSchema.parse(rawLease) as AcquiredWorkerLease;
        if (!this.database) return false;
        try {
            const result = await this.transaction((tx) =>
                sql`
                update meal.worker_leases set
                    expires_at=clock_timestamp()+(${request.leaseSeconds}*interval '1 second'),
                    updated_at=clock_timestamp(),version=version+1
                where task=${request.task} and owner_id=${request.ownerId} and lease_id=${lease.leaseId}::uuid
                  and fencing_token=${lease.fencingToken}::bigint and expires_at>clock_timestamp()
            `.execute(tx),
            );
            return Number(result.numAffectedRows ?? 0) === 1;
        } catch {
            return false;
        }
    }

    async release(raw: WorkerLeaseRequest, rawLease: AcquiredWorkerLease): Promise<boolean> {
        const request = workerLeaseRequestSchema.parse(raw);
        const lease = workerLeaseSchema.parse(rawLease) as AcquiredWorkerLease;
        if (!this.database) return false;
        try {
            const result = await this.transaction((tx) =>
                sql`
                update meal.worker_leases set
                    expires_at=greatest(clock_timestamp(),acquired_at+interval '1 microsecond'),
                    updated_at=clock_timestamp(),version=version+1
                where task=${request.task} and owner_id=${request.ownerId} and lease_id=${lease.leaseId}::uuid
                  and fencing_token=${lease.fencingToken}::bigint and expires_at>clock_timestamp()
            `.execute(tx),
            );
            return Number(result.numAffectedRows ?? 0) === 1;
        } catch {
            return false;
        }
    }

    private async transaction<T>(run: (tx: Transaction<DatabaseSchema>) => Promise<T>): Promise<T> {
        if (!this.database) throw new Error('Database not configured');
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.database.transaction().setIsolationLevel('serializable').execute(run);
            } catch (error) {
                const code = error instanceof Error && 'code' in error ? error.code : undefined;
                if (attempt >= 2 || (code !== '40001' && code !== '40P01')) throw error;
                await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
            }
        }
    }
}

export function workerLeaseSeconds(taskId: z.infer<typeof workerTaskIdSchema>): number {
    const task = workerTopology().tasks.find((candidate) => candidate.id === taskId)!;
    return Math.min(3_900, task.timeoutSeconds + 60);
}

export const workerRunObservationSchema = z
    .strictObject({
        topologyVersion: z.literal(WORKER_TOPOLOGY_VERSION),
        task: workerTaskIdSchema,
        executionMode: z.enum(['external_one_shot', 'embedded_interval']),
        outcome: z.enum(['success', 'partial', 'skipped_overlap', 'skipped_not_ready', 'timeout', 'failure']),
        failureKind: z.enum(['database', 'dependency', 'lease', 'timeout', 'validation', 'internal']).nullable(),
        startedAt: z.iso.datetime(),
        finishedAt: z.iso.datetime(),
        durationMs: z.number().int().min(0).max(3_600_000),
        attempted: z.number().int().min(0).max(1_000_000),
        succeeded: z.number().int().min(0).max(1_000_000),
        deferred: z.number().int().min(0).max(1_000_000),
        failed: z.number().int().min(0).max(1_000_000),
    })
    .superRefine((value, context) => {
        if (value.attempted !== value.succeeded + value.deferred + value.failed)
            context.addIssue({ code: 'custom', path: ['attempted'], message: 'Worker counters must balance' });
        if (value.outcome === 'success' && (value.failed !== 0 || value.failureKind !== null))
            context.addIssue({ code: 'custom', path: ['outcome'], message: 'Successful runs cannot contain failures' });
        if (value.outcome.startsWith('skipped_') && value.attempted !== 0)
            context.addIssue({ code: 'custom', path: ['outcome'], message: 'Skipped runs cannot attempt items' });
        const task = workerTopology().tasks.find((candidate) => candidate.id === value.task)!;
        if (value.executionMode !== task.executionMode)
            context.addIssue({ code: 'custom', path: ['executionMode'], message: 'Mode must match task topology' });
        if (Date.parse(value.finishedAt) < Date.parse(value.startedAt))
            context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'Run cannot finish before it starts' });
    });
export type WorkerRunObservation = z.infer<typeof workerRunObservationSchema>;

export const workerAlertSchema = z.strictObject({
    task: workerTaskIdSchema,
    severity: z.enum(['warning', 'critical']),
    reason: z.enum(['run_failed', 'run_timed_out', 'lease_unavailable', 'lease_lost']),
    failureKind: workerRunObservationSchema.shape.failureKind,
    dedupKey: z.string().regex(/^worker:[a-z0-9-]+:(?:failures|lease)$/),
    occurredAt: z.iso.datetime(),
});
export type WorkerAlert = z.infer<typeof workerAlertSchema>;

export interface WorkerRuntimeSink {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    record(observation: WorkerRunObservation): Promise<void>;
    alert(alert: WorkerAlert): Promise<void>;
}

export class DisabledWorkerRuntimeSink implements WorkerRuntimeSink {
    status() {
        return { configured: false, provider: null } as const;
    }
    record(observation: WorkerRunObservation): Promise<void> {
        void observation;
        return Promise.resolve();
    }
    alert(alert: WorkerAlert): Promise<void> {
        void alert;
        return Promise.resolve();
    }
}

/** Emits only schema-validated, payload-free JSON records; callers choose stderr/stdout or another safe writer. */
export class SanitizedJsonWorkerRuntimeSink implements WorkerRuntimeSink {
    constructor(private readonly write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)) {}
    status() {
        return { configured: true, provider: 'json' } as const;
    }
    record(raw: WorkerRunObservation): Promise<void> {
        const observation = workerRunObservationSchema.parse(raw);
        this.write(JSON.stringify({ event: 'worker.run', ...observation }));
        return Promise.resolve();
    }
    alert(raw: WorkerAlert): Promise<void> {
        const alert = workerAlertSchema.parse(raw);
        this.write(JSON.stringify({ event: 'worker.alert', ...alert }));
        return Promise.resolve();
    }
}

export const workerCountersSchema = z.strictObject({
    attempted: z.number().int().min(0).max(1_000_000),
    succeeded: z.number().int().min(0).max(1_000_000),
    deferred: z.number().int().min(0).max(1_000_000),
    failed: z.number().int().min(0).max(1_000_000),
});
export type WorkerCounters = z.infer<typeof workerCountersSchema>;

export type WorkerExecutionResult<T> = Readonly<{
    status: 'completed' | 'skipped' | 'failed';
    observation: WorkerRunObservation;
    result: T | null;
}>;

export type WorkerExecutionInput<T> = {
    task: z.infer<typeof workerTaskIdSchema>;
    ownerId: string;
    leaseProvider: WorkerLeaseProvider;
    sink: WorkerRuntimeSink;
    run: () => Promise<T>;
    counters: (result: T) => WorkerCounters;
    now?: () => Date;
    monotonicNow?: () => number;
    timeoutMs?: number;
};

export function executeOneShotWorker<T>(input: WorkerExecutionInput<T>): Promise<WorkerExecutionResult<T>> {
    return executeWorker(input, 'external_one_shot');
}

/** Shared-lease boundary for opt-in embedded loops. Application services must wire this explicitly. */
export function executeEmbeddedWorker<T>(input: WorkerExecutionInput<T>): Promise<WorkerExecutionResult<T>> {
    return executeWorker(input, 'embedded_interval');
}

async function executeWorker<T>(
    input: WorkerExecutionInput<T>,
    executionMode: 'external_one_shot' | 'embedded_interval',
): Promise<WorkerExecutionResult<T>> {
    const task = workerTopology().tasks.find((candidate) => candidate.id === input.task)!;
    if (task.executionMode !== executionMode) throw new Error('Worker execution mode does not match topology');
    const now = input.now ?? (() => new Date());
    const monotonicNow = input.monotonicNow ?? (() => performance.now());
    const startedAt = now();
    const started = monotonicNow();
    const request = workerLeaseRequestSchema.parse({
        topologyVersion: WORKER_TOPOLOGY_VERSION,
        task: input.task,
        ownerId: input.ownerId,
        requestedAt: startedAt.toISOString(),
        leaseSeconds: workerLeaseSeconds(input.task),
    });
    let lease: WorkerLease;
    try {
        lease = await input.leaseProvider.acquire(request);
    } catch {
        lease = { acquired: false, reason: 'unavailable' };
    }
    if (!lease.acquired) {
        const observation = makeObservation(input.task, executionMode, startedAt, now(), started, monotonicNow(), {
            outcome: lease.reason === 'held' ? 'skipped_overlap' : 'skipped_not_ready',
            failureKind: 'lease',
            attempted: 0,
            succeeded: 0,
            deferred: 0,
            failed: 0,
        });
        await safeRecord(input.sink, observation);
        if (lease.reason === 'unavailable') await safeAlert(input.sink, observation, 'lease_unavailable');
        return { status: 'skipped', observation, result: null };
    }

    let leaseLost = false;
    let deadlineExceeded = false;
    const heartbeat = setInterval(
        () => {
            void input.leaseProvider.renew(request, lease).then((renewed) => {
                if (!renewed) leaseLost = true;
            });
        },
        Math.max(1_000, Math.floor((request.leaseSeconds * 1_000) / 3)),
    );
    heartbeat.unref();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const timeoutMs = input.timeoutMs ?? task.timeoutSeconds * 1_000;
        timeout = setTimeout(() => {
            deadlineExceeded = true;
        }, timeoutMs);
        timeout.unref();
        // This is an observed deadline, not unsafe cancellation. The lease heartbeat remains active until the
        // mutating operation settles. A deployment scheduler may hard-stop the whole process at its own deadline.
        const result = await input.run();
        const counters = workerCountersSchema.parse(input.counters(result));
        const released = !leaseLost && (await input.leaseProvider.release(request, lease));
        if (!released) leaseLost = true;
        const observation = makeObservation(input.task, executionMode, startedAt, now(), started, monotonicNow(), {
            outcome: leaseLost ? 'failure' : deadlineExceeded ? 'timeout' : counters.failed ? 'partial' : 'success',
            failureKind: leaseLost ? 'lease' : deadlineExceeded ? 'timeout' : counters.failed ? 'internal' : null,
            ...counters,
        });
        await safeRecord(input.sink, observation);
        if (leaseLost) await safeAlert(input.sink, observation, 'lease_lost');
        else if (deadlineExceeded) await safeAlert(input.sink, observation, 'run_timed_out');
        else if (counters.failed) await safeAlert(input.sink, observation, 'run_failed');
        return {
            status: leaseLost || deadlineExceeded || counters.failed ? 'failed' : 'completed',
            observation,
            result,
        };
    } catch {
        const observation = makeObservation(input.task, executionMode, startedAt, now(), started, monotonicNow(), {
            outcome: deadlineExceeded ? 'timeout' : 'failure',
            failureKind: deadlineExceeded ? 'timeout' : 'internal',
            attempted: 0,
            succeeded: 0,
            deferred: 0,
            failed: 0,
        });
        if (!leaseLost) await input.leaseProvider.release(request, lease).catch(() => false);
        await safeRecord(input.sink, observation);
        await safeAlert(
            input.sink,
            observation,
            deadlineExceeded ? 'run_timed_out' : leaseLost ? 'lease_lost' : 'run_failed',
        );
        return { status: 'failed', observation, result: null };
    } finally {
        clearInterval(heartbeat);
        if (timeout) clearTimeout(timeout);
    }
}

function makeObservation(
    task: z.infer<typeof workerTaskIdSchema>,
    executionMode: 'external_one_shot' | 'embedded_interval',
    startedAt: Date,
    finishedAt: Date,
    started: number,
    finished: number,
    result: Omit<
        WorkerRunObservation,
        'topologyVersion' | 'task' | 'executionMode' | 'startedAt' | 'finishedAt' | 'durationMs'
    >,
): WorkerRunObservation {
    return workerRunObservationSchema.parse({
        topologyVersion: WORKER_TOPOLOGY_VERSION,
        task,
        executionMode,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.min(3_600_000, Math.max(0, Math.round(finished - started))),
        ...result,
    });
}

async function safeRecord(sink: WorkerRuntimeSink, observation: WorkerRunObservation): Promise<void> {
    try {
        await sink.record(observation);
    } catch {
        // Telemetry must never change the worker result.
    }
}

async function safeAlert(
    sink: WorkerRuntimeSink,
    observation: WorkerRunObservation,
    reason: WorkerAlert['reason'],
): Promise<void> {
    try {
        await sink.alert(
            workerAlertSchema.parse({
                task: observation.task,
                severity: reason === 'run_timed_out' || reason === 'lease_lost' ? 'critical' : 'warning',
                reason,
                failureKind: observation.failureKind,
                dedupKey: `worker:${observation.task}:${reason.startsWith('lease_') ? 'lease' : 'failures'}`,
                occurredAt: observation.finishedAt,
            }),
        );
    } catch {
        // Alerts must never change the worker result.
    }
}

export const workerHealthSchema = z.strictObject({
    task: workerTaskIdSchema,
    status: z.enum(['disabled', 'unknown', 'healthy', 'warning', 'critical']),
    reason: z.enum(['not_enabled', 'never_observed', 'clock_invalid', 'fresh', 'stale', 'very_stale', 'failures']),
    ageSeconds: z.number().int().nonnegative().nullable(),
    dedupKey: z
        .string()
        .regex(/^worker:[a-z0-9-]+:(?:freshness|failures)$/)
        .nullable(),
});
export type WorkerHealth = z.infer<typeof workerHealthSchema>;

export function evaluateWorkerHealth(input: {
    task: z.infer<typeof workerTaskIdSchema>;
    enabled: boolean;
    activatedAt: Date;
    observations: readonly WorkerRunObservation[];
    clock?: Date;
}): WorkerHealth {
    if (!input.enabled)
        return { task: input.task, status: 'disabled', reason: 'not_enabled', ageSeconds: null, dedupKey: null };
    const clock = input.clock ?? new Date();
    const task = workerTopology().tasks.find((candidate) => candidate.id === input.task)!;
    const staleAfter = Math.max(task.minimumIntervalSeconds * 2, task.minimumIntervalSeconds + task.timeoutSeconds);
    const matching = input.observations
        .filter((value) => value.task === input.task)
        .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
    const latest = matching[0];
    if (!latest) {
        const age = Math.max(0, Math.floor((clock.getTime() - input.activatedAt.getTime()) / 1000));
        return workerHealthSchema.parse({
            task: input.task,
            status: age >= staleAfter ? 'warning' : 'unknown',
            reason: 'never_observed',
            ageSeconds: age,
            dedupKey: age >= staleAfter ? `worker:${input.task}:freshness` : null,
        });
    }
    const age = Math.floor((clock.getTime() - Date.parse(latest.finishedAt)) / 1000);
    if (age < -300)
        return { task: input.task, status: 'unknown', reason: 'clock_invalid', ageSeconds: null, dedupKey: null };
    const failures = matching.findIndex((value) => value.outcome === 'success');
    const consecutiveFailures = failures === -1 ? matching.length : failures;
    if (consecutiveFailures >= 3)
        return workerHealthSchema.parse({
            task: input.task,
            status: 'critical',
            reason: 'failures',
            ageSeconds: Math.max(0, age),
            dedupKey: `worker:${input.task}:failures`,
        });
    if (consecutiveFailures >= 1)
        return workerHealthSchema.parse({
            task: input.task,
            status: 'warning',
            reason: 'failures',
            ageSeconds: Math.max(0, age),
            dedupKey: `worker:${input.task}:failures`,
        });
    if (age >= staleAfter * 2)
        return workerHealthSchema.parse({
            task: input.task,
            status: 'critical',
            reason: 'very_stale',
            ageSeconds: age,
            dedupKey: `worker:${input.task}:freshness`,
        });
    if (age >= staleAfter)
        return workerHealthSchema.parse({
            task: input.task,
            status: 'warning',
            reason: 'stale',
            ageSeconds: age,
            dedupKey: `worker:${input.task}:freshness`,
        });
    return { task: input.task, status: 'healthy', reason: 'fresh', ageSeconds: Math.max(0, age), dedupKey: null };
}
