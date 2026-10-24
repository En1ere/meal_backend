import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
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
import { createApp } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { ProductsService } from '../src/modules/products/products.service.js';
import {
    productProposalSchema,
    productSearchSchema,
    productResultSchema,
    validProductBarcode,
    type ProductProposal,
} from '../src/modules/products/products.contracts.js';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../src/infrastructure/database/schema.generated.js';
const user = '10000000-0000-4000-8000-000000000001';
const proposal: ProductProposal = {
    idempotencyKey: user,
    name: 'Тестовый продукт',
    categoryId: user,
    unit: 'pack',
    brand: null,
    packageQuantity: '1',
    barcode: null,
    compositionText: null,
    kcal: '250',
    protein: '10',
    fat: '5',
    carbs: '30',
    nutritionBasisUnit: 'g',
    allergens: [],
    source: 'user',
    sourceText: null,
};
void test('barcode checksum and proposal contract reject malformed identifiers and implicit nutrition basis', () => {
    for (const code of ['4006381333931', '96385074', '036000291452'])
        assert.equal(validProductBarcode(code), true, code);
    for (const code of ['4006381333932', '123456789', 'abc', '036000291453'])
        assert.equal(validProductBarcode(code), false, code);
    assert.equal(productProposalSchema.parse(proposal).nutritionBasisUnit, 'g');
    assert.equal(productProposalSchema.safeParse({ ...proposal, nutritionBasisUnit: 'pack' }).success, false);
    assert.equal(productProposalSchema.safeParse({ ...proposal, ownerId: user }).success, false);
    assert.equal(productProposalSchema.safeParse({ ...proposal, kcal: '1e4' }).success, false);
});
void test('product HTTP routes require session and CSRF and validate input before service', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config);
    let calls = 0;
    app.get(AuthService).principal = (token) =>
        token
            ? Promise.resolve({
                  id: user,
                  sessionId: user,
                  context: 'user',
                  displayName: 'Test',
                  expiresAt: '2099-01-01T00:00:00Z',
              })
            : Promise.reject(new UnauthorizedException());
    app.get(ProductsService).list = () => {
        calls++;
        return Promise.resolve({ items: [], total: 0, limit: 20, offset: 0 });
    };
    try {
        assert.equal((await app.inject({ method: 'GET', url: '/api/v1/products' })).statusCode, 401);
        const result = await app.inject({
            method: 'GET',
            url: '/api/v1/products',
            headers: { cookie: 'meal_user=fixture' },
        });
        assert.equal(result.statusCode, 200);
        assert.equal(calls, 1);
        assert.equal(
            (
                await app.inject({
                    method: 'GET',
                    url: '/api/v1/products?limit=101',
                    headers: { cookie: 'meal_user=fixture' },
                })
            ).statusCode,
            400,
        );
        assert.equal(calls, 1);
        assert.equal(
            (
                await app.inject({
                    method: 'POST',
                    url: '/api/v1/products/proposals',
                    headers: { cookie: 'meal_user=fixture', origin: config.FRONTEND_ORIGIN },
                    payload: proposal,
                })
            ).statusCode,
            403,
        );
        const csrf = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
        const token = csrf.json<{ data: { token: string } }>().data.token;
        const cookie = csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        assert.equal(
            (
                await app.inject({
                    method: 'POST',
                    url: '/api/v1/products/proposals',
                    headers: {
                        cookie: cookie + '; meal_user=fixture',
                        origin: config.FRONTEND_ORIGIN,
                        'x-csrf-token': token,
                    },
                    payload: { ...proposal, ownerId: user },
                })
            ).statusCode,
            400,
        );
    } finally {
        await app.close();
    }
});
function harness(
    options: {
        visible?: boolean;
        manyProducts?: boolean;
        replay?: boolean;
        banned?: boolean;
        collision?: boolean;
    } = {},
) {
    const queries: CompiledQuery[] = [];
    let rollbacks = 0;
    class Driver extends DummyDriver {
        override rollbackTransaction(): Promise<void> {
            rollbacks++;
            return Promise.resolve();
        }
        override async acquireConnection(): Promise<DatabaseConnection> {
            await Promise.resolve();
            return {
                async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
                    await Promise.resolve();
                    queries.push(query);
                    if (options.collision && query.sql.includes('insert into "product_barcodes"'))
                        throw Object.assign(new Error('Unique violation'), {
                            code: '23505',
                            constraint: 'uq_product_barcodes_code',
                        });
                    const text = query.sql;
                    let rows: unknown[] = [];
                    if (text.includes('from "users"')) rows = [{ id: user }];
                    else if (text.includes('from meal.sanctions')) rows = options.banned ? [{ id: user }] : [];
                    else if (text.includes('from "idempotency_records"') && options.replay)
                        rows = [
                            {
                                request_hash: createHash('sha256').update(JSON.stringify(proposal)).digest('hex'),
                                response_snapshot: { ingredientId: user },
                            },
                        ];
                    else if (text.includes('from "categories"') || text.includes('from "units"')) rows = [{ id: user }];
                    else if (text.includes('count(*)')) rows = [{ total: 0 }];
                    else if (text.includes('i.version::integer') && options.visible)
                        rows = [
                            {
                                id: user,
                                name: 'Visible',
                                categoryCode: 'CAT01',
                                defaultUnit: 'g',
                                status: 'approved',
                                owned: false,
                                version: 1,
                                aliases: [],
                            },
                        ];
                    else if (text.includes('select v.id,v.name') && options.visible)
                        rows = [{ id: user, name: 'Variant' }];
                    else if (text.includes('select p.id,p.variant_id') && options.visible)
                        rows = Array.from({ length: options.manyProducts ? 100 : 1 }, (_, i) => ({
                            id: `30000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
                            variantId: user,
                            name: 'SKU',
                            brand: null,
                            packageQuantity: '1',
                            packageUnit: 'pack',
                        }));
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
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => new Driver(),
            createIntrospector: (db) => new PostgresIntrospector(db),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    const service = new ProductsService({
        db,
        ready: () => Promise.resolve(true),
        transaction: <T>(run: (tx: unknown) => Promise<T>) => db.transaction().execute(run),
    } as unknown as DatabaseService);
    return { service, queries, db, rollbacks: () => rollbacks };
}
void test('SQL search binds actor in public-or-own predicate and own pending barcode lookup', async () => {
    const { service, queries, db } = harness();
    await service.list(user, productSearchSchema.parse({ q: "%' OR true --", barcode: '4006381333931' }));
    const query = queries.find((q) => q.sql.includes('position(lower'));
    assert.ok(query);
    assert.match(query.sql, /cp.author_id=/);
    assert.match(query.sql, /own.author_id=/);
    assert.ok(query.parameters.includes(user));
    assert.equal(query.sql.includes('OR true --'), false);
    await db.destroy();
});
void test('invisible detail and replay never load private SKU content or perform writes', async () => {
    const { service, queries, db } = harness({ replay: true });
    await assert.rejects(
        service.propose(user, proposal),
        (error: unknown) => error instanceof HttpException && error.getStatus() === 404,
    );
    assert.equal(
        queries.some((q) => q.sql.startsWith('insert')),
        false,
    );
    assert.equal(
        queries.some((q) => q.sql.includes('select p.id,p.variant_id')),
        false,
    );
    await db.destroy();
});
void test('SKU detail queries remain bounded as number of products grows', async () => {
    const { service, queries, db } = harness({ visible: true, manyProducts: true });
    const result = await service.detail(user, user);
    productResultSchema.parse(result);
    assert.equal(result.product.variants[0]?.products.length, 100);
    assert.ok(queries.length <= 12, `queries=${queries.length}`);
    await db.destroy();
});
void test('invalid allergen causes transaction rollback after draft inserts and prevents success/idempotency commit', async () => {
    const { service, queries, db, rollbacks } = harness();
    await assert.rejects(service.propose(user, { ...proposal, allergens: [{ code: 'missing', status: 'unknown' }] }));
    assert.ok(queries.some((q) => q.sql.includes('insert into "ingredients"')));
    assert.equal(rollbacks(), 1);
    assert.equal(
        queries.some((q) => q.sql.includes('insert into "idempotency_records"')),
        false,
    );
    const composition = queries.find((q) => q.sql.includes('insert into "composition_versions"'));
    assert.ok(composition);
    assert.match(composition.sql, /'\[\]'::jsonb/);
    await db.destroy();
});
void test('sanction rejects proposal before replay; duplicate allergen rejects before writes', async () => {
    const blocked = harness({ banned: true, replay: true });
    await assert.rejects(blocked.service.propose(user, proposal));
    assert.equal(
        blocked.queries.some((q) => q.sql.includes('idempotency_records')),
        false,
    );
    await blocked.db.destroy();
    const normal = harness();
    await assert.rejects(
        normal.service.propose(user, {
            ...proposal,
            allergens: [
                { code: 'milk', status: 'contains' },
                { code: 'milk', status: 'unknown' },
            ],
        }),
    );
    assert.equal(
        normal.queries.some((q) => q.sql.startsWith('insert')),
        false,
    );
    await normal.db.destroy();
});

void test('concurrent barcode uniqueness failure is mapped to conflict after rollback', async () => {
    const { service, db, rollbacks } = harness({ collision: true });
    await assert.rejects(
        service.propose(user, { ...proposal, barcode: '4006381333931' }),
        (error: unknown) => error instanceof HttpException && error.getStatus() === 409,
    );
    assert.equal(rollbacks(), 1);
    await db.destroy();
});
