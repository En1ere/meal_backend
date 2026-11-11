import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { WorkerRuntimeFactory } from '../../infrastructure/workers/worker-runtime.factory.js';
import type { WorkerCounters } from '../operational-runtime/public.js';
import { AiV2ProviderOperationStore } from './ai-provider-operation.store.js';

const intervalMs = 60_000;
const staleAfterMinutes = 15;
const batchSize = 100;

@Injectable()
export class AiReconciliationService implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger(AiReconciliationService.name);
    private timer?: ReturnType<typeof setInterval>;
    private running: Promise<void> | undefined;
    constructor(
        private readonly database: DatabaseService,
        private readonly workerRuntime: WorkerRuntimeFactory,
        private readonly providerOperations: AiV2ProviderOperationStore,
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
        await this.workerRuntime.embedded(
            'ai-reconciliation',
            () => this.tick(),
            (result) => result,
        );
    }

    private async tick(): Promise<WorkerCounters> {
        if (!this.database.db || !(await this.database.ready()))
            return { attempted: 0, succeeded: 0, deferred: 0, failed: 0 };
        const operations = await sql<{ id: string }>`
            with expired as (
                select id
                from meal.ai_operations
                where contract_version in(0,1)
                  and lifecycle_state='running'
                  and lease_until<=now()
                  and started_at<=now()-${staleAfterMinutes}*interval '1 minute'
                order by lease_until,id
                limit ${batchSize}
                for update skip locked
            )
            update meal.ai_operations o
            set lifecycle_state='unknown',
                financial_state='reconciliation_hold',
                failure_category='process_interrupted',
                failure_retryable=false,
                result_snapshot=jsonb_set(coalesce(o.result_snapshot,'{}'::jsonb),'{failure}','"process_interrupted"'::jsonb,true),
                updated_at=now(),
                version=o.version+1
            from expired
            where o.id=expired.id
            returning o.id
        `.execute(this.database.db);
        if (operations.rows.length)
            this.logger.warn(`${operations.rows.length} expired AI operation lease(s) moved to reconciliation hold`);
        const expiredDispatches = await sql<{
            operationId: string;
            leaseToken: string;
            version: number;
        }>`select operation_id "operationId",lease_token "leaseToken",version::integer
              from meal.ai_provider_dispatches
             where state in('submit_claimed','read_claimed') and lease_until<=now()
             order by lease_until,operation_id limit ${batchSize}`.execute(this.database.db);
        let reconciledDispatches = 0;
        for (const dispatch of expiredDispatches.rows) {
            if (
                await this.providerOperations.expireClaim({
                    operationId: dispatch.operationId,
                    expectedVersion: dispatch.version,
                    leaseToken: dispatch.leaseToken,
                    clock: new Date(),
                    nextReadAt: new Date(Date.now() + intervalMs),
                })
            )
                reconciledDispatches += 1;
        }
        if (reconciledDispatches)
            this.logger.warn(`${reconciledDispatches} expired AI provider claim(s) moved to safe reconciliation state`);
        const attempted = operations.rows.length + expiredDispatches.rows.length;
        const succeeded = operations.rows.length + reconciledDispatches;
        return {
            attempted,
            succeeded,
            deferred: attempted - succeeded,
            failed: 0,
        };
    }
}
