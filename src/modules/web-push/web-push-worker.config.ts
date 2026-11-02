import { readFileSync } from 'node:fs';
import { z } from 'zod';
const secret = (env: NodeJS.ProcessEnv, name: string) => {
    const file = env[`${name}_FILE`];
    if (!file) throw new Error(`${name}_FILE is required`);
    return readFileSync(file, 'utf8').trim();
};
export function readWebPushWorkerConfig(env: NodeJS.ProcessEnv) {
    const schema = z.object({
        WEB_PUSH_VAPID_SUBJECT: z.string().regex(/^mailto:/),
        WEB_PUSH_VAPID_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
        WEB_PUSH_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(10),
        WEB_PUSH_WORKER_POLL_MS: z.coerce.number().int().min(250).max(60000).default(2000),
        WEB_PUSH_WORKER_LEASE_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
    });
    const parsed = schema.parse(env);
    return {
        ...parsed,
        databaseUrl: secret(env, 'DATABASE_URL'),
        privateKey: secret(env, 'WEB_PUSH_VAPID_PRIVATE_KEY'),
        subscriptionKey: Buffer.from(secret(env, 'WEB_PUSH_SUBSCRIPTION_KEY'), 'base64'),
    };
}
