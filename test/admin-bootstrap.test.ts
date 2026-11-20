import assert from 'node:assert/strict';
import test from 'node:test';
import {
    Kysely,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type CompiledQuery,
    type DatabaseConnection,
    type Driver,
    type QueryResult,
    type Transaction,
} from 'kysely';
import type { DatabaseSchema } from '../src/infrastructure/database/schema.generated.js';
import { AdminBootstrapError, bootstrapFirstAdmin, parseAdminBootstrapArgs } from '../src/modules/admin-auth/public.js';

await test('first-admin bootstrap is a development/test dry-run unless explicitly double-gated', () => {
    assert.deepEqual(
        parseAdminBootstrapArgs(
            ['--login', 'Admin', '--reason', 'Initial local administrator'],
            undefined,
            'development',
        ),
        {
            login: 'admin',
            reason: 'Initial local administrator',
            mode: 'dry_run',
            environment: 'development',
        },
    );
    assert.equal(
        parseAdminBootstrapArgs(
            ['--login', 'admin', '--confirm-login', 'ADMIN', '--reason', 'Initial local administrator', '--execute'],
            'true',
            'test',
        ).mode,
        'execute',
    );
    for (const environment of [undefined, 'production'])
        assert.throws(
            () =>
                parseAdminBootstrapArgs(
                    ['--login', 'admin', '--reason', 'Initial local administrator'],
                    undefined,
                    environment,
                ),
            AdminBootstrapError,
        );
    assert.throws(
        () =>
            parseAdminBootstrapArgs(
                ['--login', 'admin', '--reason', 'Initial local administrator', '--execute'],
                'true',
                'development',
            ),
        AdminBootstrapError,
    );
});

function fakeBootstrapDatabase(options?: { otherAdmin?: boolean; currentAdmin?: boolean }) {
    const queries: string[] = [];
    let currentAdmin = options?.currentAdmin ?? false;
    const connection: DatabaseConnection = {
        async executeQuery<R>(compiled: CompiledQuery<unknown>): Promise<QueryResult<R>> {
            await Promise.resolve();
            const statement = compiled.sql.replace(/\s+/gu, ' ').trim();
            queries.push(statement);
            if (statement.startsWith('select pg_advisory_xact_lock')) return { rows: [] as R[] };
            if (statement.startsWith('select u.id,u.login'))
                return {
                    rows: [
                        {
                            id: '00000000-0000-4000-8000-000000000001',
                            login: 'admin',
                            status: 'active',
                            archived_at: null,
                            email_verified_at: new Date('2026-01-01T00:00:00.000Z'),
                            current_admin: currentAdmin,
                            active_admins: options?.otherAdmin ? 1 : currentAdmin ? 1 : 0,
                        },
                    ] as R[],
                };
            if (statement.startsWith('insert into "staff_role_assignments"')) {
                currentAdmin = true;
                return { rows: [] as R[] };
            }
            if (statement.startsWith('insert into meal.audit_events')) return { rows: [] as R[] };
            throw new Error(`Unexpected bootstrap query: ${statement}`);
        },
        async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
            await Promise.resolve();
            throw new Error('Bootstrap never streams queries');
        },
    };
    const driver: Driver = {
        async init() {},
        acquireConnection: () => Promise.resolve(connection),
        beginTransaction: () => Promise.resolve(),
        commitTransaction: () => Promise.resolve(),
        rollbackTransaction: () => Promise.resolve(),
        releaseConnection: () => Promise.resolve(),
        destroy: () => Promise.resolve(),
    };
    const db = new Kysely<DatabaseSchema>({
        dialect: {
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => driver,
            createIntrospector: (database) => new PostgresIntrospector(database),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    return {
        queries,
        database: {
            db,
            transaction: async <T>(run: (tx: Transaction<DatabaseSchema>) => Promise<T>) =>
                db.transaction().setIsolationLevel('serializable').execute(run),
        },
    };
}

await test('first-admin bootstrap creates one audited role and verifies readback', async () => {
    const { database, queries } = fakeBootstrapDatabase();
    const result = await bootstrapFirstAdmin(
        database,
        {
            login: 'admin',
            reason: 'Initial local administrator',
            mode: 'execute',
            environment: 'development',
        },
        '00000000-0000-4000-8000-000000000010',
    );
    assert.equal(result.status, 'completed');
    assert.match(queries.join('\n'), /staff_role_assignments/);
    assert.match(queries.join('\n'), /operator\.first_admin_bootstrapped/);
    assert.doesNotMatch(queries.join('\n'), /password_hash|secret_ciphertext|token_hash/);
});

await test('first-admin bootstrap is idempotent for the same sole admin and rejects a different admin', async () => {
    const current = fakeBootstrapDatabase({ currentAdmin: true });
    const repeated = await bootstrapFirstAdmin(current.database, {
        login: 'admin',
        reason: 'Initial local administrator',
        mode: 'execute',
        environment: 'test',
    });
    assert.equal(repeated.status, 'already_completed');
    assert.equal(current.queries.filter((query) => query.includes('staff_role_assignments"')).length, 0);

    const conflict = fakeBootstrapDatabase({ otherAdmin: true });
    await assert.rejects(
        bootstrapFirstAdmin(conflict.database, {
            login: 'admin',
            reason: 'Initial local administrator',
            mode: 'dry_run',
            environment: 'development',
        }),
        (error: unknown) => error instanceof AdminBootstrapError && error.code === 'ADMIN_ALREADY_EXISTS',
    );
});
