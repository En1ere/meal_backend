import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((value) => value === 'true');
const schema = z.object({
    NODE_ENV: z.literal('production'),
    DATABASE_URL_FILE: z.string(),
    ACCOUNT_MAIL_TOKEN_KEY_FILE: z.string(),
    SMTP_PASSWORD_FILE: z.string(),
    SMTP_HOST: z.string().min(1).max(253),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535),
    SMTP_SECURE: bool,
    SMTP_REQUIRE_TLS: z
        .enum(['true', 'false'])
        .default('true')
        .transform((value) => value === 'true'),
    SMTP_USERNAME: z.string().min(1).max(320),
    SMTP_FROM: z.email().max(254),
    SMTP_REPLY_TO: z
        .string()
        .trim()
        .transform((value) => (value === '' ? undefined : value))
        .pipe(z.email().max(254).optional())
        .optional(),
    FRONTEND_ORIGIN: z.url(),
    MAIL_WORKER_OWNER_ID: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    MAIL_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    MAIL_WORKER_POLL_MS: z.coerce.number().int().min(250).max(60000).default(2000),
    MAIL_WORKER_LEASE_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
    SMTP_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
    SMTP_SOCKET_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
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

export type MailWorkerConfig = ReturnType<typeof readMailWorkerConfig>;
export function readMailWorkerConfig(env: NodeJS.ProcessEnv) {
    if (env.DATABASE_URL || env.ACCOUNT_MAIL_TOKEN_KEY || env.SMTP_PASSWORD)
        throw new Error('Mail worker secrets must use *_FILE');
    const value = schema.parse(env);
    const databaseUrl = secret(value.DATABASE_URL_FILE, 'DATABASE_URL_FILE');
    const tokenKey = secret(value.ACCOUNT_MAIL_TOKEN_KEY_FILE, 'ACCOUNT_MAIL_TOKEN_KEY_FILE');
    const smtpPassword = secret(value.SMTP_PASSWORD_FILE, 'SMTP_PASSWORD_FILE');
    const database = new URL(databaseUrl);
    const origin = new URL(value.FRONTEND_ORIGIN);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.pathname !== '/meal_planner_postgres')
        throw new Error('Mail worker database must target meal_planner_postgres');
    if (origin.protocol !== 'https:' || origin.origin !== value.FRONTEND_ORIGIN)
        throw new Error('FRONTEND_ORIGIN must be an HTTPS origin');
    if (!value.SMTP_REQUIRE_TLS || (!value.SMTP_SECURE && value.SMTP_PORT === 465))
        throw new Error('Production SMTP must verify TLS; port 465 requires SMTP_SECURE=true');
    if (
        value.MAIL_WORKER_LEASE_SECONDS * 1000 <
        value.SMTP_CONNECTION_TIMEOUT_MS + value.SMTP_SOCKET_TIMEOUT_MS + 10_000
    )
        throw new Error('MAIL_WORKER_LEASE_SECONDS must cover SMTP timeouts and shutdown margin');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(tokenKey)) throw new Error('Invalid ACCOUNT_MAIL_TOKEN_KEY_FILE');
    return { ...value, databaseUrl, tokenKey, smtpPassword };
}
