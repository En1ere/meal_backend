import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
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
import { InventoryService, inventoryQuerySchema } from '../src/modules/inventory/inventory.service.js';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../src/infrastructure/database/schema.generated.js';
const user = '10000000-0000-4000-8000-000000000001';
const family = '50000000-0000-4000-8000-000000000001';
function harness(options: { banned?: boolean; scope?: boolean; familyScope?: boolean; familyAccess?: boolean } = {}) {
    const queries: CompiledQuery[] = [];
    class Driver extends DummyDriver {
        override async acquireConnection(): Promise<DatabaseConnection> {
            await Promise.resolve();
            return {
                async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
                    await Promise.resolve();
                    queries.push(query);
                    let rows: unknown[] = [];
                    if (query.sql.includes('schema_migrations')) rows = [{ ok: true }];
                    else if (query.sql.includes('from "users"')) rows = [{ id: user }];
                    else if (query.sql.includes('from meal.sanctions')) rows = options.banned ? [{ id: user }] : [];
                    else if (query.sql.includes('from "family_memberships" as "membership"'))
                        rows = options.familyScope ? [{ id: family, familyId: family }] : [];
                    else if (query.sql.includes('from "data_scopes"')) rows = options.scope ? [{ id: user }] : [];
                    else if (query.sql.includes('from meal.ingredients')) rows = [{ id: user }];
                    else if (query.sql.includes('from "units"')) rows = [{ id: user, code: 'l' }];
                    else if (query.sql.includes('from "storage_locations"')) rows = [{ id: user }];
                    else if (query.sql.includes('count(*)')) rows = [{ total: 0 }];
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
    const service = new InventoryService(
        {
            db,
            ready: () => Promise.resolve(true),
            transaction: <T>(run: (tx: unknown) => Promise<T>) => db.transaction().execute(run),
        } as unknown as DatabaseService,
        {
            resolveFamily: () => Promise.resolve({ capabilities: { family: options.familyAccess !== false } }),
        } as never,
    );
    return { service, queries, db };
}
void test('fresh account returns empty without creating data scope on read', async () => {
    const { service, queries, db } = harness();
    assert.deepEqual(await service.list(user, inventoryQuerySchema.parse({ localDate: '2026-09-28' })), {
        items: [],
        total: 0,
    });
    assert.equal(
        queries.some((q) => /insert|update meal/i.test(q.sql)),
        false,
    );
    await db.destroy();
});
void test('SQL list is owner scoped and literal query text stays parameterized', async () => {
    const { service, queries, db } = harness({ scope: true });
    await service.list(user, inventoryQuerySchema.parse({ localDate: '2026-09-28', q: "%' OR true --" }));
    const query = queries.find((q) => q.sql.includes('position(lower'));
    assert.ok(query);
    assert.match(query.sql, /b.scope_id=/);
    assert.equal(query.sql.includes('OR true --'), false);
    assert.ok(query.parameters.includes("%' OR true --"));
    await db.destroy();
});
void test('family inventory requires current membership and uses only the family scope', async () => {
    const missing = harness();
    await assert.rejects(
        missing.service.list(user, inventoryQuerySchema.parse({ localDate: '2026-09-28', scope: 'family' })),
        (error: unknown) => error instanceof HttpException && error.getStatus() === 404,
    );
    await missing.db.destroy();

    const active = harness({ familyScope: true });
    await active.service.list(user, inventoryQuerySchema.parse({ localDate: '2026-09-28', scope: 'family' }));
    const list = active.queries.find((query) => query.sql.includes('position(lower'));
    assert.ok(list);
    assert.ok(list.parameters.includes(family));
    await active.db.destroy();
});
void test('account sanction blocks writes before scope creation or idempotent replay', async () => {
    const { service, queries, db } = harness({ banned: true });
    await assert.rejects(
        service.location(user, {
            action: 'create',
            name: 'Холодильник',
            type: 'fridge',
            scope: 'private',
            idempotencyKey: user,
        }),
    );
    assert.equal(
        queries.some((q) => q.sql.includes('idempotency_records') || q.sql.startsWith('insert')),
        false,
    );
    await db.destroy();
});

void test('create persists ingredient batch and append-only movement atomically in same transaction', async () => {
    const { service, queries, db } = harness({ scope: true });
    const result = await service.create(user, {
        scope: 'private',
        ingredientId: user,
        idempotencyKey: user,
        name: 'Молоко',
        quantity: '0.3',
        unit: 'l',
        locationId: user,
        purchasedOn: null,
        expiryOn: null,
        openedAt: null,
        packageState: 'unknown',
        precision: 'exact',
        quantitySource: 'user',
        confidence: null,
        pricePaidRub: null,
        storeName: null,
        barcode: null,
    });
    assert.equal(result.batch.quantity, '0.3');
    assert.equal(result.batch.version, 1);
    assert.ok(
        queries.find(
            (query) => query.sql.includes('insert into meal.inventory_batches') && query.sql.includes("'ingredient'"),
        ),
    );
    assert.ok(queries.find((query) => query.sql.includes('insert into "inventory_movements"')));
    assert.ok(queries.find((query) => query.sql.includes('insert into "idempotency_records"')));
    await db.destroy();
});

void test('bulk import prefetches references and writes bounded chunks in one transaction', async () => {
    const { service, queries, db } = harness({ scope: true });
    const row: Parameters<InventoryService['create']>[1] = {
        scope: 'private',
        ingredientId: user,
        idempotencyKey: user,
        name: 'Молоко',
        quantity: '0.3',
        unit: 'l',
        locationId: user,
        purchasedOn: null,
        expiryOn: null,
        openedAt: null,
        packageState: 'unknown',
        precision: 'exact',
        quantitySource: 'inventory',
        confidence: null,
        pricePaidRub: null,
        storeName: null,
        barcode: null,
    };
    const result = await service.importMany(user, {
        rows: Array.from({ length: 401 }, () => ({ ...row })),
        idempotencyKey: user,
    });
    assert.equal(result.items.length, 401);
    assert.equal(queries.filter((q) => q.sql.includes('insert into meal.inventory_batches')).length, 3);
    assert.equal(queries.filter((q) => q.sql.includes('insert into "inventory_movements"')).length, 3);
    assert.ok(queries.length < 25);
    await db.destroy();
});
