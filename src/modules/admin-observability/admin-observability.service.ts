import { Injectable } from '@nestjs/common';
import { AdminReadBoundary } from '../admin-auth/admin-read-boundary.service.js';
import type { Principal } from '../auth/auth.service.js';
import { workerRunObservationSchema } from '../operational-runtime/worker-runtime.js';
import { workerTaskIdSchema, workerTopology } from '../operational-runtime/worker-topology.js';
import { providerObservationSchema, providerServiceSchema } from '../provider-runtime/provider-runtime.js';
import { adminObservabilitySchema, type AdminObservability } from './admin-observability.contracts.js';
import {
    AdminObservabilityRepository,
    type ObservabilityRepositorySnapshot,
} from './admin-observability.repository.js';
import { HostSnapshotReader } from './host-snapshot.reader.js';

const PROVIDER_STALE_SECONDS = 3_600;
const failureOutcomes = new Set(['partial', 'skipped_not_ready', 'timeout', 'failure']);

const number = (value: string, maximum = 1_000_000_000) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error('Invalid aggregate');
    return parsed;
};
const freshness = (observedAt: Date | null, staleAfterSeconds: number, now: Date) => {
    if (!observedAt)
        return {
            state: 'no_samples' as const,
            observedAt: null,
            ageSeconds: null,
            staleAfterSeconds,
        };
    const ageSeconds = Math.max(0, Math.floor((now.getTime() - observedAt.getTime()) / 1_000));
    return {
        state: ageSeconds <= staleAfterSeconds ? ('fresh' as const) : ('stale' as const),
        observedAt: observedAt.toISOString(),
        ageSeconds,
        staleAfterSeconds,
    };
};
const databaseFreshness = (now: Date) => ({
    state: 'fresh' as const,
    observedAt: now.toISOString(),
    ageSeconds: 0,
    staleAfterSeconds: 30,
});

@Injectable()
export class AdminObservabilityService {
    constructor(
        private readonly boundary: AdminReadBoundary,
        private readonly repository: AdminObservabilityRepository,
        private readonly host: HostSnapshotReader,
    ) {}

    async read(actor: Principal, requestId: string, now = new Date()): Promise<AdminObservability> {
        const host = await this.host.read(now.getTime());
        return this.boundary.run(
            actor,
            requestId,
            { action: 'admin.observability.read', targetType: 'observability' },
            async (tx) => this.project(host, await this.repository.read(tx, now), now),
        );
    }

    private project(
        host: AdminObservability['host'],
        snapshot: ObservabilityRepositorySnapshot,
        now: Date,
    ): AdminObservability {
        return adminObservabilitySchema.parse({
            schemaVersion: 1,
            generatedAt: now.toISOString(),
            completeness: host.freshness.state === 'fresh' && host.collectorStatus === 'ok' ? 'complete' : 'partial',
            host,
            database: {
                freshness: databaseFreshness(now),
                queryDurationMs: snapshot.database.queryDurationMs,
                schemaVersion: snapshot.database.schemaVersion,
                databaseSizeBytes: snapshot.database.databaseSizeBytes,
                backendPool: snapshot.database.pool,
            },
            queue: {
                freshness: databaseFreshness(now),
                counts: snapshot.queue.counts,
                dueNow: snapshot.queue.dueNow,
                oldestDueAt: snapshot.queue.oldestDueAt?.toISOString() ?? null,
            },
            workers: this.workers(snapshot, now),
            providers: { windowSeconds: 3_600, services: this.providers(snapshot, now) },
        });
    }

    private workers(snapshot: ObservabilityRepositorySnapshot, now: Date) {
        const topology = workerTopology();
        return workerTaskIdSchema.options.map((task) => {
            const observations = snapshot.workerCounts.flatMap((row) => {
                const match = /^worker\.([a-z0-9-]+)\.([a-z_]+)\.count$/.exec(row.event_name);
                if (
                    !match ||
                    match[1] !== task ||
                    !workerRunObservationSchema.shape.outcome.safeParse(match[2]).success
                )
                    return [];
                return [{ outcome: match[2]!, count: number(row.value), observedAt: row.observed_at }];
            });
            const latest = observations.reduce<(typeof observations)[number] | null>(
                (current, value) => (!current || value.observedAt > current.observedAt ? value : current),
                null,
            );
            const duration = snapshot.workerDurations.find((row) => row.event_name === `worker.${task}.duration`);
            const lease = snapshot.leases.find((row) => row.task === task);
            const policy = topology.tasks.find((value) => value.id === task)!;
            const staleAfterSeconds = Math.max(300, policy.minimumIntervalSeconds * 2 + policy.timeoutSeconds + 30);
            return {
                task,
                freshness: freshness(latest?.observedAt ?? null, staleAfterSeconds, now),
                leaseState: lease
                    ? lease.expiresAt > now
                        ? ('active' as const)
                        : ('inactive' as const)
                    : ('no_record' as const),
                leaseExpiresAt: lease?.expiresAt.toISOString() ?? null,
                lastOutcome: latest?.outcome ?? null,
                lastFinishedAt: latest?.observedAt.toISOString() ?? null,
                lastDurationMs: duration ? number(duration.value, 86_400_000) : null,
                failuresLastHour: observations
                    .filter((value) => failureOutcomes.has(value.outcome))
                    .reduce((total, value) => total + value.count, 0),
            };
        });
    }

    private providers(snapshot: ObservabilityRepositorySnapshot, now: Date) {
        return providerServiceSchema.options.map((service) => {
            const observations = snapshot.providerCounts.flatMap((row) => {
                const match = /^provider\.([a-z_]+)\.([a-z_]+)\.count$/.exec(row.event_name);
                if (
                    !match ||
                    match[1] !== service ||
                    !providerObservationSchema.shape.outcome.safeParse(match[2]).success
                )
                    return [];
                return [{ outcome: match[2]!, count: number(row.value), observedAt: row.observed_at }];
            });
            const latest = observations.reduce<(typeof observations)[number] | null>(
                (current, value) => (!current || value.observedAt > current.observedAt ? value : current),
                null,
            );
            const counts = (outcome: string) =>
                observations.filter((value) => value.outcome === outcome).reduce((sum, value) => sum + value.count, 0);
            const duration = snapshot.providerDurations.find(
                (row) => row.event_name === `provider.${service}.duration`,
            );
            return {
                service,
                freshness: freshness(latest?.observedAt ?? null, PROVIDER_STALE_SECONDS, now),
                lastOutcome: latest?.outcome ?? null,
                lastObservedAt: latest?.observedAt.toISOString() ?? null,
                sampleCount: observations.reduce((sum, value) => sum + value.count, 0),
                success: counts('success'),
                providerError: counts('provider_error'),
                timeout: counts('timeout'),
                cancelled: counts('cancelled'),
                boundaryRejected: counts('boundary_rejected'),
                unavailable: counts('unavailable'),
                averageDurationMs: duration ? number(duration.value, 86_400_000) : null,
            };
        });
    }
}
