import { writeFile } from 'node:fs/promises';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { databasePoolConfig } from '../dist/src/infrastructure/database/database.service.js';
import { readWebPushWorkerConfig, WebPushProcessor } from '../dist/src/modules/web-push/public.js';
import { VapidWebPushProvider } from '../dist/src/modules/delivery-infrastructure/public.js';
const config = readWebPushWorkerConfig(process.env);
const pool = new pg.Pool({
    ...databasePoolConfig(config.databaseUrl),
    max: 2,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
    application_name: 'meal-web-push-worker',
});
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
const provider = new VapidWebPushProvider({
    WEB_PUSH_ENABLED: true,
    WEB_PUSH_VAPID_SUBJECT: config.WEB_PUSH_VAPID_SUBJECT,
    WEB_PUSH_VAPID_PUBLIC_KEY: config.WEB_PUSH_VAPID_PUBLIC_KEY,
    WEB_PUSH_VAPID_PRIVATE_KEY: config.privateKey,
});
const processor = new WebPushProcessor(db, config, provider);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
        stopping = true;
    });
while (!stopping) {
    let state = 'ok';
    try {
        await processor.runOnce();
    } catch {
        state = 'degraded';
        console.error('web_push_worker cycle_failed');
    }
    await writeFile(
        '/run/meal-web-push-worker/health.json',
        JSON.stringify({ state, observedAt: new Date().toISOString() }),
        { mode: 0o600 },
    );
    await new Promise((r) => setTimeout(r, config.WEB_PUSH_WORKER_POLL_MS));
}
await db.destroy();
