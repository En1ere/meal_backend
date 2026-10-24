import {
    Inject,
    Injectable,
    Logger,
    HttpException,
    type OnModuleInit,
    type OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../app/config.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { personalWorkflow, workflowReplay, type WorkflowTx } from './workflow.store.js';
import { cookingReminderSchedule, cookingNotificationTime, cookingArchiveHiddenAt } from './cooking.domain.js';
import {
    cookingReminderPreferencesSchema,
    cookingReminderSchema,
    type cookingReminderPreferencesChangeSchema,
} from './cooking.contracts.js';
import {
    executeEmbeddedWorker,
    PostgresWorkerLeaseProvider,
    SanitizedJsonWorkerRuntimeSink,
    type WorkerCounters,
} from '../operational-runtime/worker-runtime.js';
import { AdminWorkerRuntimeSink, FanoutWorkerRuntimeSink } from '../telemetry/runtime-telemetry.js';

const validZone = (zone: string | null | undefined): zone is string => {
    if (!zone || /^[+-]/.test(zone)) return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
};
@Injectable()
export class CookingLifecycleService implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger(CookingLifecycleService.name);
    private timer?: ReturnType<typeof setInterval>;
    private running: Promise<void> | undefined;
    private actorCursor: string | null = null;
    constructor(
        private readonly database: DatabaseService,
        private readonly adminTelemetry: AdminWorkerRuntimeSink,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
    ) {}
    onModuleInit() {
        if (!this.config.COOKING_LIFECYCLE_ENABLED) return;
        this.timer = setInterval(() => {
            if (!this.running) {
                this.running = this.runObserved()
                    .catch(() => {
                        this.logger.warn('Cooking lifecycle processing failed; deferred to next pass');
                    })
                    .finally(() => {
                        this.running = undefined;
                    });
            }
        }, 60000);
        this.timer.unref();
    }
    async onApplicationShutdown() {
        if (this.timer) clearInterval(this.timer);
        await this.running;
    }
    private async runObserved(): Promise<void> {
        await executeEmbeddedWorker({
            task: 'cooking-lifecycle',
            ownerId: this.config.WORKER_OWNER_ID ?? `embedded-${process.pid}`,
            leaseProvider: new PostgresWorkerLeaseProvider(this.database.db),
            sink: new FanoutWorkerRuntimeSink([new SanitizedJsonWorkerRuntimeSink(), this.adminTelemetry]),
            run: () => this.tick(),
            counters: (result) => result,
        });
    }
    private async preferencesRow(tx: WorkflowTx, userId: string) {
        const row = (
            await sql<{
                enabled: boolean | null;
                timezone: string | null;
                fallback_zone: string | null;
            }>`select p.enabled,p.timezone,s.timezone as fallback_zone from meal.users u left join meal.notification_preferences p on p.user_id=u.id and p.category='cooking' and p.channel='in_app' left join meal.user_settings s on s.user_id=u.id where u.id=${userId}::uuid`.execute(
                tx,
            )
        ).rows[0];
        const timezone = validZone(row?.timezone)
            ? row.timezone
            : validZone(row?.fallback_zone)
              ? row.fallback_zone
              : null;
        return cookingReminderPreferencesSchema.parse({
            enabled: row?.enabled ?? true,
            timezone,
            quietHours: { start: '22:00', end: '09:00' },
        });
    }
    preferences(userId: string) {
        return personalWorkflow(this.database, userId, false, (tx) => this.preferencesRow(tx, userId));
    }
    savePreferences(userId: string, input: z.infer<typeof cookingReminderPreferencesChangeSchema>) {
        return personalWorkflow(this.database, userId, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'cooking-reminder-preferences', userId, input, async () => {
                const previous = await this.preferencesRow(tx, userId);
                const timezone = input.timezone ?? previous.timezone;
                if (!timezone) throw new HttpException('Укажите локальный часовой пояс', 422);
                await sql`insert into meal.notification_preferences(id,category,channel,enabled,quiet_hours,timezone,urgent_opt_in,user_id) values(${randomUUID()}::uuid,'cooking','in_app',${input.enabled},'{"start":"22:00","end":"09:00"}'::jsonb,${timezone},false,${userId}::uuid) on conflict(user_id,category,channel) do update set enabled=excluded.enabled,quiet_hours=excluded.quiet_hours,timezone=excluded.timezone,version=meal.notification_preferences.version+1`.execute(
                    tx,
                );
                await sql`update meal.notifications set available_at=(date_trunc('day',available_at at time zone ${timezone})+case when (available_at at time zone ${timezone})::time>=time '22:00' then interval '1 day 9 hours' else interval '9 hours' end) at time zone ${timezone},version=version+1 where user_id=${userId}::uuid and category='cooking' and payload_minimized->>'type'='cooking-reminder' and available_at>now() and ((available_at at time zone ${timezone})::time>=time '22:00' or (available_at at time zone ${timezone})::time<time '09:00')`.execute(
                    tx,
                );
                return {
                    enabled: input.enabled,
                    timezone,
                    quietHours: { start: '22:00' as const, end: '09:00' as const },
                };
            }),
        );
    }
    async reconcileUser(userId: string, attemptId?: string): Promise<void> {
        if (!this.database.db || !(await this.database.ready())) return;
        await this.database.transaction(async (tx) => {
            const actor =
                await sql`select id from meal.users where id=${userId}::uuid and status='active' and archived_at is null for update`.execute(
                    tx,
                );
            if (!actor.rows.length) return;
            const clock = (await sql<{ now: Date }>`select now() as now`.execute(tx)).rows[0]!.now;
            const now = clock.getTime(),
                prefs = await this.preferencesRow(tx, userId);
            const nextDeliveryAt =
                prefs.enabled && prefs.timezone ? cookingNotificationTime(now, prefs.timezone) : null;
            const attempts = await sql<{
                id: string;
                started_at: Date;
            }>`select a.id,a.started_at from meal.cooking_attempts a join meal.data_scopes s on s.id=a.scope_id where a.actor_id=${userId}::uuid and s.kind='private' and s.user_id=${userId}::uuid and (${attemptId ?? null}::uuid is null or a.id=${attemptId ?? null}::uuid) and a.status in ('active','paused') and (a.started_at<=${clock}::timestamptz-interval '6 days' or (${prefs.enabled && prefs.timezone !== null} and ((a.started_at<=${clock}::timestamptz-interval '2 days' and not exists(select 1 from meal.notifications n where n.user_id=${userId}::uuid and n.dedup_key='cooking:'||a.id::text||':reminder:1')) or (a.started_at<=${clock}::timestamptz-interval '4 days' and not exists(select 1 from meal.notifications n where n.user_id=${userId}::uuid and n.dedup_key='cooking:'||a.id::text||':reminder:2'))))) order by a.started_at,a.id limit 200 for update of a`.execute(
                tx,
            );
            for (const row of attempts.rows) {
                const schedule = cookingReminderSchedule(row.started_at.toISOString());
                if (Date.parse(schedule.archiveAt) <= now) {
                    const lifecycle = {
                        archivedAt: schedule.archiveAt,
                        hideAfter: cookingArchiveHiddenAt(schedule.archiveAt),
                    };
                    await sql`update meal.cooking_attempts set status='archived',output_snapshot=coalesce(output_snapshot,'{}'::jsonb)||${JSON.stringify({ lifecycle })}::jsonb,version=version+1 where id=${row.id}::uuid and actor_id=${userId}::uuid and status in ('active','paused')`.execute(
                        tx,
                    );
                    await sql`update meal.cooking_steps set timer_deadline=null,timer_paused_seconds=null,version=version+1 where attempt_id=${row.id}::uuid and (timer_deadline is not null or timer_paused_seconds is not null)`.execute(
                        tx,
                    );
                    continue;
                }
                if (!nextDeliveryAt) continue;
                for (const [index, due] of [schedule.firstReminderAt, schedule.secondReminderAt].entries()) {
                    if (Date.parse(due) > now) continue;
                    const availableAt = nextDeliveryAt;
                    // A delayed quiet-hour delivery must not resurrect an already archived attempt.
                    if (Date.parse(availableAt) >= Date.parse(schedule.archiveAt)) continue;
                    const payload = { type: 'cooking-reminder', attemptId: row.id, sequence: index + 1 };
                    await sql`insert into meal.notifications(id,category,priority,payload_minimized,dedup_key,available_at,user_id) values(${randomUUID()}::uuid,'cooking','informational',${JSON.stringify(payload)}::jsonb,${`cooking:${row.id}:reminder:${index + 1}`},${availableAt}::timestamptz,${userId}::uuid) on conflict(user_id,dedup_key) do nothing`.execute(
                        tx,
                    );
                }
            }
        });
    }
    async reminders(tx: WorkflowTx, userId: string) {
        const prefs = await this.preferencesRow(tx, userId);
        if (!prefs.enabled) return [];
        const rows = await sql<{
            id: string;
            attemptId: string;
            sequence: number;
            availableAt: Date;
        }>`select n.id,a.id as "attemptId",(n.payload_minimized->>'sequence')::integer as sequence,n.available_at as "availableAt" from meal.notifications n join meal.cooking_attempts a on a.id::text=n.payload_minimized->>'attemptId' join meal.data_scopes s on s.id=a.scope_id where n.user_id=${userId}::uuid and n.category='cooking' and n.payload_minimized->>'type'='cooking-reminder' and n.available_at<=now() and n.read_at is null and a.actor_id=${userId}::uuid and s.kind='private' and s.user_id=${userId}::uuid and a.status in ('active','paused') and a.started_at>now()-interval '6 days' order by n.available_at desc,n.id limit 100`.execute(
            tx,
        );
        return rows.rows.map((row) =>
            cookingReminderSchema.parse({ ...row, availableAt: row.availableAt.toISOString() }),
        );
    }
    private async tick(): Promise<WorkerCounters> {
        if (!this.database.db || !(await this.database.ready()))
            return { attempted: 0, succeeded: 0, deferred: 0, failed: 0 };
        const actors = await sql<{
            actor_id: string;
        }>`select a.actor_id from meal.cooking_attempts a join meal.data_scopes s on s.id=a.scope_id where a.status in ('active','paused') and s.kind='private' and s.user_id=a.actor_id and a.started_at<=now()-interval '2 days' and (${this.actorCursor}::uuid is null or a.actor_id>${this.actorCursor}::uuid) group by a.actor_id order by a.actor_id limit 200`.execute(
            this.database.db,
        );
        if (!actors.rows.length) this.actorCursor = null;
        let succeeded = 0;
        let failed = 0;
        for (const actor of actors.rows) {
            try {
                await this.reconcileUser(actor.actor_id);
                succeeded += 1;
            } catch {
                failed += 1;
                this.logger.warn('Cooking lifecycle account deferred to next pass');
            } finally {
                this.actorCursor = actor.actor_id;
            }
        }
        return { attempted: actors.rows.length, succeeded, deferred: 0, failed };
    }
}
