import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import {
    Kysely,
    DummyDriver,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type DatabaseConnection,
    type CompiledQuery,
    type QueryResult,
} from 'kysely';
import { recipeAvailability, scaleRecipeQuantity, publicRecipeImage } from '../src/modules/recipes/recipes.domain.js';
import {
    recipeDetailSchema,
    recipePersonalSchema,
    recipesQuerySchema,
    recipePersonalQuerySchema,
    type RecipeIngredient,
} from '../src/modules/recipes/recipes.contracts.js';
import { RecipesService } from '../src/modules/recipes/recipes.service.js';
import type { DatabaseSchema } from '../src/infrastructure/database/schema.generated.js';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { createApp } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
const id = '70000000-0000-4000-8000-000000000001';
const user = '10000000-0000-4000-8000-000000000001';
const key = '90000000-0000-4000-8000-000000000001';
const ingredient = (index: number, optional = false): RecipeIngredient => ({
    id: `80000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    position: index,
    name: 'Ingredient',
    ingredientId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    variantId: null,
    productId: null,
    sourceRecipeId: null,
    quantity: '100',
    unit: 'g',
    optional,
});
void test('presence uses 80 percent of mandatory positions; insufficient and unknown amounts remain present', () => {
    const lines = Array.from({ length: 5 }, (_, i) => ingredient(i + 1));
    const stocks = lines.slice(0, 4).map((line, index) => ({
        ingredientId: line.ingredientId,
        variantId: null,
        productId: null,
        sourceRecipeId: null,
        quantity: index === 0 ? null : '1',
        unit: 'g',
    }));
    const available = recipeAvailability(lines, stocks, 1, 1);
    assert.equal(available.presencePercent, 80);
    assert.equal(available.canPrepare, true);
    assert.equal(available.needsQuantityCheck, true);
    assert.equal(available.presentCount, 4);
    assert.equal(recipeAvailability(lines, stocks.slice(0, 3), 1, 1).canPrepare, false);
});
void test('optional positions do not change readiness, zero stock is absent, incompatible units require check', () => {
    const line = ingredient(1),
        optional = ingredient(2, true);
    const stock = {
        ingredientId: line.ingredientId,
        variantId: null,
        productId: null,
        sourceRecipeId: null,
        quantity: '0',
        unit: 'g',
    };
    assert.equal(recipeAvailability([line, optional], [stock], 1, 1).presentCount, 0);
    const result = recipeAvailability([line, optional], [{ ...stock, quantity: '1', unit: 'pcs' }], 1, 1);
    assert.equal(result.requiredCount, 1);
    assert.equal(result.canPrepare, true);
    assert.equal(result.items[0]?.availableQuantity, null);
    assert.equal(result.needsQuantityCheck, true);
});
void test('portion scaling and unit aggregation preserve decimal precision without float arithmetic', () => {
    assert.equal(scaleRecipeQuantity('0.1', 1, 3), '0.3');
    assert.equal(scaleRecipeQuantity('1', 3, 1), '0.33333334');
    assert.equal(scaleRecipeQuantity(null, 3, 1), null);
    const line = { ...ingredient(1), quantity: '0.00000001', unit: 'kg' };
    const stock = {
        ingredientId: line.ingredientId,
        variantId: null,
        productId: null,
        sourceRecipeId: null,
        quantity: '0.00000001',
        unit: 'g',
    };
    const result = recipeAvailability(
        [line],
        Array.from({ length: 1000 }, () => stock),
        1,
        1,
    );
    assert.equal(result.items[0]?.availableQuantity, '0.00000001');
    assert.equal(result.needsQuantityCheck, false);
});
void test('specific SKU requirements never silently match generic inventory', () => {
    const line = { ...ingredient(1), productId: id };
    const result = recipeAvailability(
        [line],
        [
            {
                ingredientId: line.ingredientId,
                variantId: null,
                productId: null,
                sourceRecipeId: null,
                quantity: '1000',
                unit: 'g',
            },
        ],
        1,
        1,
    );
    assert.equal(result.presentCount, 0);
});
void test('safe images and strict queries never accept executable URLs or private scope overrides', () => {
    assert.equal(recipeDetailSchema.shape.steps.element.shape.temperature.parse('-18'), '-18');
    assert.equal(recipeDetailSchema.shape.steps.element.shape.temperature.safeParse('NaN').success, false);
    for (const value of [
        'javascript:alert(1)',
        'data:image/svg+xml,test',
        '//evil.test/a',
        '/assets/../private',
        'https://user:password@example.test/a',
    ])
        assert.equal(publicRecipeImage(value), null);
    assert.equal(publicRecipeImage('/assets/food160.png'), '/assets/food160.png');
    assert.equal(publicRecipeImage('https://example.test/a.png'), 'https://example.test/a.png');
    assert.equal(recipesQuerySchema.safeParse({ scope: 'family', tab: 'inventory' }).success, true);
    assert.equal(recipesQuerySchema.safeParse({ scope: 'foreign' }).success, false);
    assert.equal(recipePersonalQuerySchema.safeParse({ servings: 0 }).success, false);
});
const publicRow = {
    id,
    revisionId: id,
    title: 'Published revision',
    description: null,
    category: 'mains',
    imageUrl: 'javascript:alert(1)',
    tags: [],
    baseServings: 4,
    publishedAt: new Date('2026-09-29T00:00:00Z'),
    timing: { durationMinutes: 12, privateNote: 'secret' },
    authorLogin: 'author',
    rating: null,
    ratingCount: 0,
    method: 'pan',
    nutrition_snapshot: { kcal: '100', protein: null, fat: null, carbs: null, basis: 'recipe', privateNote: 'secret' },
    scope_id: user,
    author_id: user,
    privateNote: 'secret',
};
function harness(options: { missing?: boolean; banned?: boolean; prior?: boolean; bookmarkExists?: boolean } = {}) {
    const queries: CompiledQuery[] = [];
    class Driver extends DummyDriver {
        override async acquireConnection(): Promise<DatabaseConnection> {
            await Promise.resolve();
            return {
                async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
                    await Promise.resolve();
                    queries.push(query);
                    const s = query.sql;
                    let rows: unknown[] = [];
                    if (s.includes('from "users"')) rows = [{ id: user }];
                    else if (s.includes('from meal.sanctions')) rows = options.banned ? [{ id }] : [];
                    else if (s.includes('from "idempotency_records"') && options.prior)
                        rows = [
                            {
                                request_hash: createHash('sha256')
                                    .update(JSON.stringify({ bookmarked: true, idempotencyKey: key }))
                                    .digest('hex'),
                                response_snapshot: { recipeId: id, bookmarked: true },
                            },
                        ];
                    else if (s.includes('from "recipe_bookmarks"') && options.bookmarkExists) rows = [{ id }];
                    else if (s.includes('select count(*)::integer as total'))
                        rows = [{ total: options.missing ? 0 : 1 }];
                    else if (s.startsWith('with published') && !s.includes('where p.base_recipe_id'))
                        rows = options.missing ? [] : [publicRow];
                    return { rows: rows as R[] };
                },
                async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
                    await Promise.resolve();
                    throw Error('Not used');
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
    const service = new RecipesService(
        {
            db,
            ready: () => Promise.resolve(true),
            transaction: <T>(run: (tx: unknown) => Promise<T>) => db.transaction().execute(run),
        } as unknown as DatabaseService,
        undefined,
        undefined,
        {
            recipeProjection: () =>
                Promise.resolve({
                    allergens: [],
                    complete: false,
                    unknownIngredients: [],
                }),
        } as never,
    );
    return { service, queries, db };
}
void test('public projection follows active publication, excludes private fields and ignores newer draft snapshots', async () => {
    const { service, queries, db } = harness();
    try {
        const result = await service.detail(id);
        recipeDetailSchema.parse(result.recipe);
        assert.equal(result.recipe.title, 'Published revision');
        assert.equal(result.recipe.imageUrl, null);
        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes('secret'), false);
        assert.equal(serialized.includes('scope_id'), false);
        assert.equal(serialized.includes('author_id'), false);
        const first = queries[0]!;
        assert.match(first.sql, /p\.revision_id=rr\.id/);
        assert.match(first.sql, /p\.unpublished_at is null/);
        assert.match(first.sql, /p\.published_at<=now\(\)/);
        assert.equal(
            queries.some((q) => q.sql.includes('comment_revisions')),
            false,
        );
    } finally {
        await db.destroy();
    }
});
void test('unpublished recipes deny detail and bookmark before any write or stored replay', async () => {
    const { service, queries, db } = harness({ missing: true, prior: true });
    try {
        await assert.rejects(
            service.detail(id),
            (error: unknown) => error instanceof HttpException && error.getStatus() === 404,
        );
        await assert.rejects(service.bookmark(user, id, { bookmarked: true, idempotencyKey: key }));
        assert.equal(
            queries.some((q) => q.sql.startsWith('insert') || q.sql.includes('idempotency_records')),
            false,
        );
    } finally {
        await db.destroy();
    }
});
void test('inventory sort is applied before pagination without excluding low presence recipes', async () => {
    const { service, queries, db } = harness();
    try {
        const result = await service.list(recipesQuerySchema.parse({ tab: 'inventory', page: 2, limit: 5 }), user);
        assert.equal(result.total, 1);
        const query = queries.find((q) => q.sql.includes('order by case when'));
        assert.ok(query);
        assert.match(query.sql, /ds.kind=\$\d+/);
        assert.ok(query.parameters.includes(user));
        assert.match(query.sql, /end desc,p.published_at desc,p.id limit/);
        assert.equal(query.sql.includes(')*5 >='), false);
        const stocks = queries.find((q) => q.sql.startsWith('select coalesce(b.ingredient_id'));
        assert.ok(stocks);
        assert.match(stocks.sql, /b.archived_at is null/);
    } finally {
        await db.destroy();
    }
});
void test('bookmark replay is idempotent, changed payload conflicts and removal is ownership-scoped soft update', async () => {
    const repeated = harness({ prior: true });
    try {
        assert.deepEqual(await repeated.service.bookmark(user, id, { bookmarked: true, idempotencyKey: key }), {
            recipeId: id,
            bookmarked: true,
        });
        assert.equal(
            repeated.queries.some((q) => q.sql.startsWith('insert') || q.sql.startsWith('update')),
            false,
        );
        await assert.rejects(
            repeated.service.bookmark(user, id, { bookmarked: false, idempotencyKey: key }),
            (error: unknown) => error instanceof HttpException && error.getStatus() === 409,
        );
    } finally {
        await repeated.db.destroy();
    }
    const removed = harness({ bookmarkExists: true });
    try {
        await removed.service.bookmark(user, id, { bookmarked: false, idempotencyKey: key });
        const update = removed.queries.find((q) => q.sql.startsWith('update "recipe_bookmarks"'));
        assert.ok(update);
        assert.match(update.sql, /"user_id" =/);
        assert.equal(
            removed.queries.some((q) => q.sql.startsWith('delete')),
            false,
        );
    } finally {
        await removed.db.destroy();
    }
});
void test('account ban rejects bookmark mutation before replay but preserves public reading', async () => {
    const { service, queries, db } = harness({ banned: true, prior: true });
    try {
        await assert.rejects(
            service.bookmark(user, id, { bookmarked: true, idempotencyKey: key }),
            (error: unknown) => error instanceof HttpException && error.getStatus() === 403,
        );
        assert.equal(
            queries.some((q) => q.sql.includes('idempotency_records')),
            false,
        );
        assert.equal((await service.detail(id)).recipe.id, id);
    } finally {
        await db.destroy();
    }
});
void test('HTTP public details need no session while personal routes, inventory ranking and bookmark require auth/CSRF', async () => {
    const app = await createApp(
        readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', SECURITY_KEY: randomBytes(32).toString('base64') }),
    );
    let authCalls = 0;
    app.get(AuthService).principal = () => {
        authCalls++;
        return Promise.reject(new UnauthorizedException());
    };
    app.get(RecipesService).detail = () =>
        Promise.resolve({
            recipe: recipeDetailSchema.parse({
                ...publicRow,
                publishedAt: publicRow.publishedAt.toISOString(),
                imageUrl: null,
                durationMinutes: 12,
                availability: null,
                nutrition: null,
                ingredients: [],
                steps: [],
                variants: [],
                comments: [],
                commentsTotal: 0,
                allergens: [],
                allergensComplete: false,
                allergenCompleteness: { complete: false, unknownIngredients: [] },
            }),
        });
    try {
        assert.equal((await app.inject({ method: 'GET', url: '/api/v1/recipes/' + id })).statusCode, 200);
        assert.equal(authCalls, 0);
        assert.equal((await app.inject({ method: 'GET', url: '/api/v1/recipes/' + id + '/personal' })).statusCode, 401);
        assert.equal((await app.inject({ method: 'GET', url: '/api/v1/recipes?tab=inventory' })).statusCode, 401);
        assert.equal(
            (
                await app.inject({
                    method: 'POST',
                    url: '/api/v1/recipes/' + id + '/bookmark',
                    payload: { bookmarked: true, idempotencyKey: key },
                })
            ).statusCode,
            403,
        );
    } finally {
        await app.close();
    }
});

void test('large stored quantity scaled to 1000 portions remains a valid decimal response', () => {
    const line = { ...ingredient(1), quantity: '9999999999999999.99999999' };
    const availability = recipeAvailability([line], [], 1, 1000);
    assert.equal(availability.items[0]?.requiredQuantity, '9999999999999999999.99999');
    assert.equal(
        recipePersonalSchema.safeParse({ recipeId: id, servings: 1000, bookmarked: false, availability }).success,
        true,
    );
});
