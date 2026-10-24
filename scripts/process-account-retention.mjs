// Deployment entry point only. It is never scheduled or started by the application.
if (!process.argv.includes('--apply')) {
    console.log(
        'Plan only: inspect up to 25 due account-deletion requests. Missing policy, approval, legal-hold checks or dependencies remain blocked.',
    );
} else {
    await import('reflect-metadata');
    const { NestFactory } = await import('@nestjs/core');
    const { readConfig } = await import('../dist/src/app/config.js');
    const { AppModule } = await import('../dist/src/app/app.module.js');
    const { AccountLifecycleService } =
        await import('../dist/src/modules/account-lifecycle/account-lifecycle.service.js');
    const app = await NestFactory.createApplicationContext(AppModule.configure(readConfig(process.env)), {
        logger: false,
    });
    try {
        const { runOperationalWorker } = await import('./operational-worker-runtime.mjs');
        await runOperationalWorker(
            app,
            'account-retention',
            () => app.get(AccountLifecycleService).runRetentionBatch(25),
            (result) => ({
                attempted: result.inspected,
                succeeded: result.finalized,
                deferred: result.blocked,
                failed: 0,
            }),
        );
    } catch {
        console.error('Retention runner failed closed; inspect request state and sanitized server logs.');
        process.exitCode = 1;
    } finally {
        await app.close();
    }
}
