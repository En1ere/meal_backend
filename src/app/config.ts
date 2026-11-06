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
    ACCOUNT_MAIL_ENABLED: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    ACCOUNT_MAIL_TOKEN_KEY: z
        .string()
        .regex(/^[A-Za-z0-9+/]{43}=$/)
        .optional(),
    WEB_PUSH_ENABLED: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    WEB_PUSH_VAPID_SUBJECT: z
        .string()
        .regex(/^mailto:[^\s@]+@[^\s@]+$/)
        .default('mailto:saix789@gmail.com'),
    WEB_PUSH_VAPID_PUBLIC_KEY: z
        .string()
        .regex(/^[A-Za-z0-9_-]{87}$/)
        .optional(),
    WEB_PUSH_VAPID_PRIVATE_KEY: z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .optional(),
    WEB_PUSH_SUBSCRIPTION_KEY: z
        .string()
        .regex(/^[A-Za-z0-9+/]{43}=$/)
        .optional(),
    LEGAL_EVIDENCE_MODE: z.enum(['approved', 'demonstration']).default('approved'),
    MEDIA_STORAGE_ENABLED: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    MEDIA_STORAGE_ENDPOINT: z.url().optional(),
    MEDIA_STORAGE_BACKEND_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    MEDIA_STORAGE_REGION: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
        .optional(),
    MEDIA_STORAGE_ACCESS_KEY_ID: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/)
        .optional(),
    MEDIA_STORAGE_SECRET_ACCESS_KEY: z.string().min(32).max(256).optional(),
    MEDIA_STORAGE_QUARANTINE_BUCKET: z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
        .optional(),
    MEDIA_STORAGE_READY_BUCKET: z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
        .optional(),
    MEDIA_STORAGE_PREFIX: z
        .string()
        .regex(/^[a-z0-9](?:[a-z0-9/_-]{0,126}[a-z0-9])?$/)
        .optional(),
    MEDIA_STORAGE_FORCE_PATH_STYLE: z
        .enum(['true', 'false'])
        .default('true')
        .transform((value) => value === 'true'),
    MEDIA_STORAGE_PUBLIC_ORIGIN: z.url().optional(),
    MEDIA_STORAGE_SIGNING_KEY: z
        .string()
        .regex(/^[A-Za-z0-9+/]{43}=$/)
        .optional(),
    MEDIA_STORAGE_ENCRYPTION_KEY: z
        .string()
        .regex(/^[A-Za-z0-9+/]{43}=$/)
        .optional(),
    MEDIA_STORAGE_KEY_VERSION: z.coerce.number().int().min(1).max(32767).optional(),
    INLINE_INGEST_OCR_ENABLED: z
        .enum(['true', 'false'])
        .transform((value) => value === 'true')
        .optional(),
    OCR_PREVIEW_URL: z.url().optional(),
    OCR_PREVIEW_TOKEN: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    OCR_PREVIEW_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(60_000),
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
    AI_BACKGROUND_EXECUTION_ENABLED: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
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
    ACCOUNT_MAIL_TOKEN_KEY: 'ACCOUNT_MAIL_TOKEN_KEY_FILE',
    WEB_PUSH_VAPID_PRIVATE_KEY: 'WEB_PUSH_VAPID_PRIVATE_KEY_FILE',
    WEB_PUSH_SUBSCRIPTION_KEY: 'WEB_PUSH_SUBSCRIPTION_KEY_FILE',
    MEDIA_STORAGE_SECRET_ACCESS_KEY: 'MEDIA_STORAGE_SECRET_ACCESS_KEY_FILE',
    MEDIA_STORAGE_SIGNING_KEY: 'MEDIA_STORAGE_SIGNING_KEY_FILE',
    MEDIA_STORAGE_ENCRYPTION_KEY: 'MEDIA_STORAGE_ENCRYPTION_KEY_FILE',
    OCR_PREVIEW_TOKEN: 'OCR_PREVIEW_TOKEN_FILE',
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
    if (env.NODE_ENV === 'production' && env.OCR_PREVIEW_TOKEN)
        throw new Error('OCR_PREVIEW_TOKEN must use OCR_PREVIEW_TOKEN_FILE in production');
    if (env.NODE_ENV === 'production' && (env.WEB_PUSH_VAPID_PRIVATE_KEY || env.WEB_PUSH_SUBSCRIPTION_KEY))
        throw new Error('Web Push private keys must use root-owned *_FILE inputs in production');
    const result = configSchema.safeParse(withSecretFiles(env));
    if (!result.success) {
        throw new Error(
            `Invalid configuration fields: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
        );
    }
    const config = {
        ...result.data,
        INLINE_INGEST_OCR_ENABLED: result.data.INLINE_INGEST_OCR_ENABLED ?? result.data.NODE_ENV !== 'production',
    };
    const ocrPreviewFields = [config.OCR_PREVIEW_URL, config.OCR_PREVIEW_TOKEN].filter(Boolean).length;
    if (ocrPreviewFields !== 0 && ocrPreviewFields !== 2)
        throw new Error('OCR_PREVIEW_URL and OCR_PREVIEW_TOKEN must be configured together');
    if (ocrPreviewFields && !config.INLINE_INGEST_OCR_ENABLED)
        throw new Error('OCR preview configuration requires explicit OCR enablement');
    if (config.NODE_ENV === 'production' && config.INLINE_INGEST_OCR_ENABLED) {
        if (config.OCR_PREVIEW_URL !== 'http://ocr-preview:3100' || !config.OCR_PREVIEW_TOKEN)
            throw new Error('Production OCR requires the isolated internal preview service');
    }
    const aiEndpointFields = [config.AI_API_BASE_URL, config.AI_MODEL].filter(Boolean).length;
    if (aiEndpointFields !== 0 && aiEndpointFields !== 2)
        throw new Error('AI_API_BASE_URL and AI_MODEL must be configured together');
    if (config.AI_API_TOKEN && aiEndpointFields !== 2)
        throw new Error('AI_API_TOKEN requires AI_API_BASE_URL and AI_MODEL');
    if (config.AI_BACKGROUND_EXECUTION_ENABLED && aiEndpointFields !== 2)
        throw new Error('AI background execution requires AI_API_BASE_URL and AI_MODEL');
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
    if (config.NODE_ENV === 'production' && config.ACCOUNT_MAIL_ENABLED && !config.ACCOUNT_MAIL_TOKEN_KEY)
        throw new Error('Enabled account mail requires ACCOUNT_MAIL_TOKEN_KEY');
    const pushFields = [
        config.WEB_PUSH_VAPID_PUBLIC_KEY,
        config.WEB_PUSH_VAPID_PRIVATE_KEY,
        config.WEB_PUSH_SUBSCRIPTION_KEY,
    ].filter(Boolean).length;
    if (!config.WEB_PUSH_ENABLED && pushFields !== 0)
        throw new Error('Web Push key material requires WEB_PUSH_ENABLED=true');
    if (config.WEB_PUSH_ENABLED && pushFields !== 3)
        throw new Error('Enabled Web Push requires public, private and subscription keys');
    const mediaStorageFields = [
        config.MEDIA_STORAGE_ENDPOINT,
        config.MEDIA_STORAGE_BACKEND_PORT,
        config.MEDIA_STORAGE_REGION,
        config.MEDIA_STORAGE_ACCESS_KEY_ID,
        config.MEDIA_STORAGE_SECRET_ACCESS_KEY,
        config.MEDIA_STORAGE_QUARANTINE_BUCKET,
        config.MEDIA_STORAGE_READY_BUCKET,
        config.MEDIA_STORAGE_PREFIX,
        config.MEDIA_STORAGE_PUBLIC_ORIGIN,
        config.MEDIA_STORAGE_SIGNING_KEY,
        config.MEDIA_STORAGE_ENCRYPTION_KEY,
        config.MEDIA_STORAGE_KEY_VERSION,
    ];
    const configuredMediaFields = mediaStorageFields.filter((value) => value !== undefined).length;
    if (!config.MEDIA_STORAGE_ENABLED && configuredMediaFields !== 0)
        throw new Error('Media storage fields require MEDIA_STORAGE_ENABLED=true');
    if (config.MEDIA_STORAGE_ENABLED && configuredMediaFields !== mediaStorageFields.length)
        throw new Error(
            'Enabled media storage requires the complete endpoint, credential, bucket and key configuration',
        );
    if (config.MEDIA_STORAGE_ENABLED) {
        if (
            config.NODE_ENV === 'production' &&
            [env.MEDIA_STORAGE_SECRET_ACCESS_KEY, env.MEDIA_STORAGE_SIGNING_KEY, env.MEDIA_STORAGE_ENCRYPTION_KEY].some(
                (value) => value !== undefined,
            )
        )
            throw new Error('Production media secrets must use root-owned *_FILE inputs');
        const endpoint = new URL(config.MEDIA_STORAGE_ENDPOINT!);
        const publicOrigin = new URL(config.MEDIA_STORAGE_PUBLIC_ORIGIN!);
        if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash)
            throw new Error('MEDIA_STORAGE_ENDPOINT must be a credential-free HTTP(S) origin without port or path');
        if (endpoint.port) throw new Error('Configure the S3 port only through MEDIA_STORAGE_BACKEND_PORT');
        if (!['http:', 'https:'].includes(endpoint.protocol))
            throw new Error('MEDIA_STORAGE_ENDPOINT must use HTTP or HTTPS');
        if (publicOrigin.origin !== config.MEDIA_STORAGE_PUBLIC_ORIGIN || publicOrigin.protocol !== 'https:')
            throw new Error('MEDIA_STORAGE_PUBLIC_ORIGIN must be an exact HTTPS origin');
        if (
            config.NODE_ENV === 'production' &&
            endpoint.protocol !== 'https:' &&
            (!/^[a-z][a-z0-9-]{1,62}$/.test(endpoint.hostname) || endpoint.hostname === 'localhost')
        )
            throw new Error('Plain HTTP media storage is allowed only on an internal Docker DNS hostname');
        if (config.MEDIA_STORAGE_QUARANTINE_BUCKET === config.MEDIA_STORAGE_READY_BUCKET)
            throw new Error('Quarantine and ready media buckets must be distinct');
        if (config.MEDIA_STORAGE_SIGNING_KEY === config.MEDIA_STORAGE_ENCRYPTION_KEY)
            throw new Error('Media signing and encryption keys must be independent');
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
