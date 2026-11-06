import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const schema = z.object({
    NODE_ENV: z.literal('production'),
    DATABASE_URL_FILE: z.string(),
    AI_API_TOKEN_FILE: z.string(),
    AI_API_BASE_URL: z.url(),
    AI_MODEL: z.string().trim().min(1).max(128),
    AI_WORKER_OWNER_ID: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    AI_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(5),
    AI_WORKER_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
    AI_WORKER_PROVIDER_POLL_MS: z.coerce.number().int().min(500).max(30_000).default(2_000),
    AI_WORKER_LEASE_SECONDS: z.coerce.number().int().min(60).max(600).default(180),
});

function secret(file: string, name: string) {
    if (!isAbsolute(file)) throw new Error(`${name} must be an absolute path`);
    let value: string;
    try {
        value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch {
        throw new Error(`Unable to read ${name}`);
    }
    if (!value || /[\r\n\0]/.test(value)) throw new Error(`${name} must contain one non-empty line`);
    return value;
}

export type AiWorkerConfig = ReturnType<typeof readAiWorkerConfig>;
export function readAiWorkerConfig(env: NodeJS.ProcessEnv) {
    if (env.DATABASE_URL || env.AI_API_TOKEN) throw new Error('AI worker secrets must use *_FILE');
    const value = schema.parse(env);
    const databaseUrl = secret(value.DATABASE_URL_FILE, 'DATABASE_URL_FILE');
    const apiToken = secret(value.AI_API_TOKEN_FILE, 'AI_API_TOKEN_FILE');
    const database = new URL(databaseUrl);
    const provider = new URL(value.AI_API_BASE_URL);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.pathname !== '/meal_planner_postgres')
        throw new Error('AI worker database must target meal_planner_postgres');
    if (provider.protocol !== 'https:' || provider.username || provider.password || provider.search || provider.hash)
        throw new Error('AI_API_BASE_URL must be a credential-free HTTPS URL');
    if (value.AI_WORKER_LEASE_SECONDS * 1_000 < 2 * 30_000 + value.AI_WORKER_PROVIDER_POLL_MS)
        throw new Error('AI_WORKER_LEASE_SECONDS must cover provider timeouts and polling margin');
    return { ...value, databaseUrl, apiToken };
}
