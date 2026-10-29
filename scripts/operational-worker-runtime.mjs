// Shared one-shot boundary. Emits one result envelope on stdout and sanitized telemetry on stderr.
export async function runOperationalWorker(app, task, run, counters) {
    const { WorkerRuntimeFactory } = await import('../dist/src/infrastructure/workers/worker-runtime.factory.js');
    const execution = await app.get(WorkerRuntimeFactory).oneShot(task, run, counters);
    // Domain results may contain identifiers or provider details. The scheduler receives only the bounded envelope.
    console.log(JSON.stringify({ status: execution.status, observation: execution.observation }));
    if (execution.status === 'failed' || execution.observation.outcome === 'skipped_not_ready') process.exitCode = 1;
    return execution;
}
