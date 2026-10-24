// Deployment entry point only. It is never scheduled or started by the application.
const mode = process.argv.find((value) =>
    ['news', 'incidents', 'retention', 'sanctions', 'diary-portions'].includes(value),
);
if (!mode) {
    console.error(
        'Usage: node scripts/process-operational-maintenance.mjs <news|incidents|retention|sanctions|diary-portions> [--apply]',
    );
    process.exitCode = 2;
} else if (!process.argv.includes('--apply')) {
    console.log(
        mode === 'news'
            ? 'Plan only: publish up to 25 due in-app news items. Pass --apply from a protected scheduler.'
            : mode === 'incidents'
              ? 'Plan only: restore up to 250 expired ignored incidents. Pass --apply from a protected scheduler.'
              : mode === 'sanctions'
                ? 'Plan only: activate due sanction effects. Pass --apply from a protected scheduler.'
                : mode === 'diary-portions'
                  ? 'Plan only: auto-confirm due diary portion proposals. Pass --apply from a protected scheduler.'
                  : 'Plan only: inspect retention candidates without deleting them. Pass --apply to query the configured database.',
    );
} else {
    await import('reflect-metadata');
    const { NestFactory } = await import('@nestjs/core');
    const { readConfig } = await import('../dist/src/app/config.js');
    const { AppModule } = await import('../dist/src/app/app.module.js');
    const app = await NestFactory.createApplicationContext(AppModule.configure(readConfig(process.env)), {
        logger: false,
    });
    try {
        const { runOperationalWorker } = await import('./operational-worker-runtime.mjs');
        if (mode === 'news') {
            const { ScheduledNewsRunner } = await import('../dist/src/modules/admin-news/scheduled-news.runner.js');
            await runOperationalWorker(
                app,
                'scheduled-news',
                () => app.get(ScheduledNewsRunner).runDue(25),
                (result) => ({
                    attempted: result.inspected,
                    succeeded: result.published,
                    deferred: result.skippedInvalid,
                    failed: 0,
                }),
            );
        } else if (mode === 'sanctions') {
            const { AdminGovernanceService } =
                await import('../dist/src/modules/admin-governance/admin-governance.service.js');
            await runOperationalWorker(
                app,
                'scheduled-sanctions',
                () => app.get(AdminGovernanceService).activateScheduledSanctionEffects(50),
                (result) => ({
                    attempted: result.selected,
                    succeeded: result.applied,
                    deferred: result.selected - result.applied - result.failed,
                    failed: result.failed,
                }),
            );
        } else if (mode === 'diary-portions') {
            const { DiaryService } = await import('../dist/src/modules/diary/diary.service.js');
            await runOperationalWorker(
                app,
                'diary-portions',
                () => app.get(DiaryService).runDue(100),
                (result) => ({
                    attempted: result.recipients,
                    succeeded: result.recipients,
                    deferred: 0,
                    failed: 0,
                }),
            );
        } else {
            const { OperationalMaintenanceService } =
                await import('../dist/src/modules/admin-operations/operational-maintenance.service.js');
            const maintenance = app.get(OperationalMaintenanceService);
            if (mode === 'incidents') {
                await runOperationalWorker(
                    app,
                    'incident-ignore-expiry',
                    () => maintenance.restoreExpiredIncidentIgnores(250),
                    (result) => ({
                        attempted: result.inspected,
                        succeeded: result.restored,
                        deferred: 0,
                        failed: 0,
                    }),
                );
            } else {
                await runOperationalWorker(
                    app,
                    'retention-inspection',
                    async () => ({
                        errors: await maintenance.runAdminErrorRetention(),
                        metrics: await maintenance.runAdminMetricRetention(),
                        files: await maintenance.runFileMetadataRetention(),
                    }),
                    (result) => {
                        const values = Object.values(result);
                        const deferred = values.filter((value) => value.status === 'policy_unconfigured').length;
                        return { attempted: values.length, succeeded: values.length - deferred, deferred, failed: 0 };
                    },
                );
            }
        }
    } catch {
        console.error('Operational maintenance failed closed; inspect sanitized server logs.');
        process.exitCode = 1;
    } finally {
        await app.close();
    }
}
