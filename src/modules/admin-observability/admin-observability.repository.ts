import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { workerRunObservationSchema } from '../operational-runtime/worker-runtime.js';
import { workerTaskIdSchema } from '../operational-runtime/worker-topology.js';
import { providerObservationSchema, providerServiceSchema } from '../provider-runtime/provider-runtime.js';

type Tx = Transaction<DatabaseSchema>;
type MetricAggregate = { event_name: string; value: string; observed_at: Date };
type LatestMetric = { event_name: string; value: string; observed_at: Date };

const providerCountNames = providerServiceSchema.options.flatMap((service) =>
    providerObservationSchema.shape.outcome.options.map((outcome) => `provider.${service}.${outcome}.count`),
);
const providerDurationNames = providerServiceSchema.options.map((service) => `provider.${service}.duration`);
const workerCountNames = workerTaskIdSchema.options.flatMap((task) =>
    workerRunObservationSchema.shape.outcome.options.map((outcome) => `worker.${task}.${outcome}.count`),
);
const workerDurationNames = workerTaskIdSchema.options.map((task) => `worker.${task}.duration`);

export type ObservabilityRepositorySnapshot = Readonly<{
    database: {
        schemaVersion: number;
        databaseSizeBytes: number;
        queryDurationMs: number;
        pool: ReturnType<DatabaseService['poolSnapshot']>;
    };
    queue: {
        counts: Record<
            | 'pending'
            | 'queued'
            | 'running'
            | 'processing'
            | 'retrying'
            | 'failed'
            | 'deadLetter'
            | 'completed'
            | 'cancelled'
            | 'other',
            number
        >;
        dueNow: number;
        oldestDueAt: Date | null;
    };
    leases: readonly { task: string; expiresAt: Date }[];
    providerCounts: readonly MetricAggregate[];
    providerDurations: readonly MetricAggregate[];
    workerCounts: readonly MetricAggregate[];
    workerDurations: readonly LatestMetric[];
}>;

const safeNumber = (value: string | number | bigint, maximum = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error('Invalid aggregate');
    return parsed;
};

@Injectable()
export class AdminObservabilityRepository {
    constructor(private readonly database: DatabaseService) {}

    async read(
        tx: Tx,
        now: Date,
        monotonicNow: () => number = () => performance.now(),
    ): Promise<ObservabilityRepositorySnapshot> {
        const started = monotonicNow();
        await sql`set local statement_timeout = '2s'`.execute(tx);
        const database = await sql<{ schema_version: number; database_size_bytes: string }>`
                    select coalesce(max(version),0)::int as schema_version,
                           pg_database_size(current_database())::text as database_size_bytes
                    from meal.schema_migrations
                `.execute(tx);
        const queue = await sql<Record<string, string | Date | null>>`
                    select
                      count(*) filter(where status='pending')::text as pending,
                      count(*) filter(where status='queued')::text as queued,
                      count(*) filter(where status='running')::text as running,
                      count(*) filter(where status='processing')::text as processing,
                      count(*) filter(where status='retrying')::text as retrying,
                      count(*) filter(where status='failed')::text as failed,
                      count(*) filter(where status='dead_letter')::text as dead_letter,
                      count(*) filter(where status='completed')::text as completed,
                      count(*) filter(where status='cancelled')::text as cancelled,
                      count(*) filter(where status not in ('pending','queued','running','processing','retrying','failed','dead_letter','completed','cancelled'))::text as other,
                      count(*) filter(where status in ('pending','queued','retrying') and run_at<=${now})::text as due_now,
                      min(run_at) filter(where status in ('pending','queued','retrying') and run_at<=${now}) as oldest_due_at
                    from meal.background_jobs
                `.execute(tx);
        const leases = await tx
            .selectFrom('worker_leases')
            .select(['task', 'expires_at as expiresAt'])
            .where('task', 'in', workerTaskIdSchema.options)
            .limit(workerTaskIdSchema.options.length)
            .execute();
        const providerCounts = await sql<MetricAggregate>`
                    select event_name,sum(metric_value)::text as value,max(occurred_at) as observed_at
                    from meal.admin_metric_events
                    where occurred_at>=${new Date(now.getTime() - 3_600_000)}
                      and event_name in (${sql.join(providerCountNames)})
                    group by event_name
                `.execute(tx);
        const providerDurations = await sql<MetricAggregate>`
                    select event_name,round(avg(metric_value))::text as value,max(occurred_at) as observed_at
                    from meal.admin_metric_events
                    where occurred_at>=${new Date(now.getTime() - 3_600_000)}
                      and event_name in (${sql.join(providerDurationNames)})
                    group by event_name
                `.execute(tx);
        const workerCounts = await sql<MetricAggregate>`
                    select event_name,sum(metric_value)::text as value,max(occurred_at) as observed_at
                    from meal.admin_metric_events
                    where occurred_at>=${new Date(now.getTime() - 3_600_000)}
                      and event_name in (${sql.join(workerCountNames)})
                    group by event_name
                `.execute(tx);
        const workerDurations = await sql<LatestMetric>`
                    select distinct on(event_name) event_name,metric_value::text as value,occurred_at as observed_at
                    from meal.admin_metric_events
                    where occurred_at>=${new Date(now.getTime() - 86_400_000)}
                      and event_name in (${sql.join(workerDurationNames)})
                    order by event_name,occurred_at desc,id desc
                `.execute(tx);
        const dbRow = database.rows[0];
        const queueRow = queue.rows[0];
        if (!dbRow || !queueRow) throw new Error('Observability aggregate unavailable');
        const queryDurationMs = Math.max(0, Math.min(86_400_000, Math.round(monotonicNow() - started)));
        return {
            database: {
                schemaVersion: safeNumber(dbRow.schema_version, 100_000),
                databaseSizeBytes: safeNumber(dbRow.database_size_bytes),
                queryDurationMs,
                pool: this.database.poolSnapshot(),
            },
            queue: {
                counts: {
                    pending: safeNumber(String(queueRow.pending)),
                    queued: safeNumber(String(queueRow.queued)),
                    running: safeNumber(String(queueRow.running)),
                    processing: safeNumber(String(queueRow.processing)),
                    retrying: safeNumber(String(queueRow.retrying)),
                    failed: safeNumber(String(queueRow.failed)),
                    deadLetter: safeNumber(String(queueRow.dead_letter)),
                    completed: safeNumber(String(queueRow.completed)),
                    cancelled: safeNumber(String(queueRow.cancelled)),
                    other: safeNumber(String(queueRow.other)),
                },
                dueNow: safeNumber(String(queueRow.due_now)),
                oldestDueAt: queueRow.oldest_due_at instanceof Date ? queueRow.oldest_due_at : null,
            },
            leases,
            providerCounts: providerCounts.rows,
            providerDurations: providerDurations.rows,
            workerCounts: workerCounts.rows,
            workerDurations: workerDurations.rows,
        };
    }
}

export const observabilityMetricAllowlist = Object.freeze({
    providerCountNames,
    providerDurationNames,
    workerCountNames,
    workerDurationNames,
});
