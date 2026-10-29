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
    const { planWorkerInvocation, WORKER_TOPOLOGY_VERSION } =
        await import('../dist/src/modules/operational-runtime/worker-topology.js');
    const config = readConfig(process.env);
    const ticket = process.argv.find((value) => value.startsWith('--approval-ticket='))?.split('=')[1];
    const policyVersion = Number(
        process.argv.find((value) => value.startsWith('--approval-policy-version='))?.split('=')[1],
    );
    planWorkerInvocation({
        topologyVersion: WORKER_TOPOLOGY_VERSION,
        task: 'account-retention',
        deploymentId: config.WORKER_OWNER_ID,
        requestedAt: new Date().toISOString(),
        apply: true,
        maxItems: 25,
        timeoutSeconds: 900,
        destructiveApproval: { changeTicket: ticket, policyVersion },
    });
    const app = await NestFactory.createApplicationContext(AppModule.configure(config), {
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
