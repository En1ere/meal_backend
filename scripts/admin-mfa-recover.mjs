// Operator-only emergency entry point. It is never imported by the HTTP application.
await import('reflect-metadata');
const { randomUUID } = await import('node:crypto');
const requestId = randomUUID();
let app;
let RecoveryError;
try {
    const [{ NestFactory }, { readConfig }, { AppModule }, { DatabaseService }, recovery] = await Promise.all([
        import('@nestjs/core'),
        import('../dist/src/app/config.js'),
        import('../dist/src/app/app.module.js'),
        import('../dist/src/infrastructure/database/database.service.js'),
        import('../dist/src/modules/admin-auth/admin-mfa-recovery.js'),
    ]);
    RecoveryError = recovery.AdminMfaRecoveryError;
    const input = recovery.parseAdminMfaRecoveryArgs(process.argv.slice(2), process.env.ADMIN_RECOVERY_ENABLED);
    app = await NestFactory.createApplicationContext(AppModule.configure(readConfig(process.env)), { logger: false });
    const database = app.get(DatabaseService);
    if (!(await database.ready())) throw new recovery.AdminMfaRecoveryError('DATABASE_UNAVAILABLE');
    const result = await recovery.recoverAdminMfa(database, input, requestId);
    console.log(JSON.stringify(result));
} catch (error) {
    const code = RecoveryError && error instanceof RecoveryError ? error.code : 'OUTCOME_UNKNOWN';
    console.error(
        JSON.stringify({ status: code === 'OUTCOME_UNKNOWN' ? 'outcome_unknown' : 'rejected', code, requestId }),
    );
    process.exitCode = 1;
} finally {
    await app?.close();
}
