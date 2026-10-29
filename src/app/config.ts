import { z } from 'zod';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../shared/config/app-config.js';

export { APP_CONFIG, type AppConfig } from '../shared/config/app-config.js';

export const configSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    FRONTEND_ORIGIN: z.url().default('http://localhost:3000'),
    ADMIN_FRONTEND_ORIGIN: z.url().optional(),
    ADMIN_ALLOWED_IPS: z
        .string()
        .default('')
        .transform((value) => (value.trim() === '' ? [] : value.split(',').map((entry) => entry.trim())))
        .refine((values) => values.every((value) => isIP(value) !== 0), 'Expected exact IPv4/IPv6 addresses'),
    DATABASE_URL: z.string().optional(),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    OBSERVABILITY_HOST_SNAPSHOT_ENABLED: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    OBSERVABILITY_HOST_SNAPSHOT_FILE: z
        .string()
        .trim()
        .transform((value) => (value === '' ? undefined : value))
        .optional(),
    WORKER_OWNER_ID: z
        .string()
        .regex(/^[a-z][a-z0-9-]{2,63}$/)
        .optional(),
    COOKING_LIFECYCLE_ENABLED: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
    APP_VERSION: z
        .string()
        .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
        .max(64)
        .optional(),
    SECURITY_KEY: z.string().min(43).optional(),
    MFA_ENCRYPTION_KEY: z
        .string()
        .regex(/^[A-Za-z0-9+/]{43}=$/)
        .optional(),
    AUTH_RATE_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
    PIN_TRUST_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    REGISTRATION_RISK_ENABLED: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    REGISTRATION_RISK_FAILURE_MODE: z.enum(['fail_closed', 'fail_open']).default('fail_closed'),
    REGISTRATION_DISPOSABLE_EMAIL_CHECK: z
        .enum(['true', 'false'])
        .default('true')
        .transform((value) => value === 'true'),
    REGISTRATION_CAPTCHA_MODE: z.enum(['disabled', 'risk_based', 'always']).default('risk_based'),
    REGISTRATION_DENY_RISK_SCORE: z.coerce.number().min(0).max(1).default(0.9),
    AI_API_BASE_URL: z
        .url()
        .refine((value) => value.endsWith('/'), 'AI API base URL must end with /')
        .optional(),
    AI_API_TOKEN: z.string().min(1).optional(),
    AI_MODEL: z.string().min(1).max(200).optional(),
    AI_RECONCILIATION_ENABLED: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    TRUSTED_PROXY_CIDRS: z
        .string()
        .default('')
        .transform((v) =>
            v
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
        )
        .refine(
            (values) =>
                values.every((value) => {
                    const [ip, mask, ...rest] = value.split('/');
                    const version = isIP(ip ?? '');
                    return (
                        version !== 0 &&
                        rest.length === 0 &&
                        (mask === undefined || (/^\d+$/.test(mask) && Number(mask) <= (version === 4 ? 32 : 128)))
                    );
                }),
            'Expected explicit proxy IPs/CIDRs',
        ),
});
const secretFiles = {
    DATABASE_URL: 'DATABASE_URL_FILE',
    SECURITY_KEY: 'SECURITY_KEY_FILE',
    MFA_ENCRYPTION_KEY: 'MFA_ENCRYPTION_KEY_FILE',
} as const;

function withSecretFiles(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const resolved = { ...env };
    for (const [field, fileField] of Object.entries(secretFiles) as [keyof typeof secretFiles, string][]) {
        const direct = env[field];
        const file = env[fileField];
        if (direct && file) throw new Error(`Configure either ${field} or ${fileField}, not both`);
        if (!file) continue;
        if (!isAbsolute(file)) throw new Error(`${fileField} must be an absolute path`);
        let value: string;
        try {
            value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
        } catch {
            throw new Error(`Unable to read ${fileField}`);
        }
        if (!value || /[\r\n\0]/.test(value)) throw new Error(`${fileField} must contain one non-empty line`);
        resolved[field] = value;
    }
    return resolved;
}

export function readConfig(env: NodeJS.ProcessEnv): AppConfig {
    const result = configSchema.safeParse(withSecretFiles(env));
    if (!result.success) {
        throw new Error(
            `Invalid configuration fields: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
        );
    }
    const config = result.data;
    const aiFields = [config.AI_API_BASE_URL, config.AI_API_TOKEN, config.AI_MODEL].filter(Boolean).length;
    if (aiFields !== 0 && aiFields !== 3)
        throw new Error('AI_API_BASE_URL, AI_API_TOKEN and AI_MODEL must be configured together');
    if (!config.ADMIN_FRONTEND_ORIGIN && config.NODE_ENV !== 'production')
        config.ADMIN_FRONTEND_ORIGIN = 'http://localhost:3002';
    if (config.ADMIN_FRONTEND_ORIGIN) {
        const adminOrigin = new URL(config.ADMIN_FRONTEND_ORIGIN);
        if (
            !['http:', 'https:'].includes(adminOrigin.protocol) ||
            adminOrigin.origin !== config.ADMIN_FRONTEND_ORIGIN ||
            (config.NODE_ENV === 'production' && adminOrigin.protocol !== 'https:')
        )
            throw new Error('ADMIN_FRONTEND_ORIGIN must be an HTTP(S) origin, HTTPS in production');
    }
    const origin = new URL(config.FRONTEND_ORIGIN);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== config.FRONTEND_ORIGIN) {
        throw new Error('FRONTEND_ORIGIN must be an HTTP(S) origin without a path');
    }
    if (
        config.NODE_ENV === 'production' &&
        (origin.protocol !== 'https:' || !config.DATABASE_URL || !config.SECURITY_KEY || !config.MFA_ENCRYPTION_KEY)
    ) {
        throw new Error('Production requires HTTPS frontend origin, DATABASE_URL and authentication keys');
    }
    if (config.DATABASE_URL) {
        let connection: URL;
        try {
            connection = new URL(config.DATABASE_URL);
        } catch {
            throw new Error('Invalid DATABASE_URL');
        }
        if (
            !['postgres:', 'postgresql:'].includes(connection.protocol) ||
            connection.pathname !== '/meal_planner_postgres'
        ) {
            throw new Error('DATABASE_URL must target PostgreSQL meal_planner_postgres');
        }
    }
    if (config.OBSERVABILITY_HOST_SNAPSHOT_ENABLED !== Boolean(config.OBSERVABILITY_HOST_SNAPSHOT_FILE))
        throw new Error('Host observability requires both enabled flag and snapshot path');
    if (
        config.OBSERVABILITY_HOST_SNAPSHOT_FILE &&
        (config.NODE_ENV === 'production'
            ? config.OBSERVABILITY_HOST_SNAPSHOT_FILE !== '/run/meal-observability/current.json'
            : !isAbsolute(config.OBSERVABILITY_HOST_SNAPSHOT_FILE))
    )
        throw new Error('OBSERVABILITY_HOST_SNAPSHOT_FILE is not an approved absolute path');
    if (
        config.NODE_ENV === 'production' &&
        (config.AI_RECONCILIATION_ENABLED || config.COOKING_LIFECYCLE_ENABLED) &&
        !config.WORKER_OWNER_ID
    )
        throw new Error('Enabled embedded workers require a stable WORKER_OWNER_ID in production');
    return config;
}
