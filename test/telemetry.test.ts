import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { readConfig } from '../src/app/config.js';
import { createApp } from '../src/app/create-app.js';
import { browserTelemetryInputSchema } from '../src/modules/telemetry/telemetry.contracts.js';
import {
    type SafeErrorRecord,
    type SafeMetricRecord,
    type SafeTelemetryRecord,
    TelemetryRepository,
} from '../src/modules/telemetry/telemetry.repository.js';
import { operationalTelemetryCodeSchema, TelemetryService } from '../src/modules/telemetry/telemetry.service.js';

class CapturingRepository {
    readonly records: SafeTelemetryRecord[] = [];
    readonly errors: SafeErrorRecord[] = [];
    readonly metrics: SafeMetricRecord[] = [];
    insert(record: SafeTelemetryRecord): Promise<void> {
        this.records.push(record);
        return Promise.resolve();
    }
    insertError(record: SafeErrorRecord): Promise<void> {
        this.errors.push(record);
        return Promise.resolve();
    }
    insertMetrics(records: readonly SafeMetricRecord[]): Promise<void> {
        this.metrics.push(...records);
        return Promise.resolve();
    }
}

void test('browser telemetry accepts only fixed low-cardinality fields', () => {
    const valid = { application: 'front', code: 'route_error', appVersion: '0.0.82' };
    assert.equal(browserTelemetryInputSchema.safeParse(valid).success, true);
    for (const extra of [
        { message: 'private text' },
        { stack: 'secret stack' },
        { path: '/users/private' },
        { query: 'email=private@example.test' },
        { body: { password: 'secret' } },
        { token: 'secret' },
        { userId: crypto.randomUUID() },
    ]) {
        assert.equal(browserTelemetryInputSchema.safeParse({ ...valid, ...extra }).success, false);
    }
    assert.equal(operationalTelemetryCodeSchema.safeParse('arbitrary.failure').success, false);
});

void test('telemetry maps browser and backend events to fixed sanitized records', async () => {
    const repository = new CapturingRepository();
    const service = new TelemetryService(
        readConfig({ NODE_ENV: 'test', APP_VERSION: '0.0.78' }),
        repository as unknown as TelemetryRepository,
    );
    await service.recordBrowser({ application: 'admin', code: 'root_error', appVersion: '0.0.76' }, 'admin');
    await service.recordOperational('backend.http.unhandled', { requestId: crypto.randomUUID() });
    assert.equal(repository.records.length, 2);
    assert.deepEqual(
        repository.records.map(({ code, message, source, appVersion }) => ({ code, message, source, appVersion })),
        [
            {
                code: 'browser.admin.root_error',
                message: 'Browser root boundary reported an error',
                source: 'frontend',
                appVersion: '0.0.76',
            },
            {
                code: 'backend.http.unhandled',
                message: 'Backend request failed unexpectedly',
                source: 'backend',
                appVersion: '0.0.78',
            },
        ],
    );
    assert.equal(JSON.stringify(repository.records).includes('private'), false);
});

void test('telemetry failure is swallowed and application identity cannot cross endpoints', async () => {
    const repository = {
        insert: () => Promise.reject(new Error('database unavailable with private detail')),
        insertError: () => Promise.reject(new Error('database unavailable with private detail')),
        insertMetrics: () => Promise.reject(new Error('database unavailable with private detail')),
    };
    const service = new TelemetryService(
        readConfig({ NODE_ENV: 'test' }),
        repository as unknown as TelemetryRepository,
    );
    await assert.doesNotReject(service.recordOperational('database.idle_connection.failed'));
    await assert.rejects(
        service.recordBrowser({ application: 'admin', code: 'route_error', appVersion: null }, 'front'),
    );
});

void test('provider and worker telemetry stores only fixed dimensions and aggregate counters', async () => {
    const repository = new CapturingRepository();
    const service = new TelemetryService(
        readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://meal_app:test@localhost/meal_planner_postgres' }),
        repository as unknown as TelemetryRepository,
    );
    await service.recordProvider({
        service: 'email',
        provider: 'vendor-private-alias',
        operation: 'send-private-template',
        outcome: 'provider_error',
        errorKind: 'provider_internal',
        durationMs: 42,
        attempt: 1,
        occurredAt: '2026-10-12T10:00:00.000Z',
    });
    await service.recordWorker({
        topologyVersion: 1,
        task: 'exports',
        executionMode: 'external_one_shot',
        outcome: 'partial',
        failureKind: 'dependency',
        startedAt: '2026-10-12T10:00:00.000Z',
        finishedAt: '2026-10-12T10:00:00.050Z',
        durationMs: 50,
        attempted: 3,
        succeeded: 1,
        deferred: 1,
        failed: 1,
    });
    await service.recordWorkerAlert({
        task: 'exports',
        severity: 'warning',
        reason: 'run_failed',
        failureKind: 'dependency',
        dedupKey: 'worker:exports:failures',
        occurredAt: '2026-10-12T10:00:00.050Z',
    });

    assert.equal(service.status().configured, true);
    assert.deepEqual(
        repository.errors.map(({ code, message, source }) => ({ code, message, source })),
        [
            {
                code: 'provider.email.provider_error',
                message: 'External provider operation did not complete successfully',
                source: 'backend',
            },
            { code: 'worker.exports.run_failed', message: 'Background worker run failed', source: 'worker' },
        ],
    );
    assert.deepEqual(
        repository.metrics.map(({ name, value, unit }) => ({ name, value, unit })),
        [
            { name: 'provider.email.provider_error.count', value: 1, unit: 'count' },
            { name: 'provider.email.provider_error.duration', value: 42, unit: 'milliseconds' },
            { name: 'worker.exports.partial.count', value: 1, unit: 'count' },
            { name: 'worker.exports.duration', value: 50, unit: 'milliseconds' },
            { name: 'worker.exports.attempted', value: 3, unit: 'count' },
            { name: 'worker.exports.succeeded', value: 1, unit: 'count' },
            { name: 'worker.exports.deferred', value: 1, unit: 'count' },
            { name: 'worker.exports.failed', value: 1, unit: 'count' },
        ],
    );
    assert.equal(JSON.stringify({ errors: repository.errors, metrics: repository.metrics }).includes('private'), false);
});

void test('front and admin telemetry endpoints require their own CSRF origin and remain accepted without a database', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config);
    try {
        const cases = [
            {
                csrfUrl: '/api/v1/auth/csrf',
                ingestUrl: '/api/v1/telemetry/browser',
                origin: config.FRONTEND_ORIGIN,
                application: 'front',
            },
            {
                csrfUrl: '/api/v1/admin/auth/csrf',
                ingestUrl: '/api/v1/admin/telemetry/browser',
                origin: config.ADMIN_FRONTEND_ORIGIN!,
                application: 'admin',
            },
        ] as const;
        for (const item of cases) {
            const nonce = await app.inject({ method: 'GET', url: item.csrfUrl, headers: { origin: item.origin } });
            const cookie = nonce.cookies.map((value) => `${value.name}=${value.value}`).join('; ');
            const token = nonce.json<{ data: { token: string } }>().data.token;
            const response = await app.inject({
                method: 'POST',
                url: item.ingestUrl,
                headers: { origin: item.origin, cookie, 'x-csrf-token': token },
                payload: { application: item.application, code: 'unhandled_error', appVersion: null },
            });
            assert.equal(response.statusCode, 202, response.body);
            assert.deepEqual(response.json<{ data: unknown }>().data, { accepted: true });
        }
    } finally {
        await app.close();
    }
});

void test('telemetry ingestion has a dedicated body limit and per-route rate limit', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config);
    try {
        const nonce = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
        const cookie = nonce.cookies.map((value) => `${value.name}=${value.value}`).join('; ');
        const token = nonce.json<{ data: { token: string } }>().data.token;
        const headers = {
            origin: config.FRONTEND_ORIGIN,
            cookie,
            'x-csrf-token': token,
            'content-type': 'application/json',
        };
        const oversized = await app.inject({
            method: 'POST',
            url: '/api/v1/telemetry/browser',
            remoteAddress: '198.51.100.20',
            headers,
            payload: JSON.stringify({
                application: 'front',
                code: 'route_error',
                appVersion: null,
                padding: 'x'.repeat(2_000),
            }),
        });
        assert.equal(oversized.statusCode, 413);
        for (let index = 0; index < 20; index++) {
            const response = await app.inject({
                method: 'POST',
                url: '/api/v1/telemetry/browser',
                remoteAddress: '198.51.100.21',
                headers,
                payload: { application: 'front', code: 'route_error', appVersion: null },
            });
            assert.equal(response.statusCode, 202, response.body);
        }
        const limited = await app.inject({
            method: 'POST',
            url: '/api/v1/telemetry/browser',
            remoteAddress: '198.51.100.21',
            headers,
            payload: { application: 'front', code: 'route_error', appVersion: null },
        });
        assert.equal(limited.statusCode, 429);
    } finally {
        await app.close();
    }
});
