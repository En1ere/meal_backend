import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../app/config.js';
import { browserTelemetryInputSchema, type BrowserTelemetryInput } from './telemetry.contracts.js';
import { TelemetryRepository, type SafeTelemetryRecord } from './telemetry.repository.js';
import { providerObservationSchema, type ProviderObservation } from '../provider-runtime/provider-runtime.js';
import {
    workerAlertSchema,
    workerRunObservationSchema,
    type WorkerAlert,
    type WorkerRunObservation,
} from '../operational-runtime/worker-runtime.js';

export const operationalTelemetryCodeSchema = z.enum([
    'backend.http.unhandled',
    'backend.startup.failed',
    'database.idle_connection.failed',
]);
export type OperationalTelemetryCode = z.infer<typeof operationalTelemetryCodeSchema>;

const browserMessages: Record<BrowserTelemetryInput['code'], string> = {
    root_error: 'Browser root boundary reported an error',
    route_error: 'Browser route boundary reported an error',
    unhandled_error: 'Browser reported an unhandled error',
    unhandled_rejection: 'Browser reported an unhandled rejection',
};

const operationalMessages: Record<OperationalTelemetryCode, string> = {
    'backend.http.unhandled': 'Backend request failed unexpectedly',
    'backend.startup.failed': 'Backend startup failed',
    'database.idle_connection.failed': 'Database idle connection failed',
};

@Injectable()
export class TelemetryService {
    constructor(
        @Inject(APP_CONFIG) private readonly config: AppConfig,
        private readonly repository: TelemetryRepository,
    ) {}

    status() {
        return {
            configured: Boolean(this.config.DATABASE_URL),
            provider: this.config.DATABASE_URL ? 'postgresql' : null,
        };
    }

    async recordBrowser(raw: unknown, expectedApplication: BrowserTelemetryInput['application']): Promise<void> {
        const input = browserTelemetryInputSchema.parse(raw);
        if (input.application !== expectedApplication) throw new BadRequestException();
        const prefix = `browser.${input.application}.${input.code}`;
        await this.bestEffort({
            occurredAt: new Date(),
            source: 'frontend',
            severity: 'error',
            environment: this.config.NODE_ENV,
            appVersion: input.appVersion,
            code: prefix,
            message: browserMessages[input.code],
            requestId: null,
            metricName: `${prefix}.count`,
        });
    }

    async recordOperational(
        codeValue: OperationalTelemetryCode,
        options: Readonly<{
            severity?: SafeTelemetryRecord['severity'];
            requestId?: string | null;
            appVersion?: string | null;
        }> = {},
    ): Promise<void> {
        const code = operationalTelemetryCodeSchema.parse(codeValue);
        await this.bestEffort({
            occurredAt: new Date(),
            source: 'backend',
            severity: options.severity ?? 'error',
            environment: this.config.NODE_ENV,
            appVersion: options.appVersion ?? this.config.APP_VERSION ?? null,
            code,
            message: operationalMessages[code],
            requestId: options.requestId ?? null,
            metricName: `${code}.count`,
        });
    }

    async recordProvider(raw: ProviderObservation): Promise<void> {
        const value = providerObservationSchema.parse(raw);
        // Provider and operation names are intentionally excluded from the metric key: adapters may be
        // configurable, while the service/outcome vocabulary is fixed and remains low-cardinality.
        const prefix = `provider.${value.service}.${value.outcome}`;
        await this.bestEffortMetrics(
            [
                { name: `${prefix}.count`, value: 1, unit: 'count' },
                { name: `${prefix}.duration`, value: value.durationMs, unit: 'milliseconds' },
            ],
            new Date(value.occurredAt),
        );
        if (value.outcome !== 'success')
            await this.bestEffortError({
                occurredAt: new Date(value.occurredAt),
                source: 'backend',
                severity: value.outcome === 'timeout' ? 'critical' : 'warning',
                environment: this.config.NODE_ENV,
                appVersion: this.config.APP_VERSION ?? null,
                code: `provider.${value.service}.${value.outcome}`,
                message: 'External provider operation did not complete successfully',
                requestId: null,
            });
    }

    async recordWorker(raw: WorkerRunObservation): Promise<void> {
        const value = workerRunObservationSchema.parse(raw);
        const prefix = `worker.${value.task}.${value.outcome}`;
        await this.bestEffortMetrics(
            [
                { name: `${prefix}.count`, value: 1, unit: 'count' },
                { name: `worker.${value.task}.duration`, value: value.durationMs, unit: 'milliseconds' },
                { name: `worker.${value.task}.attempted`, value: value.attempted, unit: 'count' },
                { name: `worker.${value.task}.succeeded`, value: value.succeeded, unit: 'count' },
                { name: `worker.${value.task}.deferred`, value: value.deferred, unit: 'count' },
                { name: `worker.${value.task}.failed`, value: value.failed, unit: 'count' },
            ],
            new Date(value.finishedAt),
        );
    }

    async recordWorkerAlert(raw: WorkerAlert): Promise<void> {
        const value = workerAlertSchema.parse(raw);
        const messages: Record<WorkerAlert['reason'], string> = {
            run_failed: 'Background worker run failed',
            run_timed_out: 'Background worker exceeded its observed deadline',
            lease_unavailable: 'Background worker lease is unavailable',
            lease_lost: 'Background worker lost its lease',
        };
        await this.bestEffortError({
            occurredAt: new Date(value.occurredAt),
            source: 'worker',
            severity: value.severity,
            environment: this.config.NODE_ENV,
            appVersion: this.config.APP_VERSION ?? null,
            code: `worker.${value.task}.${value.reason}`,
            message: messages[value.reason],
            requestId: null,
        });
    }

    private async bestEffort(record: SafeTelemetryRecord): Promise<void> {
        try {
            await this.repository.insert(record);
        } catch {
            // Telemetry uses the application database and must never alter the business outcome.
        }
    }

    private async bestEffortMetrics(
        records: readonly { name: string; value: number; unit: 'count' | 'milliseconds' }[],
        occurredAt: Date,
    ): Promise<void> {
        try {
            await this.repository.insertMetrics(
                records.map((record) => ({
                    ...record,
                    occurredAt,
                    environment: this.config.NODE_ENV,
                    appVersion: this.config.APP_VERSION ?? null,
                })),
            );
        } catch {
            // Telemetry uses the application database and must never alter the business outcome.
        }
    }

    private async bestEffortError(record: Omit<SafeTelemetryRecord, 'metricName'>): Promise<void> {
        try {
            await this.repository.insertError(record);
        } catch {
            // Telemetry uses the application database and must never alter the business outcome.
        }
    }
}
