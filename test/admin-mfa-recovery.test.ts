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
import { AdminMfaRecoveryError, parseAdminMfaRecoveryArgs, recoverAdminMfa } from '../src/modules/admin-auth/public.js';

await test('admin MFA recovery arguments are dry-run by default and execute is explicitly double-gated', () => {
    assert.deepEqual(
        parseAdminMfaRecoveryArgs(['--login', 'Admin', '--reason', 'Lost authenticator device'], undefined),
        { login: 'admin', reason: 'Lost authenticator device', mode: 'dry_run' },
    );
    assert.deepEqual(
        parseAdminMfaRecoveryArgs(
            ['--login', 'admin', '--confirm-login', 'ADMIN', '--reason', 'Lost authenticator device', '--execute'],
            'true',
        ),
        { login: 'admin', reason: 'Lost authenticator device', mode: 'execute' },
    );
    for (const [args, enabled] of [
        [['--login', 'admin', '--reason', 'Lost authenticator device', '--execute'], 'true'],
        [
            ['--login', 'admin', '--confirm-login', 'other', '--reason', 'Lost authenticator device', '--execute'],
            'true',
        ],
        [
            ['--login', 'admin', '--confirm-login', 'admin', '--reason', 'Lost authenticator device', '--execute'],
            'false',
        ],
        [['--login', 'admin', '--reason', 'short'], undefined],
        [['--login', 'admin', '--reason', 'Lost authenticator device', '--unknown'], undefined],
    ] as const)
        assert.throws(() => parseAdminMfaRecoveryArgs(args, enabled), AdminMfaRecoveryError);
});

type ActiveCounts = { factors: number; challenges: number; sessions: number };

function fakeRecoveryDatabase(options?: { invalidTarget?: boolean; failAfterAudit?: boolean }) {
    const queries: string[] = [];
    let active: ActiveCounts = { factors: 2, challenges: 3, sessions: 4 };
    const connection: DatabaseConnection = {
        async executeQuery<R>(compiled: CompiledQuery<unknown>): Promise<QueryResult<R>> {
            await Promise.resolve();
            const statement = compiled.sql.replace(/\s+/gu, ' ').trim();
            queries.push(statement);
            if (statement.startsWith('select u.id,u.login'))
                return {
                    rows: [
                        {
                            id: '00000000-0000-4000-8000-000000000001',
                            login: 'admin',
                            status: options?.invalidTarget ? 'blocked' : 'active',
                            archived_at: null,
                            email_verified_at: new Date('2026-01-01T00:00:00.000Z'),
                            current_admin: true,
                            active_factors: active.factors,
                            active_challenges: active.challenges,
                            active_sessions: active.sessions,
                        },
                    ] as R[],
                };
            if (statement.startsWith('update meal.mfa_factors')) {
                const rows = Array.from({ length: active.factors }, (_, index) => ({ id: `factor-${index}` }));
                active = { ...active, factors: 0 };
                return { rows: rows as R[] };
            }
            if (statement.startsWith('update meal.auth_challenges')) {
                const rows = Array.from({ length: active.challenges }, (_, index) => ({ id: `challenge-${index}` }));
                active = { ...active, challenges: 0 };
                return { rows: rows as R[] };
            }
            if (statement.startsWith('update meal.sessions')) {
                const rows = Array.from({ length: active.sessions }, (_, index) => ({ id: `session-${index}` }));
                active = { ...active, sessions: 0 };
                return { rows: rows as R[] };
            }
            if (statement.startsWith('insert into meal.audit_events')) {
                if (options?.failAfterAudit) throw new Error('connection outcome unknown');
                return { rows: [] as R[] };
            }
            throw new Error(`Unexpected recovery query: ${statement}`);
        },
        async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
            await Promise.resolve();
            throw new Error('Recovery never streams queries');
        },
    };
    const driver: Driver = {
        async init() {},
        acquireConnection() {
            return Promise.resolve(connection);
        },
        beginTransaction() {
            return Promise.resolve();
        },
        commitTransaction() {
            return Promise.resolve();
        },
        rollbackTransaction() {
            return Promise.resolve();
        },
        releaseConnection() {
            return Promise.resolve();
        },
        destroy() {
            return Promise.resolve();
        },
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

await test('dry-run validates the active verified admin and performs no mutation', async () => {
    const { database, queries } = fakeRecoveryDatabase();
    const result = await recoverAdminMfa(
        database,
        { login: 'admin', reason: 'Lost authenticator device', mode: 'dry_run' },
        '00000000-0000-4000-8000-000000000010',
    );
    assert.equal(result.status, 'planned');
    assert.deepEqual(result.activeBefore, { factors: 2, challenges: 3, sessions: 4 });
    assert.deepEqual(result.revoked, { factors: 0, challenges: 0, sessions: 0 });
    assert.equal(queries.length, 1);
    assert.doesNotMatch(queries[0]!, /for update|\bupdate\b|\binsert\b/iu);
});

await test('execute locks the admin, revokes every auth surface, audits and verifies zero readback', async () => {
    const { database, queries } = fakeRecoveryDatabase();
    const result = await recoverAdminMfa(
        database,
        { login: 'admin', reason: 'Lost authenticator device', mode: 'execute' },
        '00000000-0000-4000-8000-000000000011',
    );
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.revoked, { factors: 2, challenges: 3, sessions: 4 });
    assert.match(queries[0]!, /for update$/iu);
    assert.match(queries[1]!, /^update meal\.mfa_factors/iu);
    assert.match(queries[2]!, /^update meal\.auth_challenges/iu);
    assert.match(queries[3]!, /^update meal\.sessions/iu);
    assert.match(queries[4]!, /^insert into meal\.audit_events/iu);
    assert.doesNotMatch(queries.join('\n'), /secret_ciphertext|token_hash|code_hash/iu);
    assert.equal(queries.length, 6);
});

await test('invalid target and unknown transaction outcome never return a success result', async () => {
    const invalid = fakeRecoveryDatabase({ invalidTarget: true });
    await assert.rejects(
        recoverAdminMfa(invalid.database, { login: 'admin', reason: 'Lost authenticator device', mode: 'execute' }),
        (error: unknown) => error instanceof AdminMfaRecoveryError && error.code === 'TARGET_UNAVAILABLE',
    );
    assert.equal(invalid.queries.length, 1);

    const unknown = fakeRecoveryDatabase({ failAfterAudit: true });
    await assert.rejects(
        recoverAdminMfa(unknown.database, { login: 'admin', reason: 'Lost authenticator device', mode: 'execute' }),
        /outcome unknown/u,
    );
    assert.equal(unknown.queries.length, 5);
});
