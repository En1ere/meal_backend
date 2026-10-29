import { writeFile } from 'node:fs/promises';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { readMailWorkerConfig } from '../dist/src/modules/account-mail/mail-worker.config.js';
import { SmtpAccountMailProvider } from '../dist/src/modules/account-mail/smtp-account-mail.js';
import { AccountMailProcessor } from '../dist/src/modules/account-mail/account-mail.processor.js';
import { databasePoolConfig } from '../dist/src/infrastructure/database/database.service.js';

const config = readMailWorkerConfig(process.env);
const pool = new pg.Pool({
    ...databasePoolConfig(config.databaseUrl),
    max: 2,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
    application_name: 'meal-account-mail-worker',
});
pool.on('error', () => console.error('mail_worker database_error'));
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
const processor = new AccountMailProcessor(db, config, new SmtpAccountMailProvider(config));
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
        console.error('mail_worker cycle_failed');
    }
    await writeFile(
        '/run/meal-mail-worker/health.json',
        JSON.stringify({ state, observedAt: new Date().toISOString() }),
        { mode: 0o600 },
    );
    await new Promise((resolve) => setTimeout(resolve, config.MAIL_WORKER_POLL_MS));
}
await db.destroy();
