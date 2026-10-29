import 'reflect-metadata';
import process from 'node:process';
import { NestFactory } from '@nestjs/core';
import { readWorkerApplicationConfig } from '../dist/src/app/worker-config.js';
import { WorkerModule } from '../dist/src/app/worker.module.js';
import { WorkerRuntimeFactory } from '../dist/src/infrastructure/workers/worker-runtime.factory.js';
import { scheduledTaskIdSchema } from '../dist/src/modules/operational-runtime/worker-scheduler.js';

const parsed = scheduledTaskIdSchema.safeParse(process.argv[2]);
if (!parsed.success || process.argv.length !== 3) {
    console.error('Scheduled task rejected: expected one allowlisted task identifier.');
    process.exitCode = 64;
} else if (process.env.AI_RECONCILIATION_ENABLED === 'true' || process.env.COOKING_LIFECYCLE_ENABLED === 'true') {
    console.error('Scheduled task rejected: embedded worker modes must be disabled.');
    process.exitCode = 64;
} else {
    const config = readWorkerApplicationConfig(process.env);
    if (!config.WORKER_OWNER_ID) throw new Error('Scheduled tasks require a stable WORKER_OWNER_ID');
    const app = await NestFactory.createApplicationContext(WorkerModule.configure(config), { logger: false });
    let interrupted = false;
    const interrupt = () => {
        interrupted = true;
    };
    process.once('SIGTERM', interrupt);
    process.once('SIGINT', interrupt);
    try {
        const runtime = app.get(WorkerRuntimeFactory);
        const task = parsed.data;
        let execution;
        if (task === 'scheduled-news') {
            const { ScheduledNewsRunner } = await import('../dist/src/modules/admin-news/scheduled-news.runner.js');
            execution = await runtime.oneShot(
                task,
                () => app.get(ScheduledNewsRunner).runDue(25),
                (result) => ({
                    attempted: result.inspected,
                    succeeded: result.published,
                    deferred: result.skippedInvalid,
                    failed: 0,
                }),
            );
        } else if (task === 'scheduled-sanctions') {
            const { AdminGovernanceService } =
                await import('../dist/src/modules/admin-governance/admin-governance.service.js');
            execution = await runtime.oneShot(
                task,
                () => app.get(AdminGovernanceService).activateScheduledSanctionEffects(50),
                (result) => ({
                    attempted: result.selected,
                    succeeded: result.applied,
                    deferred: result.selected - result.applied - result.failed,
                    failed: result.failed,
                }),
            );
        } else if (task === 'diary-portions') {
            const { DiaryService } = await import('../dist/src/modules/diary/diary.service.js');
            execution = await runtime.oneShot(
                task,
                () => app.get(DiaryService).runDue(100),
                (result) => ({ attempted: result.recipients, succeeded: result.recipients, deferred: 0, failed: 0 }),
            );
        } else if (task === 'incident-ignore-expiry') {
            const { OperationalMaintenanceService } =
                await import('../dist/src/modules/admin-operations/operational-maintenance.service.js');
            execution = await runtime.oneShot(
                task,
                () => app.get(OperationalMaintenanceService).restoreExpiredIncidentIgnores(250),
                (result) => ({ attempted: result.inspected, succeeded: result.restored, deferred: 0, failed: 0 }),
            );
        } else {
            const { CookingLifecycleService } =
                await import('../dist/src/modules/cooking/cooking-lifecycle.service.js');
            execution = await runtime.embedded(
                task,
                () => app.get(CookingLifecycleService).runScheduledBatch(),
                (result) => result,
            );
        }
        console.log(JSON.stringify({ status: execution.status, observation: execution.observation }));
        if (interrupted || execution.status === 'failed' || execution.observation.outcome === 'skipped_not_ready')
            process.exitCode = 1;
    } catch {
        console.error('Scheduled task failed closed; inspect sanitized worker telemetry.');
        process.exitCode = 1;
    } finally {
        process.removeListener('SIGTERM', interrupt);
        process.removeListener('SIGINT', interrupt);
        await app.close();
    }
}
