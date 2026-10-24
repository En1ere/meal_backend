import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';

type Tx = Transaction<DatabaseSchema>;
const retentionRulesSchema = z.strictObject({ retentionDays: z.number().int().positive().max(36500) });
export type RetentionSubject = 'admin_error_events' | 'admin_metric_events' | 'media_assets';
export type RetentionInspection = {
    subject: RetentionSubject;
    status: 'policy_unconfigured' | 'dry_run';
    policyVersion: number | null;
    eligible: number;
    deleted: 0;
};

@Injectable()
export class OperationalMaintenanceService {
    constructor(private readonly database: DatabaseService) {}

    private async ready() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
    }

    /** Restores persisted incident state after ignore expiry; safe to invoke repeatedly or concurrently. */
    async restoreExpiredIncidentIgnores(limit = 250, clock = new Date()) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            throw new RangeError('limit must be between 1 and 1000');
        await this.ready();
        return this.database.transaction(async (tx) => {
            const restored = await sql<{ id: string; eventId: string }>`
                with due as (
                    select id,event_id from meal.admin_incident_states
                     where status='ignored' and ignored_until<=${clock}
                     order by ignored_until,id limit ${limit}
                     for update skip locked
                )
                update meal.admin_incident_states state
                   set status='new',ignored_until=null,reason='Период игнорирования завершён автоматически.',
                       assigned_to=null,updated_at=${clock},version=state.version+1
                  from due where state.id=due.id and state.status='ignored'
                returning state.id,state.event_id as "eventId"`.execute(tx);
            for (const row of restored.rows)
                await tx
                    .insertInto('audit_events')
                    .values({
                        id: randomUUID(),
                        action: 'admin.incident.ignore-expired',
                        target_type: 'errors',
                        target_id: row.eventId,
                        effective_at: clock,
                        recorded_at: new Date(),
                        reason: 'ignore_until reached',
                        before_redacted: { status: 'ignored' },
                        after_redacted: { status: 'new' },
                        request_id: randomUUID(),
                        actor_id: null,
                        scope_id: null,
                    })
                    .execute();
            return { inspected: restored.rows.length, restored: restored.rows.length };
        });
    }

    runAdminErrorRetention(clock = new Date()): Promise<RetentionInspection> {
        return this.inspectRetention('admin_error_events', 'admin_errors_retention', 'occurred_at', clock);
    }

    runAdminMetricRetention(clock = new Date()): Promise<RetentionInspection> {
        return this.inspectRetention('admin_metric_events', 'admin_metrics_retention', 'occurred_at', clock);
    }

    runFileMetadataRetention(clock = new Date()): Promise<RetentionInspection> {
        return this.inspectRetention('media_assets', 'file_metadata_retention', 'created_at', clock);
    }

    /**
     * Retention is deliberately inspection-only. Append-only observability tables and referenced media metadata
     * cannot be removed until a published policy plus an archive/delete migration defines safe semantics.
     */
    private async inspectRetention(
        subject: RetentionSubject,
        policyKey: string,
        timestampColumn: 'occurred_at' | 'created_at',
        clock: Date,
    ): Promise<RetentionInspection> {
        await this.ready();
        return this.database.transaction(async (tx) => {
            const policy = await sql<{ version: number; rules: unknown }>`
                select version::integer,rules from meal.feature_rule_versions
                 where key=${policyKey} and enabled and effective_at<=${clock}
                 order by version desc limit 1`.execute(tx);
            const parsed = retentionRulesSchema.safeParse(policy.rows[0]?.rules);
            if (!parsed.success)
                return { subject, status: 'policy_unconfigured', policyVersion: null, eligible: 0, deleted: 0 };
            const cutoff = new Date(clock.getTime() - parsed.data.retentionDays * 86_400_000);
            const eligible = await this.retentionCount(tx, subject, timestampColumn, cutoff);
            return {
                subject,
                status: 'dry_run',
                policyVersion: policy.rows[0]!.version,
                eligible,
                deleted: 0,
            };
        });
    }

    private async retentionCount(
        tx: Tx,
        subject: RetentionSubject,
        timestampColumn: 'occurred_at' | 'created_at',
        cutoff: Date,
    ) {
        const table = sql.table(`meal.${subject}`);
        const column = sql.ref(timestampColumn);
        const count = await sql<{
            value: number;
        }>`select count(*)::integer value from ${table} where ${column}<${cutoff}`.execute(tx);
        return count.rows[0]?.value ?? 0;
    }
}
