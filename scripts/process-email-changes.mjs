// Prepared job, never invoked by npm start or migration. No connection without explicit --apply.
if (!process.argv.includes('--apply')) {
    console.log(
        'Plan only: settle up to 100 due/expired email changes in meal_planner_postgres with application role; revoke affected sessions/devices. Requires reviewed deployment approval.',
    );
} else {
    await import('reflect-metadata');
    const { NestFactory } = await import('@nestjs/core');
    const { readConfig } = await import('../dist/src/app/config.js');
    const { AppModule } = await import('../dist/src/app/app.module.js');
    const { AccountService } = await import('../dist/src/modules/account/account.service.js');
    const config = readConfig(process.env);
    if (!config.DATABASE_URL) throw Error('Explicit DATABASE_URL required');
    const app = await NestFactory.createApplicationContext(AppModule.configure(config), { logger: false });
    try {
        const { runOperationalWorker } = await import('./operational-worker-runtime.mjs');
        await runOperationalWorker(
            app,
            'email-changes',
            () => app.get(AccountService).processEmailChanges(),
            (result) => ({ attempted: result.processed, succeeded: result.processed, deferred: 0, failed: 0 }),
        );
    } catch {
        console.error(
            'Email settlement failed; inspect bounded audit/health before retry. No credential payload printed.',
        );
        process.exitCode = 1;
    } finally {
        await app.close();
    }
}
