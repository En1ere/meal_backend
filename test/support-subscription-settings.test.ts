import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import {
    DatabaseConnection,
    DummyDriver,
    Kysely,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type CompiledQuery,
    type QueryResult,
} from 'kysely';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../src/infrastructure/database/schema.generated.js';
import type { Principal } from '../src/modules/auth/auth.service.js';
import { AdminGovernanceService } from '../src/modules/admin-governance/admin-governance.service.js';
import { canApplyPreviewedRollbackItem } from '../src/modules/admin-review/admin-review.service.js';
import { ContentReleasesService } from '../src/modules/content-releases/content-releases.service.js';
import { ExportsService } from '../src/modules/exports/exports.service.js';
import { SubscriptionSettingsService } from '../src/modules/subscription-settings/subscription-settings.service.js';
import { SupportService } from '../src/modules/support/support.service.js';

const userId = '10000000-0000-4000-8000-000000000001';

function harness(options: { banned?: boolean; replay?: boolean } = {}) {
    const queries: CompiledQuery[] = [];
    class Driver extends DummyDriver {
        override async acquireConnection(): Promise<DatabaseConnection> {
            await Promise.resolve();
            return {
                async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
                    await Promise.resolve();
                    queries.push(query);
                    let rows: unknown[] = [];
                    if (query.sql.includes('from meal.sanctions')) rows = options.banned ? [{ id: userId }] : [];
                    else if (query.sql.includes('from "idempotency_records"') && options.replay)
                        rows = [{ request_hash: 'unused', response_snapshot: { status: 'draft' } }];
                    else if (query.sql.includes('from "users"'))
                        rows = [{ id: userId, version: '1', status: 'active', archived_at: null }];
                    else if (query.sql.includes('count(*)')) rows = [{ total: 37 }];
                    else if (query.sql.includes('from "support_tickets"'))
                        rows = [
                            {
                                id: '20000000-0000-4000-8000-000000000001',
                                public_number: 'MP-1',
                                category: 'payments',
                                status: 'open',
                                subject: 'Первое обращение',
                                created_at: new Date('2026-10-01T10:00:00.000Z'),
                                closed_at: null,
                                version: '1',
                            },
                            {
                                id: '20000000-0000-4000-8000-000000000002',
                                public_number: 'MP-2',
                                category: 'payments',
                                status: 'waiting_for_support',
                                subject: 'Второе обращение',
                                created_at: new Date('2026-09-30T10:00:00.000Z'),
                                closed_at: null,
                                version: '1',
                            },
                        ];
                    return { rows: rows as R[] };
                },
                async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
                    await Promise.resolve();
                    throw new Error('Not used');
                },
            };
        }
    }
    const db = new Kysely<DatabaseSchema>({
        dialect: {
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => new Driver(),
            createIntrospector: (database) => new PostgresIntrospector(database),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    const database = {
        db,
        ready: () => Promise.resolve(true),
        transaction: <T>(run: (tx: unknown) => Promise<T>) => db.transaction().execute(run),
    } as unknown as DatabaseService;
    return { db, database, queries };
}

void test('support list reports the full filtered total instead of the current page length', async () => {
    const { db, database, queries } = harness();
    const result = await new SupportService(database).list(userId, {
        category: 'payments',
        status: 'active',
        limit: 2,
        offset: 10,
    });
    assert.equal(result.items.length, 2);
    assert.equal(result.total, 37);
    const list = queries.find((query) => query.sql.includes('order by'))!;
    const count = queries.find((query) => query.sql.includes('count(*)'))!;
    for (const query of [list, count]) {
        assert.match(query.sql, /"requester_id" = \$1/);
        assert.match(query.sql, /"category" = \$2/);
        assert.match(query.sql, /"status" != \$3/);
    }
    assert.match(list.sql, /limit \$4 offset \$5/);
    assert.doesNotMatch(count.sql, /limit|offset/);
    await db.destroy();
});

void test('account sanction blocks subscription mutation before idempotent replay', async () => {
    const { db, database, queries } = harness({ banned: true });
    const service = new SubscriptionSettingsService(database, {
        resolve: () => Promise.reject(new Error('Entitlements must not be reached')),
    } as never);
    const actor: Principal = {
        id: userId,
        displayName: 'Пользователь',
        context: 'user',
        sessionId: '30000000-0000-4000-8000-000000000001',
        expiresAt: '2026-12-01T10:00:00.000Z',
    };
    await assert.rejects(
        service.previewPlus(
            { expectedVersion: 1, period: 'month', idempotencyKey: '40000000-0000-4000-8000-000000000001' },
            actor,
        ),
        (error: unknown) => error instanceof HttpException && error.getStatus() === 403,
    );
    assert.equal(
        queries.some((query) => query.sql.includes('idempotency_records')),
        false,
    );
    await db.destroy();
});

void test('content release rollback rechecks current capability before idempotent replay', async () => {
    const { db, database, queries } = harness({ replay: true });
    let criticalChecks = 0;
    const service = new ContentReleasesService(
        database,
        {
            assertCapability: () => Promise.reject(new HttpException('Forbidden', 403)),
            assertCritical: () => {
                criticalChecks++;
                return Promise.resolve();
            },
        } as never,
        {} as never,
    );
    const actor: Principal = {
        id: userId,
        displayName: 'Администратор',
        context: 'admin',
        sessionId: '30000000-0000-4000-8000-000000000002',
        expiresAt: '2026-12-01T10:00:00.000Z',
    };
    await assert.rejects(
        service.rollback(actor, '50000000-0000-4000-8000-000000000001', {
            expectedVersion: 2,
            idempotencyKey: '60000000-0000-4000-8000-000000000001',
        }),
        (error: unknown) => error instanceof HttpException && error.getStatus() === 403,
    );
    assert.equal(criticalChecks, 0);
    assert.equal(
        queries.some((query) => query.sql.includes('idempotency_records')),
        false,
    );
    await db.destroy();
});

void test('generic rollback applies only items that were ready in the accepted preview and remain ready', () => {
    const previewed = new Set(['ready']);
    assert.equal(
        canApplyPreviewedRollbackItem(previewed, { id: 'ready', status: 'pending' }, { supported: true, ready: true }),
        true,
    );
    assert.equal(
        canApplyPreviewedRollbackItem(previewed, { id: 'ready', status: 'pending' }, { supported: true, ready: false }),
        false,
    );
    assert.equal(
        canApplyPreviewedRollbackItem(
            previewed,
            { id: 'previously-conflicted', status: 'pending' },
            { supported: true, ready: true },
        ),
        false,
    );
});

void test('export worker claimed count excludes queue rows lost to another worker', async () => {
    const queries: CompiledQuery[] = [];
    class ExportDriver extends DummyDriver {
        override async acquireConnection(): Promise<DatabaseConnection> {
            await Promise.resolve();
            return {
                async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
                    await Promise.resolve();
                    queries.push(query);
                    const rows = query.sql.startsWith('select id from meal.export_jobs')
                        ? [
                              { id: '70000000-0000-4000-8000-000000000001' },
                              { id: '70000000-0000-4000-8000-000000000002' },
                          ]
                        : [];
                    return { rows: rows as R[] };
                },
                async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
                    await Promise.resolve();
                    throw new Error('Not used');
                },
            };
        }
    }
    const db = new Kysely<DatabaseSchema>({
        dialect: {
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => new ExportDriver(),
            createIntrospector: (database) => new PostgresIntrospector(database),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    const database = {
        db,
        ready: () => Promise.resolve(true),
        transaction: <T>(run: (tx: unknown) => Promise<T>) => db.transaction().execute(run),
    } as unknown as DatabaseService;
    const result = await new ExportsService(database, {} as never, {} as never).runNext(2);
    assert.deepEqual(result, { claimed: 0, failedClosed: 0 });
    assert.equal(
        queries.filter((query) => query.sql.includes("set status='processing'")).length,
        2,
        queries.map((query) => query.sql).join('\n---\n'),
    );
    await db.destroy();
});

void test('achievement publication metrics count one current revision per recipe', async () => {
    const queries: CompiledQuery[] = [];
    class AchievementDriver extends DummyDriver {
        override async acquireConnection(): Promise<DatabaseConnection> {
            await Promise.resolve();
            return {
                async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
                    await Promise.resolve();
                    queries.push(query);
                    const rows = query.sql.includes('from meal.achievement_rules')
                        ? [
                              {
                                  id: '80000000-0000-4000-8000-000000000001',
                                  code: 'first-recipe',
                                  condition: { metric: 'publishedCount', operator: 'gte', threshold: 1 },
                              },
                          ]
                        : query.sql.includes('with cooked as')
                          ? [{ publishedCount: 0 }]
                          : [];
                    return { rows: rows as R[] };
                },
                async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
                    await Promise.resolve();
                    throw new Error('Not used');
                },
            };
        }
    }
    const db = new Kysely<DatabaseSchema>({
        dialect: {
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => new AchievementDriver(),
            createIntrospector: (database) => new PostgresIntrospector(database),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    const service = new ContentReleasesService({} as DatabaseService, {} as never, {} as never);
    await service.evaluateAchievementsIn(db as never, userId);
    const metrics = queries.find((query) => query.sql.includes('with cooked as'))!;
    assert.match(metrics.sql, /published as \(\s*select distinct on\(r\.id\)/);
    assert.match(metrics.sql, /order by r\.id,rp\.published_at desc,rp\.id desc/);
    await db.destroy();
});

void test('scheduled sanction worker closes a revoked due effect as skipped', async () => {
    const effectId = '90000000-0000-4000-8000-000000000001';
    const queries: CompiledQuery[] = [];
    class SanctionDriver extends DummyDriver {
        override async acquireConnection(): Promise<DatabaseConnection> {
            await Promise.resolve();
            return {
                async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
                    await Promise.resolve();
                    queries.push(query);
                    const rows = query.sql.startsWith('select e.id from meal.scheduled_sanction_effects')
                        ? [{ id: effectId }]
                        : query.sql.includes('as "active"')
                          ? [
                                {
                                    id: effectId,
                                    sanctionId: '90000000-0000-4000-8000-000000000002',
                                    userId,
                                    recipientId: null,
                                    active: false,
                                },
                            ]
                          : [];
                    return { rows: rows as R[] };
                },
                async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
                    await Promise.resolve();
                    throw new Error('Not used');
                },
            };
        }
    }
    const db = new Kysely<DatabaseSchema>({
        dialect: {
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => new SanctionDriver(),
            createIntrospector: (database) => new PostgresIntrospector(database),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    const database = {
        db,
        ready: () => Promise.resolve(true),
        transaction: <T>(run: (tx: unknown) => Promise<T>) => db.transaction().execute(run),
    } as unknown as DatabaseService;
    const result = await new AdminGovernanceService(database, {} as never).activateScheduledSanctionEffects(1);
    assert.deepEqual(result, { selected: 1, applied: 0, failed: 0, skipped: 1 });
    const skipped = queries.find((query) => query.sql.startsWith('update "scheduled_sanction_effects"'))!;
    assert.ok(skipped.parameters.includes('skipped'));
    assert.ok(skipped.parameters.includes('Sanction inactive at activation'));
    await db.destroy();
});
