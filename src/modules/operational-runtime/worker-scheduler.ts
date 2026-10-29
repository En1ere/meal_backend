import { z } from 'zod';
import { workerRunObservationSchema, type WorkerRunObservation } from './worker-runtime.js';
import { workerTopology, type WorkerTaskId } from './worker-topology.js';

export const scheduledTaskIdSchema = z.enum([
    'scheduled-news',
    'incident-ignore-expiry',
    'scheduled-sanctions',
    'diary-portions',
    'cooking-lifecycle',
]);
export type ScheduledTaskId = z.infer<typeof scheduledTaskIdSchema>;

const intervalEnvironment: Record<ScheduledTaskId, string> = {
    'scheduled-news': 'WORKER_SCHEDULE_NEWS_SECONDS',
    'incident-ignore-expiry': 'WORKER_SCHEDULE_INCIDENTS_SECONDS',
    'scheduled-sanctions': 'WORKER_SCHEDULE_SANCTIONS_SECONDS',
    'diary-portions': 'WORKER_SCHEDULE_DIARY_PORTIONS_SECONDS',
    'cooking-lifecycle': 'WORKER_SCHEDULE_COOKING_SECONDS',
};

export type WorkerSchedule = Readonly<{
    id: ScheduledTaskId;
    intervalMs: number;
    hardTimeoutMs: number;
}>;

export type WorkerSchedulerConfig = Readonly<{
    schedules: readonly WorkerSchedule[];
    jitterMs: number;
    maximumBackoffMs: number;
    poisonFailures: number;
    poisonCooldownMs: number;
    heartbeatMs: number;
    shutdownGraceMs: number;
    stateFile: string;
}>;

const integer = (env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`Invalid scheduler field: ${name}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`Invalid scheduler field: ${name}`);
    return value;
};

export function readWorkerSchedulerConfig(env: NodeJS.ProcessEnv): WorkerSchedulerConfig {
    if (env.AI_RECONCILIATION_ENABLED === 'true' || env.COOKING_LIFECYCLE_ENABLED === 'true')
        throw new Error('Embedded worker modes must be disabled for the scheduler container');
    if (!env.WORKER_OWNER_ID || !/^[a-z][a-z0-9-]{2,63}$/.test(env.WORKER_OWNER_ID))
        throw new Error('Scheduler requires a stable WORKER_OWNER_ID');
    const rawIds = (env.WORKER_SCHEDULE_ALLOWLIST ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    const ids = z.array(scheduledTaskIdSchema).max(scheduledTaskIdSchema.options.length).parse(rawIds);
    if (new Set(ids).size !== ids.length) throw new Error('Worker schedule allowlist must be unique');
    const topology = workerTopology();
    const schedules = ids.map((id) => {
        const task = topology.tasks.find((candidate) => candidate.id === id)!;
        const intervalSeconds = integer(
            env,
            intervalEnvironment[id],
            task.minimumIntervalSeconds,
            task.minimumIntervalSeconds,
            86_400,
        );
        return {
            id,
            intervalMs: intervalSeconds * 1_000,
            hardTimeoutMs: (task.timeoutSeconds + 10) * 1_000,
        };
    });
    const stateFile = env.WORKER_STATE_FILE ?? '/run/meal-worker/health.json';
    if (!/^\/run\/meal-worker\/[a-z0-9.-]+\.json$/.test(stateFile))
        throw new Error('WORKER_STATE_FILE must stay inside /run/meal-worker');
    return {
        schedules,
        jitterMs: integer(env, 'WORKER_SCHEDULER_JITTER_SECONDS', 5, 0, 30) * 1_000,
        maximumBackoffMs: integer(env, 'WORKER_SCHEDULER_MAX_BACKOFF_SECONDS', 900, 60, 3_600) * 1_000,
        poisonFailures: integer(env, 'WORKER_SCHEDULER_POISON_FAILURES', 3, 1, 10),
        poisonCooldownMs: integer(env, 'WORKER_SCHEDULER_POISON_COOLDOWN_SECONDS', 900, 60, 86_400) * 1_000,
        heartbeatMs: integer(env, 'WORKER_SCHEDULER_HEARTBEAT_SECONDS', 15, 5, 60) * 1_000,
        shutdownGraceMs: integer(env, 'WORKER_SCHEDULER_SHUTDOWN_GRACE_SECONDS', 30, 5, 120) * 1_000,
        stateFile,
    };
}

export const schedulerExecutionSchema = z.object({
    outcome: workerRunObservationSchema.shape.outcome,
    observation: workerRunObservationSchema.nullable(),
});
export type SchedulerExecution = z.infer<typeof schedulerExecutionSchema>;

export interface WorkerSchedulerExecutor {
    run(task: ScheduledTaskId, hardTimeoutMs: number): Promise<SchedulerExecution>;
    shutdown(graceMs: number): Promise<void>;
}

export const workerSchedulerStateSchema = z.strictObject({
    version: z.literal(1),
    status: z.enum(['idle', 'running', 'stopping', 'stopped']),
    heartbeatAt: z.iso.datetime(),
    activeTask: scheduledTaskIdSchema.nullable(),
    tasks: z.array(
        z.strictObject({
            id: scheduledTaskIdSchema,
            nextRunAt: z.iso.datetime(),
            lastOutcome: workerRunObservationSchema.shape.outcome.nullable(),
            consecutiveFailures: z.number().int().min(0).max(10),
            poisonedUntil: z.iso.datetime().nullable(),
        }),
    ),
});
export type WorkerSchedulerState = z.infer<typeof workerSchedulerStateSchema>;

type MutableTaskState = {
    schedule: WorkerSchedule;
    nextRunAt: number;
    lastOutcome: WorkerRunObservation['outcome'] | null;
    consecutiveFailures: number;
    poisonedUntil: number | null;
};

export class WorkerScheduler {
    private readonly tasks: MutableTaskState[];
    private activeTask: ScheduledTaskId | null = null;
    private stopping = false;

    constructor(
        private readonly config: WorkerSchedulerConfig,
        private readonly executor: WorkerSchedulerExecutor,
        private readonly writeState: (state: WorkerSchedulerState) => Promise<void>,
        now = Date.now(),
        private readonly random: () => number = Math.random,
        private readonly clock: () => number = Date.now,
    ) {
        this.tasks = config.schedules.map((schedule) => ({
            schedule,
            nextRunAt: now + schedule.intervalMs + this.jitter(),
            lastOutcome: null,
            consecutiveFailures: 0,
            poisonedUntil: null,
        }));
    }

    private jitter() {
        return Math.floor(Math.max(0, Math.min(1, this.random())) * this.config.jitterMs);
    }

    snapshot(now = this.clock(), status?: WorkerSchedulerState['status']): WorkerSchedulerState {
        return workerSchedulerStateSchema.parse({
            version: 1,
            status: status ?? (this.stopping ? 'stopping' : this.activeTask ? 'running' : 'idle'),
            heartbeatAt: new Date(now).toISOString(),
            activeTask: this.activeTask,
            tasks: this.tasks.map((task) => ({
                id: task.schedule.id,
                nextRunAt: new Date(task.nextRunAt).toISOString(),
                lastOutcome: task.lastOutcome,
                consecutiveFailures: task.consecutiveFailures,
                poisonedUntil: task.poisonedUntil === null ? null : new Date(task.poisonedUntil).toISOString(),
            })),
        });
    }

    heartbeat(now = this.clock()) {
        return this.writeState(this.snapshot(now));
    }

    async runDue(now = this.clock()): Promise<ScheduledTaskId | null> {
        if (this.stopping || this.activeTask) return null;
        const task = this.tasks
            .filter((candidate) => candidate.nextRunAt <= now && (candidate.poisonedUntil ?? 0) <= now)
            .sort((left, right) => left.nextRunAt - right.nextRunAt)[0];
        if (!task) {
            await this.heartbeat(now);
            return null;
        }
        this.activeTask = task.schedule.id;
        await this.heartbeat(now);
        let execution: SchedulerExecution;
        try {
            execution = schedulerExecutionSchema.parse(
                await this.executor.run(task.schedule.id, task.schedule.hardTimeoutMs),
            );
        } catch {
            execution = { outcome: 'failure', observation: null };
        }
        const completedAt = Math.max(now, this.clock());
        task.lastOutcome = execution.outcome;
        if (execution.outcome === 'success') {
            task.consecutiveFailures = 0;
            task.poisonedUntil = null;
            task.nextRunAt = completedAt + task.schedule.intervalMs + this.jitter();
        } else if (execution.outcome === 'skipped_overlap') {
            task.nextRunAt = completedAt + task.schedule.intervalMs + this.jitter();
        } else {
            task.consecutiveFailures = Math.min(10, task.consecutiveFailures + 1);
            if (task.consecutiveFailures >= this.config.poisonFailures)
                task.poisonedUntil = completedAt + this.config.poisonCooldownMs;
            const backoff = Math.min(
                this.config.maximumBackoffMs,
                task.schedule.intervalMs * 2 ** Math.max(0, task.consecutiveFailures - 1),
            );
            task.nextRunAt = Math.max(completedAt + backoff + this.jitter(), task.poisonedUntil ?? 0);
        }
        this.activeTask = null;
        await this.heartbeat(completedAt);
        return task.schedule.id;
    }

    async shutdown(now = this.clock()) {
        if (this.stopping) return;
        this.stopping = true;
        await this.writeState(this.snapshot(now, 'stopping'));
        await this.executor.shutdown(this.config.shutdownGraceMs);
        this.activeTask = null;
        await this.writeState(this.snapshot(this.clock(), 'stopped'));
    }
}

export function isSchedulerTask(task: WorkerTaskId): task is ScheduledTaskId {
    return scheduledTaskIdSchema.safeParse(task).success;
}
