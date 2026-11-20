// Operator-only first administrator bootstrap. It is never imported by the HTTP application.
await import('reflect-metadata');
const { randomUUID } = await import('node:crypto');
const requestId = randomUUID();
let app;
let BootstrapError;
try {
    const [{ NestFactory }, { readConfig }, { AppModule }, { DatabaseService }, bootstrap] = await Promise.all([
        import('@nestjs/core'),
        import('../dist/src/app/config.js'),
        import('../dist/src/app/app.module.js'),
        import('../dist/src/infrastructure/database/database.service.js'),
        import('../dist/src/modules/admin-auth/public.js'),
    ]);
    BootstrapError = bootstrap.AdminBootstrapError;
    const input = bootstrap.parseAdminBootstrapArgs(
        process.argv.slice(2),
        process.env.ADMIN_BOOTSTRAP_ENABLED,
        process.env.NODE_ENV,
    );
    app = await NestFactory.createApplicationContext(AppModule.configure(readConfig(process.env)), { logger: false });
    const database = app.get(DatabaseService);
    if (!(await database.ready())) throw new bootstrap.AdminBootstrapError('DATABASE_UNAVAILABLE');
    console.log(JSON.stringify(await bootstrap.bootstrapFirstAdmin(database, input, requestId)));
} catch (error) {
    const code = BootstrapError && error instanceof BootstrapError ? error.code : 'OUTCOME_UNKNOWN';
    console.error(
        JSON.stringify({ status: code === 'OUTCOME_UNKNOWN' ? 'outcome_unknown' : 'rejected', code, requestId }),
    );
    process.exitCode = 1;
} finally {
    await app?.close();
}
