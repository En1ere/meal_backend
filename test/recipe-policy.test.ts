import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    Kysely,
    DummyDriver,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type DatabaseConnection,
    type CompiledQuery,
    type QueryResult,
    type Transaction,
} from 'kysely';
import type { DatabaseSchema } from '../src/infrastructure/database/schema.generated.js';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import type { AdminAccessService } from '../src/modules/admin-auth/admin-access.service.js';
import { RecipePolicyService } from '../src/modules/recipe-policy/recipe-policy.service.js';
import {
    defaultRecipePolicy,
    recipeAllowance,
    recipePolicyChangeSchema,
} from '../src/modules/recipe-policy/recipe-policy.contracts.js';

void test('recipe quotas use rolling action-specific windows and validate settings', () => {
    assert.deepEqual(recipeAllowance(defaultRecipePolicy, 'submission'), { limit: 10, windowSeconds: 86400 });
    assert.deepEqual(recipeAllowance(defaultRecipePolicy, 'comment'), { limit: 30, windowSeconds: 3600 });
    assert.deepEqual(recipeAllowance(defaultRecipePolicy, 'report'), { limit: 10, windowSeconds: 86400 });
    for (const value of [0, -1, 1.5, 10001])
        assert.equal(
            recipePolicyChangeSchema.safeParse({
                expectedVersion: 1,
                submissionDailyLimit: value,
                commentHourlyLimit: 30,
                reportDailyLimit: 10,
            }).success,
            false,
        );
});
void test('quota counts persisted accepted commands and rejects before inserting over limit', async () => {
    const queries: CompiledQuery[] = [];
    let count = 9;
    class Driver extends DummyDriver {
        override async acquireConnection(): Promise<DatabaseConnection> {
            await Promise.resolve();
            return {
                async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
                    await Promise.resolve();
                    queries.push(query);
                    const rows: unknown[] = query.sql.includes('from meal.recipe_policy')
                        ? [defaultRecipePolicy]
                        : query.sql.includes('count(*)')
                          ? [{ count }]
                          : [];
                    return { rows: rows as R[] };
                },
                async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
                    await Promise.resolve();
                    throw Error('unused');
                },
            };
        }
    }
    const db = new Kysely<DatabaseSchema>({
        dialect: {
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => new Driver(),
            createIntrospector: (value) => new PostgresIntrospector(value),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    const service = new RecipePolicyService({} as DatabaseService, {} as AdminAccessService);
    try {
        await service.assertAllowance(
            db as unknown as Transaction<DatabaseSchema>,
            '10000000-0000-4000-8000-000000000001',
            'submission',
        );
        assert.equal(queries.filter((q) => q.sql.startsWith('insert')).length, 1);
        assert.ok(queries.some((q) => q.parameters.includes(86400)));
        count = 10;
        await assert.rejects(
            service.assertAllowance(
                db as unknown as Transaction<DatabaseSchema>,
                '10000000-0000-4000-8000-000000000001',
                'submission',
            ),
            { status: 429 },
        );
        assert.equal(queries.filter((q) => q.sql.startsWith('insert')).length, 1);
    } finally {
        await db.destroy();
    }
});
