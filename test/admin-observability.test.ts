import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { createApp } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';
import { AdminAccessService } from '../src/modules/admin-auth/admin-access.service.js';
import { AdminReadBoundary } from '../src/modules/admin-auth/admin-read-boundary.service.js';
import {
    adminObservabilitySchema,
    hostCollectorSnapshotSchema,
    observabilityContainerServiceSchema,
    observabilityFilesystemScopeSchema,
} from '../src/modules/admin-observability/admin-observability.contracts.js';
import { AdminObservabilityService } from '../src/modules/admin-observability/admin-observability.service.js';
import {
    AdminObservabilityRepository,
    observabilityMetricAllowlist,
    type ObservabilityRepositorySnapshot,
} from '../src/modules/admin-observability/admin-observability.repository.js';
import {
    HostSnapshotReader,
    isSafeSnapshotDirectory,
    parseHostSnapshot,
} from '../src/modules/admin-observability/host-snapshot.reader.js';
import { AuthService, type Principal } from '../src/modules/auth/auth.service.js';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { providerServiceSchema } from '../src/modules/provider-runtime/provider-runtime.js';
import { workerTaskIdSchema } from '../src/modules/operational-runtime/worker-topology.js';

const now = new Date('2026-10-29T10:00:00.000Z');
const actor: Principal = {
    id: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    displayName: 'Admin',
    context: 'admin',
    expiresAt: '2030-01-01T00:00:00.000Z',
};
const container = (service: (typeof observabilityContainerServiceSchema.options)[number]) => ({
    service,
    state: 'running' as const,
    health: 'healthy' as const,
    restartCount: 0,
    cpuPermille: 1,
    memoryBytes: 1024,
    memoryLimitBytes: 2048,
    pids: 2,
});
const hostFixture = (collectedAt = now.toISOString()) => ({
    schemaVersion: 1 as const,
    collectedAt,
    collectorStatus: 'ok' as const,
    durationMs: 10,
    host: {
        memoryTotalBytes: 4096,
        memoryAvailableBytes: 2048,
        load1mMilli: 12,
        uptimeSeconds: 60,
        rebootRequired: false,
        filesystems: observabilityFilesystemScopeSchema.options.map((scope) => ({
            scope,
            totalBytes: 10_000,
            availableBytes: 5_000,
            usedPercent: 50,
        })),
    },
    containers: observabilityContainerServiceSchema.options.map(container),
});
const parseFixture = (value: unknown, overrides: Partial<Parameters<typeof parseHostSnapshot>[1]> = {}) => {
    const raw = JSON.stringify(value);
    return parseHostSnapshot(
        raw,
        {
            regularFile: true,
            uid: 0,
            gid: 29_002,
            mode: 0o100640,
            size: Buffer.byteLength(raw),
            mtimeMs: now.getTime(),
            ...overrides,
        },
        now.getTime(),
    );
};

void test('host snapshot reader accepts only strict root-owned bounded fixed-cardinality snapshots', () => {
    assert.equal(hostCollectorSnapshotSchema.parse(hostFixture()).containers.length, 5);
    assert.equal(parseFixture(hostFixture()).freshness.state, 'fresh');
    assert.equal(parseFixture({ ...hostFixture(), extra: true }).unavailableReason, 'invalid');
    assert.equal(parseFixture(hostFixture(), { uid: 1000 }).unavailableReason, 'invalid');
    assert.equal(parseFixture(hostFixture(), { gid: 1000 }).unavailableReason, 'invalid');
    assert.equal(parseFixture(hostFixture(), { mode: 0o100440 }).unavailableReason, 'invalid');
    assert.equal(parseFixture(hostFixture(), { mode: 0o100660 }).unavailableReason, 'invalid');
    assert.equal(parseFixture(hostFixture(), { regularFile: false }).unavailableReason, 'invalid');
    assert.equal(parseFixture(hostFixture(), { size: 65_537 }).unavailableReason, 'invalid');
    const duplicate = hostFixture();
    duplicate.containers[1] = duplicate.containers[0]!;
    assert.equal(parseFixture(duplicate).unavailableReason, 'invalid');
    assert.equal(parseFixture(hostFixture('2026-10-29T10:01:00.000Z')).unavailableReason, 'clock_skew');
    assert.equal(
        parseFixture(hostFixture('2026-10-29T09:55:00.000Z'), { mtimeMs: now.getTime() - 300_000 }).freshness.state,
        'stale',
    );
    const ancient = parseFixture(hostFixture('2020-01-01T00:00:00.000Z'), {
        mtimeMs: Date.parse('2020-01-01T00:00:00Z'),
    });
    assert.equal(ancient.freshness.state, 'stale');
    assert.equal(ancient.freshness.ageSeconds, 31_536_000);
});

void test('snapshot parent directory requires exact root group and setgid permissions', () => {
    const valid = { directory: true, uid: 0, gid: 29_002, mode: 0o42750 };
    assert.equal(isSafeSnapshotDirectory(valid), true);
    for (const invalid of [
        { ...valid, directory: false },
        { ...valid, uid: 1000 },
        { ...valid, gid: 1000 },
        { ...valid, mode: 0o40750 },
        { ...valid, mode: 0o42770 },
    ])
        assert.equal(isSafeSnapshotDirectory(invalid), false);
});

void test('disabled host reader is explicit and leaks no configured path', async () => {
    const result = await new HostSnapshotReader(undefined).read(now.getTime());
    assert.equal(result.unavailableReason, 'disabled');
    assert.equal(JSON.stringify(result).includes('/'), false);
});

void test('host snapshot configuration is fail-closed and production path is fixed', () => {
    assert.throws(() => readConfig({ NODE_ENV: 'test', OBSERVABILITY_HOST_SNAPSHOT_ENABLED: 'true' }), /requires both/);
    assert.throws(
        () =>
            readConfig({
                NODE_ENV: 'test',
                OBSERVABILITY_HOST_SNAPSHOT_FILE: 'relative.json',
                OBSERVABILITY_HOST_SNAPSHOT_ENABLED: 'true',
            }),
        /approved absolute path/,
    );
    const production = {
        NODE_ENV: 'production',
        FRONTEND_ORIGIN: 'https://app.example.test',
        DATABASE_URL: 'postgres://meal_runtime:unused@127.0.0.1:5432/meal_planner_postgres',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        OBSERVABILITY_HOST_SNAPSHOT_ENABLED: 'true',
    };
    assert.throws(
        () => readConfig({ ...production, OBSERVABILITY_HOST_SNAPSHOT_FILE: '/tmp/current.json' }),
        /approved absolute path/,
    );
    assert.equal(
        readConfig({ ...production, OBSERVABILITY_HOST_SNAPSHOT_FILE: '/run/meal-observability/current.json' })
            .OBSERVABILITY_HOST_SNAPSHOT_ENABLED,
        true,
    );
});

void test('observability metric inputs are generated only from fixed worker/provider enums', () => {
    assert.equal(observabilityMetricAllowlist.providerDurationNames.length, providerServiceSchema.options.length);
    assert.equal(observabilityMetricAllowlist.workerDurationNames.length, workerTaskIdSchema.options.length);
    for (const value of Object.values(observabilityMetricAllowlist).flat()) {
        assert.match(value, /^(provider|worker)\.[a-z0-9_-]+\.(?:[a-z_]+\.count|duration)$/);
        assert.equal(value.includes('*'), false);
    }
});

void test('observability HTTP and SQL work have dedicated bounded execution limits', async () => {
    const http = await import('node:fs/promises').then((fs) =>
        fs.readFile(
            new URL('../../src/modules/admin-observability/admin-observability.http.ts', import.meta.url),
            'utf8',
        ),
    );
    const repository = await import('node:fs/promises').then((fs) =>
        fs.readFile(
            new URL('../../src/modules/admin-observability/admin-observability.repository.ts', import.meta.url),
            'utf8',
        ),
    );
    assert.match(http, /rateLimit: \{ max: 12, timeWindow: '1 minute' \}/);
    assert.match(repository, /set local statement_timeout = '2s'/);
});

void test('worker/provider projections preserve no-samples and do not count skipped overlap as a failure', async () => {
    const snapshot: ObservabilityRepositorySnapshot = {
        database: {
            schemaVersion: 30,
            databaseSizeBytes: 1,
            queryDurationMs: 1,
            pool: { max: 10, total: 1, idle: 1, waiting: 0 },
        },
        queue: {
            counts: {
                pending: 0,
                queued: 0,
                running: 0,
                processing: 0,
                retrying: 0,
                failed: 0,
                deadLetter: 0,
                completed: 0,
                cancelled: 0,
                other: 0,
            },
            dueNow: 0,
            oldestDueAt: null,
        },
        leases: [],
        providerCounts: [],
        providerDurations: [],
        workerCounts: [
            { event_name: 'worker.scheduled-news.skipped_overlap.count', value: '5', observed_at: now },
            { event_name: 'worker.scheduled-news.failure.count', value: '2', observed_at: now },
        ],
        workerDurations: [],
    };
    const host = parseFixture(hostFixture());
    const boundary = {
        run: (_actor: unknown, _id: string, _audit: unknown, work: (tx: never) => unknown) => work({} as never),
    };
    const repository = { read: () => Promise.resolve(snapshot) };
    const reader = { read: () => Promise.resolve(host) };
    const service = new AdminObservabilityService(
        boundary as unknown as AdminReadBoundary,
        repository as unknown as AdminObservabilityRepository,
        reader as unknown as HostSnapshotReader,
    );
    const result = await service.read(actor, randomUUID(), now);
    assert.equal(result.workers.find((worker) => worker.task === 'scheduled-news')?.failuresLastHour, 2);
    assert.equal(
        result.providers.services.every((provider) => provider.freshness.state === 'no_samples'),
        true,
    );
});

void test('admin read boundary rechecks live access and writes only the bounded audit event', async () => {
    const inserts: { table: string; values?: Record<string, unknown> }[] = [];
    const select = {
        innerJoin() {
            return select;
        },
        select() {
            return select;
        },
        where() {
            return select;
        },
        executeTakeFirst() {
            return Promise.resolve({ id: actor.sessionId });
        },
    };
    const tx = {
        selectFrom() {
            return select;
        },
        insertInto(table: string) {
            const entry: { table: string; values?: Record<string, unknown> } = { table };
            inserts.push(entry);
            return {
                values(values: Record<string, unknown>) {
                    entry.values = values;
                    return { execute: () => Promise.resolve() };
                },
            };
        },
    };
    const database = { transaction: (work: (value: unknown) => unknown) => work(tx) } as unknown as DatabaseService;
    const boundary = new AdminReadBoundary(database);
    assert.equal(
        await boundary.run(
            actor,
            randomUUID(),
            { action: 'admin.observability.read', targetType: 'observability' },
            () => Promise.resolve(42),
        ),
        42,
    );
    assert.deepEqual(
        inserts.map((entry) => entry.table),
        ['audit_events'],
    );
    assert.equal(inserts[0]?.values?.action, 'admin.observability.read');
    await assert.rejects(
        boundary.run(
            { ...actor, context: 'moderator' },
            randomUUID(),
            { action: 'admin.observability.read', targetType: 'observability' },
            () => Promise.resolve(0),
        ),
        UnauthorizedException,
    );
});

const publicFixture = () => ({
    schemaVersion: 1 as const,
    generatedAt: now.toISOString(),
    completeness: 'partial' as const,
    host: {
        freshness: { state: 'unavailable' as const, observedAt: null, ageSeconds: null, staleAfterSeconds: 150 },
        unavailableReason: 'disabled' as const,
        collectorStatus: null,
        durationMs: null,
        memory: null,
        load1mMilli: null,
        uptimeSeconds: null,
        rebootRequired: null,
        filesystems: [],
        containers: [],
    },
    database: {
        freshness: { state: 'fresh' as const, observedAt: now.toISOString(), ageSeconds: 0, staleAfterSeconds: 30 },
        queryDurationMs: 1,
        schemaVersion: 30,
        databaseSizeBytes: 1,
        backendPool: { max: 10, total: 1, idle: 1, waiting: 0 },
    },
    queue: {
        freshness: { state: 'fresh' as const, observedAt: now.toISOString(), ageSeconds: 0, staleAfterSeconds: 30 },
        counts: {
            pending: 0,
            queued: 0,
            running: 0,
            processing: 0,
            retrying: 0,
            failed: 0,
            deadLetter: 0,
            completed: 0,
            cancelled: 0,
            other: 0,
        },
        dueNow: 0,
        oldestDueAt: null,
    },
    workers: workerTaskIdSchema.options.map((task) => ({
        task,
        freshness: { state: 'no_samples' as const, observedAt: null, ageSeconds: null, staleAfterSeconds: 300 },
        leaseState: 'no_record' as const,
        leaseExpiresAt: null,
        lastOutcome: null,
        lastFinishedAt: null,
        lastDurationMs: null,
        failuresLastHour: 0,
    })),
    providers: {
        windowSeconds: 3_600 as const,
        services: providerServiceSchema.options.map((service) => ({
            service,
            freshness: { state: 'no_samples' as const, observedAt: null, ageSeconds: null, staleAfterSeconds: 3_600 },
            lastOutcome: null,
            lastObservedAt: null,
            sampleCount: 0,
            success: 0,
            providerError: 0,
            timeout: 0,
            cancelled: 0,
            boundaryRejected: 0,
            unavailable: 0,
            averageDurationMs: null,
        })),
    },
});

void test('admin observability HTTP route is admin-session-only, strict and no-store', async () => {
    const app = await createApp(
        readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', SECURITY_KEY: randomBytes(32).toString('base64') }),
    );
    const auth = app.get(AuthService);
    app.get(AdminAccessService).principal = (token) => auth.principal(token, 'staff');
    auth.principal = (token) => (token ? Promise.resolve(actor) : Promise.reject(new UnauthorizedException()));
    app.get(AdminObservabilityService).read = () => Promise.resolve(adminObservabilitySchema.parse(publicFixture()));
    try {
        assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/observability' })).statusCode, 401);
        const response = await app.inject({
            method: 'GET',
            url: '/api/v1/admin/observability',
            headers: { cookie: 'meal_admin=valid' },
        });
        assert.equal(response.statusCode, 200);
        assert.match(String(response.headers['cache-control']), /no-store/);
        assert.equal(adminObservabilitySchema.safeParse(response.json<{ data: unknown }>().data).success, true);
        const limited = [];
        for (let attempt = 0; attempt < 13; attempt++)
            limited.push(
                await app.inject({
                    method: 'GET',
                    url: '/api/v1/admin/observability',
                    remoteAddress: '198.18.0.44',
                    headers: { cookie: 'meal_admin=valid' },
                }),
            );
        assert.equal(limited.filter((item) => item.statusCode === 200).length, 12);
        assert.equal(limited.filter((item) => item.statusCode === 429).length, 1);
    } finally {
        await app.close();
    }
});
