import { writeFile } from 'node:fs/promises';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { databasePoolConfig } from '../dist/src/infrastructure/database/database.service.js';
import { AiOperationProcessor, AiProvider, readAiWorkerConfig } from '../dist/src/modules/ai/public.js';

const config = readAiWorkerConfig(process.env);
const pool = new pg.Pool({
    ...databasePoolConfig(config.databaseUrl),
    max: 2,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 30_000,
    application_name: 'meal-ai-worker',
});
pool.on('error', () => console.error('ai_worker database_error'));
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
const provider = new AiProvider({
    AI_API_TOKEN: config.apiToken,
    AI_API_BASE_URL: config.AI_API_BASE_URL,
    AI_MODEL: config.AI_MODEL,
    AI_PROVIDER_PROFILE_VERSION: config.AI_PROVIDER_PROFILE_VERSION,
    AI_MONTHLY_BUDGET_USD: config.AI_MONTHLY_BUDGET_USD,
    AI_BACKGROUND_EXECUTION_ENABLED: true,
});
const processor = new AiOperationProcessor(db, config, provider);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => (stopping = true));

while (!stopping) {
    let state = 'ok';
    try {
        await processor.runOnce();
    } catch {
        state = 'degraded';
        console.error('ai_worker cycle_failed');
    }
    await writeFile(
        '/run/meal-ai-worker/health.json',
        JSON.stringify({ state, observedAt: new Date().toISOString() }),
        { mode: 0o600 },
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, config.AI_WORKER_POLL_MS));
}
await db.destroy();
