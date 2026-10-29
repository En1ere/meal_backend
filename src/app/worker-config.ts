import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AppConfig } from '../shared/config/app-config.js';

export function readWorkerApplicationConfig(env: NodeJS.ProcessEnv): AppConfig {
    if (env.DATABASE_URL) throw new Error('Worker database credentials must use DATABASE_URL_FILE');
    const file = env.DATABASE_URL_FILE;
    if (!file || !isAbsolute(file)) throw new Error('Worker requires an absolute DATABASE_URL_FILE');
    let databaseUrl: string;
    try {
        databaseUrl = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch {
        throw new Error('Unable to read worker DATABASE_URL_FILE');
    }
    if (!databaseUrl || /[\r\n\0]/.test(databaseUrl)) throw new Error('Worker DATABASE_URL_FILE is invalid');
    const connection = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(connection.protocol) || connection.pathname !== '/meal_planner_postgres')
        throw new Error('Worker database must target meal_planner_postgres');
    const poolSize = Number(env.WORKER_DATABASE_POOL_SIZE ?? '2');
    if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 10)
        throw new Error('Invalid WORKER_DATABASE_POOL_SIZE');
    return {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 3001,
        FRONTEND_ORIGIN: env.FRONTEND_ORIGIN ?? 'https://worker.invalid',
        ADMIN_FRONTEND_ORIGIN: env.ADMIN_FRONTEND_ORIGIN ?? 'https://worker.invalid',
        ADMIN_ALLOWED_IPS: [],
        DATABASE_URL: databaseUrl,
        DATABASE_POOL_SIZE: poolSize,
        OBSERVABILITY_HOST_SNAPSHOT_ENABLED: false,
        OBSERVABILITY_HOST_SNAPSHOT_FILE: undefined,
        WORKER_OWNER_ID: env.WORKER_OWNER_ID,
        COOKING_LIFECYCLE_ENABLED: false,
        LOG_LEVEL: 'warn',
        APP_VERSION: env.APP_VERSION,
        AUTH_RATE_LIMIT: 10,
        PIN_TRUST_DAYS: 30,
        REGISTRATION_RISK_ENABLED: false,
        REGISTRATION_RISK_FAILURE_MODE: 'fail_closed',
        REGISTRATION_DISPOSABLE_EMAIL_CHECK: true,
        REGISTRATION_CAPTCHA_MODE: 'disabled',
        REGISTRATION_DENY_RISK_SCORE: 0.9,
        AI_RECONCILIATION_ENABLED: false,
        TRUSTED_PROXY_CIDRS: [],
    };
}
