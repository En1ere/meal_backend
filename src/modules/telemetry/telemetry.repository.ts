import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../infrastructure/database/database.service.js';

export type SafeTelemetryRecord = Readonly<{
    occurredAt: Date;
    source: 'frontend' | 'backend' | 'api' | 'worker';
    severity: 'error' | 'warning' | 'critical';
    environment: 'development' | 'test' | 'production';
    appVersion: string | null;
    code: string;
    message: string;
    requestId: string | null;
    metricName: string;
}>;

export type SafeMetricRecord = Readonly<{
    occurredAt: Date;
    environment: 'development' | 'test' | 'production';
    appVersion: string | null;
    name: string;
    value: number;
    unit: 'count' | 'milliseconds';
}>;

export type SafeErrorRecord = Omit<SafeTelemetryRecord, 'metricName'>;

@Injectable()
export class TelemetryRepository {
    constructor(private readonly database: DatabaseService) {}

    async insert(record: SafeTelemetryRecord): Promise<void> {
        await this.database.transaction(async (tx) => {
            await this.insertErrorWith(tx, record);
            await this.insertMetricWith(tx, {
                occurredAt: record.occurredAt,
                environment: record.environment,
                appVersion: record.appVersion,
                name: record.metricName,
                value: 1,
                unit: 'count',
            });
        });
    }

    async insertMetrics(records: readonly SafeMetricRecord[]): Promise<void> {
        if (!records.length) return;
        await this.database.transaction(async (tx) => {
            for (const record of records) await this.insertMetricWith(tx, record);
        });
    }

    async insertError(record: SafeErrorRecord): Promise<void> {
        await this.database.transaction((tx) => this.insertErrorWith(tx, record));
    }

    private async insertErrorWith(
        tx: Parameters<Parameters<DatabaseService['transaction']>[0]>[0],
        record: SafeErrorRecord,
    ): Promise<void> {
        await tx
            .insertInto('admin_error_events')
            .values({
                id: randomUUID(),
                occurred_at: record.occurredAt,
                source: record.source,
                severity: record.severity,
                environment: record.environment,
                app_version: record.appVersion,
                code: record.code,
                message: record.message,
                stack_summary: null,
                request_id: record.requestId,
                job_id: null,
                pseudonymous_id: null,
                version: '1',
            })
            .execute();
    }

    private async insertMetricWith(
        tx: Parameters<Parameters<DatabaseService['transaction']>[0]>[0],
        record: SafeMetricRecord,
    ): Promise<void> {
        await tx
            .insertInto('admin_metric_events')
            .values({
                id: randomUUID(),
                occurred_at: record.occurredAt,
                event_name: record.name,
                metric_value: String(record.value),
                unit: record.unit,
                environment: record.environment,
                app_version: record.appVersion,
                plan_code: null,
                feature_flag: null,
                version: '1',
            })
            .execute();
    }
}
