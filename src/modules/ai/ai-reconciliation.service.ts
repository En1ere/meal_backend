import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { APP_CONFIG, type AppConfig } from '../../app/config.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { AiService } from './ai.service.js';
import {
    executeEmbeddedWorker,
    PostgresWorkerLeaseProvider,
    SanitizedJsonWorkerRuntimeSink,
    type WorkerCounters,
} from '../operational-runtime/worker-runtime.js';
import { AdminWorkerRuntimeSink, FanoutWorkerRuntimeSink } from '../telemetry/runtime-telemetry.js';

const intervalMs = 60_000;
const staleAfterMinutes = 15;
const batchSize = 100;

@Injectable()
export class AiReconciliationService implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger(AiReconciliationService.name);
    private timer?: ReturnType<typeof setInterval>;
    private running: Promise<void> | undefined;
    private cursor: string | null = null;

    constructor(
        private readonly database: DatabaseService,
        private readonly ai: AiService,
        private readonly adminTelemetry: AdminWorkerRuntimeSink,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
    ) {}

    onModuleInit() {
        if (!this.config.AI_RECONCILIATION_ENABLED) return;
        this.timer = setInterval(() => this.schedule(), intervalMs);
        this.timer.unref();
        this.schedule();
    }

    async onApplicationShutdown() {
        if (this.timer) clearInterval(this.timer);
        await this.running;
    }

    private schedule() {
        if (this.running) return;
        this.running = this.runObserved()
            .catch(() => this.logger.warn('AI reconciliation pass failed; deferred to next pass'))
            .finally(() => {
                this.running = undefined;
            });
    }

    async reconcileNow() {
        await this.tick();
    }

    private async runObserved(): Promise<void> {
        await executeEmbeddedWorker({
            task: 'ai-reconciliation',
            ownerId: this.config.WORKER_OWNER_ID ?? `embedded-${process.pid}`,
            leaseProvider: new PostgresWorkerLeaseProvider(this.database.db),
            sink: new FanoutWorkerRuntimeSink([new SanitizedJsonWorkerRuntimeSink(), this.adminTelemetry]),
            run: () => this.tick(),
            counters: (result) => result,
        });
    }

    private async tick(): Promise<WorkerCounters> {
        if (!this.database.db || !(await this.database.ready()))
            return { attempted: 0, succeeded: 0, deferred: 0, failed: 0 };
        const operations = await sql<{
            id: string;
            userId: string;
        }>`select o.id,c.user_id as "userId" from meal.ai_operations o join meal.ai_intervals i on i.id=o.interval_id join meal.ai_tasks t on t.id=i.task_id join meal.ai_conversations c on c.id=t.conversation_id where o.status='processing' and o.started_at<=now()-${staleAfterMinutes}*interval '1 minute' and (${this.cursor}::uuid is null or o.id>${this.cursor}::uuid) order by o.id limit ${batchSize}`.execute(
            this.database.db,
        );
        if (!operations.rows.length) {
            this.cursor = null;
            return { attempted: 0, succeeded: 0, deferred: 0, failed: 0 };
        }
        let succeeded = 0;
        let failed = 0;
        for (const operation of operations.rows) {
            try {
                await this.ai.reconcileInterrupted(operation.userId, operation.id);
                succeeded += 1;
            } catch {
                failed += 1;
                this.logger.warn('Stale AI operation deferred to a later pass');
            } finally {
                this.cursor = operation.id;
            }
        }
        return { attempted: operations.rows.length, succeeded, deferred: 0, failed };
    }
}
