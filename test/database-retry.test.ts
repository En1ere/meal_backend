import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    Kysely,
    DummyDriver,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type DatabaseConnection,
    type TransactionSettings,
} from 'kysely';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../src/infrastructure/database/schema.generated.js';
import { readConfig } from '../src/app/config.js';
function harness() {
    const levels: Array<string | undefined> = [];
    let rollbacks = 0;
    class Driver extends DummyDriver {
        override beginTransaction(_connection?: DatabaseConnection, settings?: TransactionSettings): Promise<void> {
            levels.push(settings?.isolationLevel);
            return Promise.resolve();
        }
        override rollbackTransaction(): Promise<void> {
            rollbacks++;
            return Promise.resolve();
        }
    }
    // DummyDriver compiles statements but opens no connection and executes no SQL.
    const db = new Kysely<DatabaseSchema>({
        dialect: {
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => new Driver(),
            createIntrospector: (db) => new PostgresIntrospector(db),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    const service = new DatabaseService(readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
    Object.defineProperty(service, 'db', { value: db });
    return { service, db, levels, rollbacks: () => rollbacks };
}
void test('coordination unique races restart the entire serializable transaction', async () => {
    for (const constraint of [
        'uq_data_scopes_user_id',
        'uq_recipe_bookmarks_recipe_id_user_id',
        'uq_idempotency_records_actor_namespace_operatio_9fed2ea62318',
    ]) {
        const { service, db, levels, rollbacks } = harness();
        let calls = 0;
        try {
            const result = await service.transaction(() => {
                calls++;
                if (calls < 3) return Promise.reject(Object.assign(new Error('Race'), { code: '23505', constraint }));
                return Promise.resolve('replayed');
            });
            assert.equal(result, 'replayed');
            assert.equal(calls, 3);
            assert.equal(rollbacks(), 2);
            assert.deepEqual(levels, ['serializable', 'serializable', 'serializable']);
        } finally {
            await db.destroy();
        }
    }
});
void test('coordination retry is bounded to three attempts and preserves terminal error', async () => {
    const { service, db, rollbacks } = harness();
    let calls = 0;
    const error = Object.assign(new Error('Race persists'), { code: '23505', constraint: 'uq_data_scopes_user_id' });
    try {
        await assert.rejects(
            service.transaction(() => {
                calls++;
                return Promise.reject(error);
            }),
            (value) => value === error,
        );
        assert.equal(calls, 3);
        assert.equal(rollbacks(), 3);
    } finally {
        await db.destroy();
    }
});
void test('business uniqueness and unknown constraints are never retried', async () => {
    for (const constraint of ['uq_product_barcodes_code', 'uq_users_login', 'unknown']) {
        const { service, db, rollbacks } = harness();
        let calls = 0;
        const error = Object.assign(new Error('Business conflict'), { code: '23505', constraint });
        try {
            await assert.rejects(
                service.transaction(() => {
                    calls++;
                    return Promise.reject(error);
                }),
                (value) => value === error,
            );
            assert.equal(calls, 1);
            assert.equal(rollbacks(), 1);
        } finally {
            await db.destroy();
        }
    }
});
void test('serialization and deadlock retain bounded retry while unrelated failures propagate', async () => {
    for (const code of ['40001', '40P01', '23514', '57014']) {
        const { service, db } = harness();
        let calls = 0;
        const error = Object.assign(new Error('Transaction error'), { code });
        try {
            await assert.rejects(
                service.transaction(() => {
                    calls++;
                    return Promise.reject(error);
                }),
                (value) => value === error,
            );
            assert.equal(calls, ['40001', '40P01'].includes(code) ? 3 : 1);
        } finally {
            await db.destroy();
        }
    }
});
