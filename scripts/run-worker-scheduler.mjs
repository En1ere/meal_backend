import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import {
    readWorkerSchedulerConfig,
    schedulerExecutionSchema,
    WorkerScheduler,
} from '../dist/src/modules/operational-runtime/worker-scheduler.js';
import { workerRunObservationSchema } from '../dist/src/modules/operational-runtime/worker-runtime.js';

const config = readWorkerSchedulerConfig(process.env);
let active = null;
let stopping = false;
let stateSequence = 0;
const executor = {
    run(task, hardTimeoutMs) {
        if (active) return Promise.reject(new Error('Scheduler executor is busy'));
        return new Promise((resolve) => {
            const child = spawn(process.execPath, ['scripts/run-scheduled-task.mjs', task], {
                shell: false,
                stdio: ['ignore', 'pipe', 'inherit'],
                env: { ...process.env, AI_RECONCILIATION_ENABLED: 'false', COOKING_LIFECYCLE_ENABLED: 'false' },
            });
            active = child;
            let stdout = '';
            let oversized = false;
            let timedOut = false;
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
                if (stdout.length + chunk.length > 16_384) oversized = true;
                else stdout += chunk;
            });
            const timeout = setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
            }, hardTimeoutMs);
            timeout.unref();
            const hardKill = setTimeout(() => child.kill('SIGKILL'), hardTimeoutMs + 5_000);
            hardKill.unref();
            child.once('exit', (code, signal) => {
                clearTimeout(timeout);
                clearTimeout(hardKill);
                active = null;
                if (signal || code !== 0 || oversized)
                    return resolve({ outcome: timedOut || signal ? 'timeout' : 'failure', observation: null });
                try {
                    const envelope = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
                    const observation = workerRunObservationSchema.parse(envelope.observation);
                    resolve(schedulerExecutionSchema.parse({ outcome: observation.outcome, observation }));
                } catch {
                    resolve({ outcome: 'failure', observation: null });
                }
            });
        });
    },
    async shutdown(graceMs) {
        const child = active;
        if (!child) return;
        child.kill('SIGTERM');
        await Promise.race([
            new Promise((resolve) => child.once('exit', resolve)),
            new Promise((resolve) => setTimeout(resolve, graceMs)),
        ]);
        if (active === child) child.kill('SIGKILL');
    },
};
const writeState = async (state) => {
    const directory = path.dirname(config.stateFile);
    const temporary = path.join(directory, `.health-${process.pid}-${stateSequence++}.tmp`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await fs.rename(temporary, config.stateFile);
};
const scheduler = new WorkerScheduler(config, executor, writeState);
const heartbeat = setInterval(() => void scheduler.heartbeat().catch(() => undefined), config.heartbeatMs);
heartbeat.unref();
const shutdown = async () => {
    if (!stopping) {
        stopping = true;
        clearInterval(heartbeat);
        await scheduler.shutdown();
    }
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
await scheduler.heartbeat();
while (!stopping) {
    await scheduler.runDue();
    await new Promise((resolve) => setTimeout(resolve, config.heartbeatMs));
}
