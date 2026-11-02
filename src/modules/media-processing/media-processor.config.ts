import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((value) => value === 'true');
const schema = z.object({
    NODE_ENV: z.literal('production'),
    MEDIA_PROCESSOR_ENABLED: bool.default(false),
    MEDIA_PROCESSOR_DATABASE_URL_FILE: z.string().optional(),
    MEDIA_PROCESSOR_STORAGE_SECRET_ACCESS_KEY_FILE: z.string().optional(),
    MEDIA_PROCESSOR_ENCRYPTION_KEY_FILE: z.string().optional(),
    MEDIA_PROCESSOR_STORAGE_ENDPOINT: z.string().optional(),
    MEDIA_PROCESSOR_STORAGE_PORT: z.coerce.number().int().min(1).max(65535).default(8333),
    MEDIA_PROCESSOR_STORAGE_REGION: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
        .default('us-east-1'),
    MEDIA_PROCESSOR_STORAGE_ACCESS_KEY_ID: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/)
        .optional(),
    MEDIA_PROCESSOR_QUARANTINE_BUCKET: z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
        .optional(),
    MEDIA_PROCESSOR_READY_BUCKET: z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
        .optional(),
    MEDIA_PROCESSOR_STORAGE_PREFIX: z
        .string()
        .regex(/^[a-z0-9](?:[a-z0-9/_-]{0,126}[a-z0-9])?$/)
        .optional(),
    MEDIA_PROCESSOR_KEY_VERSION: z.coerce.number().int().min(1).max(32767).optional(),
    MEDIA_PROCESSOR_OWNER_ID: z
        .string()
        .regex(/^[a-z][a-z0-9-]{2,63}$/)
        .default('media-primary'),
    MEDIA_PROCESSOR_CONCURRENCY: z.coerce.number().int().min(1).max(1).default(1),
    MEDIA_PROCESSOR_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
    MEDIA_PROCESSOR_LEASE_SECONDS: z.coerce.number().int().min(60).max(600).default(120),
    MEDIA_PROCESSOR_CDR_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(90_000).default(45_000),
    MEDIA_PROCESSOR_KILL_GRACE_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
    MEDIA_PROCESSOR_STORAGE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(15_000),
    MEDIA_PROCESSOR_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
});

function secret(file: string | undefined, name: string): string {
    if (!file || !isAbsolute(file)) throw new Error(`${name} must be an absolute path`);
    let value: string;
    try {
        value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch {
        throw new Error(`Unable to read ${name}`);
    }
    if (!value || /[\r\n\0]/.test(value)) throw new Error(`${name} must contain one non-empty line`);
    return value;
}

export type MediaProcessorConfig = ReturnType<typeof readMediaProcessorConfig>;

export function readMediaProcessorConfig(env: NodeJS.ProcessEnv) {
    if (
        env.DATABASE_URL ||
        env.MEDIA_PROCESSOR_DATABASE_URL ||
        env.MEDIA_PROCESSOR_STORAGE_SECRET_ACCESS_KEY ||
        env.MEDIA_PROCESSOR_ENCRYPTION_KEY
    )
        throw new Error('Media processor secrets must use dedicated *_FILE inputs');
    const value = schema.parse(env);
    if (!value.MEDIA_PROCESSOR_ENABLED) return { ...value, enabled: false as const };

    const databaseUrl = secret(value.MEDIA_PROCESSOR_DATABASE_URL_FILE, 'MEDIA_PROCESSOR_DATABASE_URL_FILE');
    const storageSecretAccessKey = secret(
        value.MEDIA_PROCESSOR_STORAGE_SECRET_ACCESS_KEY_FILE,
        'MEDIA_PROCESSOR_STORAGE_SECRET_ACCESS_KEY_FILE',
    );
    const encryptionKey = secret(value.MEDIA_PROCESSOR_ENCRYPTION_KEY_FILE, 'MEDIA_PROCESSOR_ENCRYPTION_KEY_FILE');
    const required = [
        value.MEDIA_PROCESSOR_STORAGE_ENDPOINT,
        value.MEDIA_PROCESSOR_STORAGE_ACCESS_KEY_ID,
        value.MEDIA_PROCESSOR_QUARANTINE_BUCKET,
        value.MEDIA_PROCESSOR_READY_BUCKET,
        value.MEDIA_PROCESSOR_STORAGE_PREFIX,
        value.MEDIA_PROCESSOR_KEY_VERSION,
    ];
    if (required.some((entry) => entry === undefined))
        throw new Error('Enabled media processor requires complete storage and encryption configuration');
    const database = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.pathname !== '/meal_planner_postgres')
        throw new Error('Media processor database must target meal_planner_postgres');
    if (database.searchParams.get('options') !== '-c role=meal_media_worker')
        throw new Error('Media processor database must SET ROLE meal_media_worker');
    const endpoint = new URL(value.MEDIA_PROCESSOR_STORAGE_ENDPOINT!);
    if (
        endpoint.protocol !== 'http:' ||
        endpoint.hostname !== 'seaweedfs' ||
        endpoint.port ||
        endpoint.pathname !== '/' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
    )
        throw new Error('Media processor storage must use the internal http://seaweedfs origin');
    if (value.MEDIA_PROCESSOR_QUARANTINE_BUCKET === value.MEDIA_PROCESSOR_READY_BUCKET)
        throw new Error('Media processor buckets must be distinct');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey)) throw new Error('Invalid media processor encryption key');
    if (storageSecretAccessKey.length < 32 || storageSecretAccessKey.length > 256)
        throw new Error('Invalid media processor storage secret');
    if (
        value.MEDIA_PROCESSOR_LEASE_SECONDS * 1000 <
        value.MEDIA_PROCESSOR_CDR_TIMEOUT_MS + value.MEDIA_PROCESSOR_STORAGE_TIMEOUT_MS * 2 + 10_000
    )
        throw new Error('Media processor lease must cover CDR, storage and shutdown margins');
    return {
        ...value,
        enabled: true as const,
        databaseUrl,
        storageSecretAccessKey,
        encryptionKey: Buffer.from(encryptionKey, 'base64'),
        storageEndpoint: `${endpoint.origin}:${value.MEDIA_PROCESSOR_STORAGE_PORT}`,
        storageAccessKeyId: value.MEDIA_PROCESSOR_STORAGE_ACCESS_KEY_ID!,
        quarantineBucket: value.MEDIA_PROCESSOR_QUARANTINE_BUCKET!,
        readyBucket: value.MEDIA_PROCESSOR_READY_BUCKET!,
        storagePrefix: value.MEDIA_PROCESSOR_STORAGE_PREFIX!,
        keyVersion: value.MEDIA_PROCESSOR_KEY_VERSION!,
    };
}
