// Shared one-shot boundary. Emits one result envelope on stdout and sanitized telemetry on stderr.
export async function runOperationalWorker(app, task, run, counters) {
    const { DatabaseService } = await import('../dist/src/infrastructure/database/database.service.js');
    const { PostgresWorkerLeaseProvider, SanitizedJsonWorkerRuntimeSink, executeOneShotWorker } =
        await import('../dist/src/modules/operational-runtime/worker-runtime.js');
    const { AdminWorkerRuntimeSink, FanoutWorkerRuntimeSink } =
        await import('../dist/src/modules/telemetry/runtime-telemetry.js');
    const database = app.get(DatabaseService);
    const ownerId = process.env.WORKER_OWNER_ID || `worker-${process.pid}`;
    const execution = await executeOneShotWorker({
        task,
        ownerId,
        leaseProvider: new PostgresWorkerLeaseProvider(database.db),
        sink: new FanoutWorkerRuntimeSink([new SanitizedJsonWorkerRuntimeSink(), app.get(AdminWorkerRuntimeSink)]),
        run,
        counters,
    });
    // Domain results may contain identifiers or provider details. The scheduler receives only the bounded envelope.
    console.log(JSON.stringify({ status: execution.status, observation: execution.observation }));
    if (execution.status === 'failed' || execution.observation.outcome === 'skipped_not_ready') process.exitCode = 1;
    return execution;
}
