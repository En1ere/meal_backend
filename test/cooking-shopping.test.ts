import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
    Kysely,
    DummyDriver,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type CompiledQuery,
    type DatabaseConnection,
    type QueryResult,
} from 'kysely';
import type { DatabaseSchema } from '../src/infrastructure/database/schema.generated.js';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { CookingService } from '../src/modules/cooking/cooking.service.js';
import { CookingController } from '../src/modules/cooking/cooking.http.js';
import {
    CookingAttempt,
    cookingFinalizeSchema,
    cookingProgressSchema,
} from '../src/modules/cooking/cooking.contracts.js';
import { consumedRemainder, progressAttempt, cookingReminderSchedule } from '../src/modules/cooking/cooking.domain.js';
import { ShoppingService } from '../src/modules/shopping/shopping.service.js';
import { shoppingAddSchema } from '../src/modules/shopping/shopping.contracts.js';
import type { RecipesService } from '../src/modules/recipes/recipes.service.js';

const id = '10000000-0000-4000-8000-000000000001';
const key = '20000000-0000-4000-8000-000000000001';
const date = '2026-09-29T10:00:00.000Z';
const attempt = (): CookingAttempt => ({
    id,
    recipeId: id,
    revisionId: id,
    title: 'Soup',
    servings: 2,
    status: 'active',
    version: 1,
    startedAt: date,
    completedAt: null,
    confirmedDuration: null,
    privateNote: null,
    outputBatchIds: [],
    steps: [0, 1].map((position) => ({
        position,
        text: 'Cook',
        durationSeconds: 60,
        status: 'pending',
        privateNote: null,
        timerDeadline: null,
        timerPausedSeconds: null,
    })),
});
const progress = (timer: unknown) =>
    cookingProgressSchema.parse({
        version: 1,
        idempotencyKey: key,
        occurredAt: date,
        status: 'active',
        steps: [],
        timer,
    });
void test('absolute deadline survives elapsed wall time, pause/resume and never completes steps', () => {
    const first = progressAttempt(attempt(), progress({ position: 0, action: 'start', seconds: 60 }), Date.parse(date));
    assert.equal(first.steps[0]?.timerDeadline, '2026-09-29T10:01:00.000Z');
    const paused = progressAttempt(
        first,
        { ...progress({ position: 0, action: 'pause' }), version: 2 },
        Date.parse(date) + 20000,
    );
    assert.equal(paused.steps[0]?.timerPausedSeconds, 40);
    const resumed = progressAttempt(
        paused,
        { ...progress({ position: 0, action: 'resume' }), version: 3 },
        Date.parse(date) + 100000,
    );
    assert.equal(resumed.steps[0]?.timerDeadline, '2026-09-29T10:02:20.000Z');
    assert.equal(resumed.steps[0]?.status, 'pending');
    const expired = progressAttempt(resumed, { ...progress(null), version: 4 }, Date.parse(date) + 999000);
    assert.equal(expired.steps[0]?.status, 'pending');
});
void test('one local timer replaces the previous timer; later leaves inventory alone and cancel clears timers', () => {
    const first = progressAttempt(attempt(), progress({ position: 0, action: 'start' }), Date.parse(date));
    const second = progressAttempt(
        first,
        { ...progress({ position: 1, action: 'start' }), version: 2, status: 'paused' },
        Date.parse(date),
    );
    assert.equal(second.steps[0]?.timerDeadline, null);
    assert.ok(second.steps[1]?.timerDeadline);
    const cancelled = progressAttempt(second, { ...progress(null), version: 3, status: 'cancelled' }, Date.parse(date));
    assert.ok(cancelled.steps.every((s) => s.timerDeadline === null));
});
void test('progress rejects stale, finalized, unknown and duplicate steps', () => {
    assert.throws(() => progressAttempt(attempt(), { ...progress(null), version: 2 }, 0));
    assert.throws(() => progressAttempt({ ...attempt(), status: 'failed' }, progress(null), 0));
    assert.throws(() =>
        progressAttempt(
            attempt(),
            { ...progress(null), steps: [{ position: 8, status: 'skipped', privateNote: null }] },
            0,
        ),
    );
    assert.throws(() => progressAttempt(attempt(), progress({ position: 0, action: 'start', seconds: -1 }), 0));
});
void test('actual consumption exact decimals, unknown inventory and overdrafts', () => {
    assert.equal(consumedRemainder('0.3', '0.1'), '0.2');
    assert.equal(consumedRemainder('0.00000001', '0.00000001'), '0');
    assert.throws(() => consumedRemainder(null, '1'));
    assert.throws(() => consumedRemainder('1', '2'));
});
const finish = () =>
    cookingFinalizeSchema.parse({
        version: 1,
        idempotencyKey: key,
        outcome: 'failed',
        confirmedDuration: 60,
        privateNote: null,
        inputs: [{ batchId: id, version: 1, quantity: '0.1' }],
        outputs: [],
    });
void test('finalization validates duplicate sources and prohibits failed outputs', () => {
    const input = finish();
    assert.equal(
        cookingFinalizeSchema.safeParse({ ...input, inputs: [...input.inputs, ...input.inputs] }).success,
        false,
    );
    assert.equal(cookingFinalizeSchema.safeParse({ ...input, outcome: 'completed' }).success, false);
    assert.equal(shoppingAddSchema.safeParse({ version: 1, idempotencyKey: key, items: [] }).success, false);
});

function harness(
    options: {
        banned?: boolean;
        replay?: boolean;
        wrongVersion?: boolean;
        foreign?: boolean;
        statisticsCount?: number;
        shopping?: boolean;
        shoppingReference?: string | null;
    } = {},
) {
    const queries: CompiledQuery[] = [];
    let finalized = false;
    class Driver extends DummyDriver {
        override async acquireConnection(): Promise<DatabaseConnection> {
            await Promise.resolve();
            return {
                async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
                    await Promise.resolve();
                    queries.push(query);
                    const s = query.sql;
                    let rows: unknown[] = [];
                    if (s.startsWith('select id from meal.users')) rows = [{ id }];
                    else if (s.includes('from meal.sanctions')) rows = options.banned ? [{ id }] : [];
                    else if (s.includes('from meal.data_scopes')) rows = [{ id }];
                    else if (options.shopping && s.includes('from meal.shopping_lists l join meal.data_scopes'))
                        rows = [
                            {
                                id,
                                title: 'List',
                                version: 1,
                                status: 'active',
                                createdAt: new Date(date),
                                scope: 'private',
                            },
                        ];
                    else if (options.shopping && s.startsWith('select version::integer,ingredient_id,product_id'))
                        rows = [{ version: 1, ingredient_id: options.shoppingReference ?? null, product_id: null }];
                    else if (s.includes('from meal.idempotency_records') && options.replay)
                        rows = [
                            {
                                request_hash: createHash('sha256').update(JSON.stringify(finish())).digest('hex'),
                                response_snapshot: { ...attempt(), status: 'failed' },
                            },
                        ];
                    else if (s.includes('from meal.cooking_attempts where id='))
                        rows = options.foreign
                            ? []
                            : [
                                  {
                                      id,
                                      status: finalized ? 'failed' : 'active',
                                      version: finalized ? 2 : 1,
                                      started_at: new Date(date),
                                      completed_at: finalized ? new Date(date) : null,
                                      recipe_snapshot: attempt(),
                                      confirmed_duration: null,
                                      private_note: null,
                                      output_snapshot: null,
                                  },
                              ];
                    else if (s.includes('from meal.cooking_steps') && !s.includes('percentile_cont')) rows = [];
                    else if (s.startsWith('with published') && !s.includes('where p.base_recipe_id'))
                        rows = [
                            {
                                id,
                                revisionId: id,
                                title: 'Soup',
                                description: null,
                                imageUrl: null,
                                category: null,
                                tags: [],
                                baseServings: 2,
                                publishedAt: new Date(date),
                                timing: {},
                                authorLogin: null,
                                rating: null,
                                ratingCount: 0,
                                method: 'pot',
                                nutrition_snapshot: null,
                            },
                        ];
                    else if (s.includes('percentile_cont'))
                        rows = [
                            {
                                sampleSize: options.statisticsCount ?? 0,
                                medianSeconds: 90,
                                lowerQuartileSeconds: 60,
                                upperQuartileSeconds: 120,
                            },
                        ];
                    else if (s.includes('from meal.inventory_batches b join meal.units'))
                        rows = [
                            {
                                id,
                                name: 'Stock',
                                quantity: '1',
                                version: options.wrongVersion ? 2 : 1,
                                unit_id: id,
                                precision: 'exact',
                                composition_id: null,
                            },
                        ];
                    else if (s.startsWith('update meal.cooking_attempts set status=')) finalized = true;
                    return { rows: rows as R[] };
                },
                async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
                    await Promise.resolve();
                    throw Error('Unused');
                },
            };
        }
    }
    const db = new Kysely<DatabaseSchema>({
        dialect: {
            createDriver: () => new Driver(),
            createAdapter: () => new PostgresAdapter(),
            createIntrospector: (db) => new PostgresIntrospector(db),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    const database = {
        db,
        ready: () => Promise.resolve(true),
        transaction: <T>(run: (tx: unknown) => Promise<T>) => db.transaction().execute(run),
    } as unknown as DatabaseService;
    return {
        db,
        queries,
        service: new CookingService(database, undefined, undefined, undefined, {
            detail: () =>
                Promise.resolve({
                    recipe: {
                        id,
                        revisionId: id,
                        method: 'pot',
                    },
                }),
        } as unknown as RecipesService),
        shopping: new ShoppingService(
            database,
            {} as RecipesService,
            {
                resolveFamily: () => Promise.resolve({ capabilities: { family: true } }),
            } as never,
        ),
    };
}
void test('failed attempt atomically writes actual consumption evidence and no available output', async () => {
    const h = harness();
    try {
        const result = await h.service.finalize(id, id, finish());
        assert.equal(result.status, 'failed');
        assert.ok(h.queries.some((q) => q.sql.startsWith('insert into meal.cooking_inputs')));
        assert.ok(h.queries.some((q) => q.sql.startsWith('insert into meal.inventory_movements')));
        assert.equal(
            h.queries.some((q) => q.sql.startsWith('insert into meal.cooking_outputs')),
            false,
        );
        assert.ok(
            h.queries
                .filter((q) => q.sql.startsWith('update meal.inventory_batches'))
                .every((q) => q.sql.includes('scope_id=') && q.sql.includes('version=')),
        );
    } finally {
        await h.db.destroy();
    }
});
void test('idempotent finalization replays without duplicate stock movements', async () => {
    const h = harness({ replay: true });
    try {
        assert.equal((await h.service.finalize(id, id, finish())).status, 'failed');
        assert.equal(
            h.queries.some((q) => /^(insert|update)/.test(q.sql)),
            false,
        );
    } finally {
        await h.db.destroy();
    }
});
void test('account ban denies replay and foreign scope attempts remain undisclosed', async () => {
    for (const options of [{ banned: true, replay: true }, { foreign: true }]) {
        const h = harness(options);
        try {
            await assert.rejects(
                h.service.finalize(id, id, finish()),
                (e: unknown) => e instanceof HttpException && [403, 404].includes(e.getStatus()),
            );
            assert.equal(
                h.queries.some((q) => q.sql.startsWith('insert')),
                false,
            );
        } finally {
            await h.db.destroy();
        }
    }
});
void test('stale ingredient version prevents inventory mutation and transaction finalization', async () => {
    const h = harness({ wrongVersion: true });
    try {
        await assert.rejects(
            h.service.finalize(id, id, finish()),
            (e: unknown) => e instanceof HttpException && e.getStatus() === 412,
        );
        assert.equal(
            h.queries.some((q) => q.sql.startsWith('update meal.inventory_batches')),
            false,
        );
        assert.equal(
            h.queries.some((q) => q.sql.startsWith('update meal.cooking_attempts')),
            false,
        );
    } finally {
        await h.db.destroy();
    }
});
void test('stock options are private, active and include prepared sources', async () => {
    const h = harness();
    try {
        await h.service.stockOptions(id);
        const query = h.queries.find((q) => q.sql.includes('source.recipe_id'));
        assert.ok(query);
        assert.match(query.sql, /b.scope_id=/);
        assert.match(query.sql, /b.archived_at is null/);
        assert.equal(query.sql.includes("b.kind='ingredient'"), false);
        assert.ok(CookingController);
    } finally {
        await h.db.destroy();
    }
});
void test('shopping read is owner-scoped and missing private lists return 404', async () => {
    const h = harness();
    try {
        await assert.rejects(
            h.shopping.detail(id, key),
            (e: unknown) => e instanceof HttpException && e.getStatus() === 404,
        );
        assert.ok(
            h.queries.some(
                (q) => q.sql.includes('meal.shopping_lists l join meal.data_scopes') && q.sql.includes('scope_id='),
            ),
        );
    } finally {
        await h.db.destroy();
    }
});
void test('public time statistics require 3 comparable completed non-skipped observations', async () => {
    for (const count of [2, 3]) {
        const h = harness({ statisticsCount: count });
        try {
            const result = await h.service.statistics(id, 2);
            assert.equal(result.medianSeconds, count < 3 ? null : 90);
            const query = h.queries.find((q) => q.sql.includes('percentile_cont'));
            assert.ok(query);
            assert.match(query.sql, /a.status='completed'/);
            assert.match(query.sql, /s.status<>'completed'/);
            assert.match(query.sql, /recipe_snapshot->>'servings'/);
        } finally {
            await h.db.destroy();
        }
    }
});
void test('duration statistics compare method with a null-safe SQL predicate', async () => {
    const h = harness({ statisticsCount: 3 });
    try {
        const result = await h.service.statistics(id, 2);
        assert.equal(result.medianSeconds, 90);
        const query = h.queries.find((q) => q.sql.includes('percentile_cont'));
        assert.ok(query);
        assert.match(query.sql, /recipe_snapshot->>'method' is not distinct from \$\d+::text/);
        assert.ok(query.parameters.includes('pot'));
    } finally {
        await h.db.destroy();
    }
});
void test('known reminder schedule uses the agreed two, four and six day lifecycle', () => {
    const schedule = cookingReminderSchedule(date);
    assert.equal(schedule.firstReminderAt, '2026-10-01T10:00:00.000Z');
    assert.equal(schedule.secondReminderAt, '2026-10-03T10:00:00.000Z');
    assert.equal(schedule.archiveAt, '2026-10-05T10:00:00.000Z');
    assert.deepEqual(schedule.quietHours, { start: '22:00', end: '09:00' });
});
void test('shopping reference edits replace rows without violating immutable identity links', async () => {
    for (const original of [null, id]) {
        const h = harness({ shopping: true, shoppingReference: original });
        try {
            await h.shopping.edit(id, id, key, {
                version: 1,
                idempotencyKey: key,
                status: 'pending',
                fields: {
                    name: 'Other',
                    quantity: null,
                    unit: null,
                    ingredientId: null,
                    productId: null,
                    allowAnalog: true,
                },
            });
            const updates = h.queries.filter((q) => q.sql.startsWith('update meal.shopping_items'));
            assert.equal(updates.length, 1);
            for (const q of updates) {
                assert.equal(q.sql.includes('ingredient_id='), false);
                assert.equal(q.sql.includes('product_id='), false);
                assert.match(q.sql, /where id=.*list_id=.*version=/);
            }
            const inserts = h.queries.filter((q) => q.sql.startsWith('insert into meal.shopping_items'));
            assert.equal(inserts.length, original ? 1 : 0);
            if (original) assert.match(updates[0]!.sql, /status='removed'/);
        } finally {
            await h.db.destroy();
        }
    }
});
