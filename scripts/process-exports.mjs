// Deployment entry point only. It is never scheduled or started by the application.
if (!process.argv.includes('--apply')) {
    console.log(
        'Plan only: claim up to 10 queued export manifests. Without a configured protected storage adapter every claimed job fails closed as storage_unavailable.',
    );
} else {
    await import('reflect-metadata');
    const { NestFactory } = await import('@nestjs/core');
    const { readConfig } = await import('../dist/src/app/config.js');
    const { AppModule } = await import('../dist/src/app/app.module.js');
    const { ExportsService } = await import('../dist/src/modules/exports/exports.service.js');
    const app = await NestFactory.createApplicationContext(AppModule.configure(readConfig(process.env)), {
        logger: false,
    });
    try {
        const { runOperationalWorker } = await import('./operational-worker-runtime.mjs');
        await runOperationalWorker(
            app,
            'exports',
            () => app.get(ExportsService).runNext(10),
            (result) => ({
                attempted: result.claimed,
                succeeded: result.claimed,
                deferred: 0,
                failed: 0,
            }),
        );
    } catch {
        console.error('Export worker failed closed; inspect job state and sanitized server logs.');
        process.exitCode = 1;
    } finally {
        await app.close();
    }
}
