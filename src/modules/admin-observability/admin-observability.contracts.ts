import { z } from 'zod';
import { workerRunObservationSchema } from '../operational-runtime/worker-runtime.js';
import { workerTaskIdSchema } from '../operational-runtime/worker-topology.js';
import { providerObservationSchema, providerServiceSchema } from '../provider-runtime/provider-runtime.js';

const boundedCount = z.number().int().min(0).max(1_000_000_000);
const boundedBytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedDuration = z.number().int().min(0).max(86_400_000);
const timestamp = z.iso.datetime();

export const observabilityFreshnessSchema = z.strictObject({
    state: z.enum(['fresh', 'stale', 'unavailable', 'no_samples']),
    observedAt: timestamp.nullable(),
    ageSeconds: z.number().int().min(0).max(31_536_000).nullable(),
    staleAfterSeconds: z.number().int().min(1).max(604_800),
});

export const observabilityContainerServiceSchema = z.enum(['postgres', 'backend', 'worker', 'frontend', 'admin']);
export const observabilityContainerStateSchema = z.enum([
    'running',
    'exited',
    'restarting',
    'paused',
    'created',
    'missing',
    'unknown',
]);
export const observabilityContainerHealthSchema = z.enum(['healthy', 'unhealthy', 'starting', 'none', 'unknown']);
export const observabilityFilesystemScopeSchema = z.enum(['root', 'deployment', 'backups']);

const hostFilesystemSchema = z.strictObject({
    scope: observabilityFilesystemScopeSchema,
    totalBytes: boundedBytes.nullable(),
    availableBytes: boundedBytes.nullable(),
    usedPercent: z.number().int().min(0).max(100).nullable(),
});
const containerSnapshotSchema = z.strictObject({
    service: observabilityContainerServiceSchema,
    state: observabilityContainerStateSchema,
    health: observabilityContainerHealthSchema,
    restartCount: boundedCount.nullable(),
    cpuPermille: z.number().int().min(0).max(1_000_000).nullable(),
    memoryBytes: boundedBytes.nullable(),
    memoryLimitBytes: boundedBytes.nullable(),
    pids: boundedCount.nullable(),
});

const uniqueBy = <T>(values: readonly T[], key: (value: T) => string) =>
    new Set(values.map((value) => key(value))).size === values.length;

export const hostCollectorSnapshotSchema = z
    .strictObject({
        schemaVersion: z.literal(1),
        collectedAt: timestamp,
        collectorStatus: z.enum(['ok', 'partial']),
        durationMs: boundedDuration,
        host: z.strictObject({
            memoryTotalBytes: boundedBytes.nullable(),
            memoryAvailableBytes: boundedBytes.nullable(),
            load1mMilli: z.number().int().min(0).max(1_000_000).nullable(),
            uptimeSeconds: z.number().int().min(0).max(3_153_600_000).nullable(),
            rebootRequired: z.boolean().nullable(),
            filesystems: z.array(hostFilesystemSchema).length(observabilityFilesystemScopeSchema.options.length),
        }),
        containers: z.array(containerSnapshotSchema).length(observabilityContainerServiceSchema.options.length),
    })
    .superRefine((value, context) => {
        if (!uniqueBy(value.host.filesystems, (item) => item.scope))
            context.addIssue({ code: 'custom', path: ['host', 'filesystems'], message: 'Duplicate filesystem scope' });
        if (!uniqueBy(value.containers, (item) => item.service))
            context.addIssue({ code: 'custom', path: ['containers'], message: 'Duplicate container service' });
    });
export type HostCollectorSnapshot = z.infer<typeof hostCollectorSnapshotSchema>;

const hostSchema = z.strictObject({
    freshness: observabilityFreshnessSchema,
    unavailableReason: z.enum(['disabled', 'missing', 'unreadable', 'invalid', 'clock_skew']).nullable(),
    collectorStatus: z.enum(['ok', 'partial']).nullable(),
    durationMs: boundedDuration.nullable(),
    memory: z.strictObject({ totalBytes: boundedBytes, availableBytes: boundedBytes }).nullable(),
    load1mMilli: z.number().int().min(0).max(1_000_000).nullable(),
    uptimeSeconds: z.number().int().min(0).max(3_153_600_000).nullable(),
    rebootRequired: z.boolean().nullable(),
    filesystems: z.array(hostFilesystemSchema).max(observabilityFilesystemScopeSchema.options.length),
    containers: z.array(containerSnapshotSchema).max(observabilityContainerServiceSchema.options.length),
});

const databaseSchema = z.strictObject({
    freshness: observabilityFreshnessSchema,
    queryDurationMs: boundedDuration.nullable(),
    schemaVersion: z.number().int().min(0).max(100_000).nullable(),
    databaseSizeBytes: boundedBytes.nullable(),
    backendPool: z
        .strictObject({
            max: z.number().int().min(1).max(50),
            total: z.number().int().min(0).max(50),
            idle: z.number().int().min(0).max(50),
            waiting: boundedCount,
        })
        .nullable(),
});

const queueSchema = z.strictObject({
    freshness: observabilityFreshnessSchema,
    counts: z
        .strictObject({
            pending: boundedCount,
            queued: boundedCount,
            running: boundedCount,
            processing: boundedCount,
            retrying: boundedCount,
            failed: boundedCount,
            deadLetter: boundedCount,
            completed: boundedCount,
            cancelled: boundedCount,
            other: boundedCount,
        })
        .nullable(),
    dueNow: boundedCount.nullable(),
    oldestDueAt: timestamp.nullable(),
});

const workerSchema = z.strictObject({
    task: workerTaskIdSchema,
    freshness: observabilityFreshnessSchema,
    leaseState: z.enum(['active', 'inactive', 'no_record']),
    leaseExpiresAt: timestamp.nullable(),
    lastOutcome: workerRunObservationSchema.shape.outcome.nullable(),
    lastFinishedAt: timestamp.nullable(),
    lastDurationMs: boundedDuration.nullable(),
    failuresLastHour: boundedCount,
});

const providerSchema = z.strictObject({
    service: providerServiceSchema,
    freshness: observabilityFreshnessSchema,
    lastOutcome: providerObservationSchema.shape.outcome.nullable(),
    lastObservedAt: timestamp.nullable(),
    sampleCount: boundedCount,
    success: boundedCount,
    providerError: boundedCount,
    timeout: boundedCount,
    cancelled: boundedCount,
    boundaryRejected: boundedCount,
    unavailable: boundedCount,
    averageDurationMs: boundedDuration.nullable(),
});

export const adminObservabilitySchema = z
    .strictObject({
        schemaVersion: z.literal(1),
        generatedAt: timestamp,
        completeness: z.enum(['complete', 'partial']),
        host: hostSchema,
        database: databaseSchema,
        queue: queueSchema,
        workers: z.array(workerSchema).length(workerTaskIdSchema.options.length),
        providers: z.strictObject({
            windowSeconds: z.literal(3_600),
            services: z.array(providerSchema).length(providerServiceSchema.options.length),
        }),
    })
    .superRefine((value, context) => {
        if (!uniqueBy(value.workers, (item) => item.task))
            context.addIssue({ code: 'custom', path: ['workers'], message: 'Duplicate worker task' });
        if (!uniqueBy(value.providers.services, (item) => item.service))
            context.addIssue({
                code: 'custom',
                path: ['providers', 'services'],
                message: 'Duplicate provider service',
            });
    });
export type AdminObservability = z.infer<typeof adminObservabilitySchema>;
