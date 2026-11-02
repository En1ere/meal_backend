import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { readMediaProcessorConfig } from '../dist/src/modules/media-processing/media-processor.config.js';
import { MediaProcessorRepository } from '../dist/src/modules/media-processing/media-processor.repository.js';
import { MediaProcessorStorage } from '../dist/src/modules/media-processing/media-processor.storage.js';
import { MediaProcessor } from '../dist/src/modules/media-processing/media-processor.js';
import { databasePoolConfig } from '../dist/src/infrastructure/database/database.service.js';

const config = readMediaProcessorConfig(process.env);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => (stopping = true));
const health = async (state) =>
    writeFile(
        '/run/meal-media-processor/health.json',
        JSON.stringify({ state, observedAt: new Date().toISOString() }),
        { mode: 0o600 },
    );

if (!config.enabled) {
    while (!stopping) {
        await health('disabled');
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 30_000));
    }
} else {
    const pool = new pg.Pool({
        ...databasePoolConfig(config.databaseUrl),
        max: 1,
        connectionTimeoutMillis: 3_000,
        statement_timeout: 10_000,
        application_name: 'meal-media-processor',
    });
    pool.on('error', () => console.error('media_processor database_error'));
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    const repository = new MediaProcessorRepository(
        db,
        config.MEDIA_PROCESSOR_OWNER_ID,
        config.MEDIA_PROCESSOR_LEASE_SECONDS,
        config.MEDIA_PROCESSOR_MAX_ATTEMPTS,
    );
    const storage = new MediaProcessorStorage(config);
    const processor = new MediaProcessor(config, repository, storage, resolve('scripts/run-image-cdr-child.mjs'));
    while (!stopping) {
        let state = 'ok';
        try {
            await processor.runOnce();
        } catch {
            state = 'degraded';
            console.error('media_processor cycle_failed');
        }
        await health(state);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, config.MEDIA_PROCESSOR_POLL_MS));
    }
    storage.destroy();
    await db.destroy();
}
