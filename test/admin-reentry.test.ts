import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import {
    Kysely,
    DummyDriver,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type DatabaseConnection,
} from 'kysely';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
    AdminAccessService,
    AdminLockedException,
    AdminConfirmationRequiredException,
    criticalExpiry,
} from '../src/modules/admin-auth/admin-access.service.js';
import { AuthService, type Principal } from '../src/modules/auth/auth.service.js';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../src/infrastructure/database/schema.generated.js';
import { readConfig } from '../src/app/config.js';
import { adminLoginSchema, adminCodeSchema } from '../src/modules/admin-auth/admin-auth.http.js';
import { tokenHash } from '../src/modules/auth/crypto.js';
import { createApp } from '../src/app/create-app.js';

function fixture() {
    const actor: Principal = {
        id: randomUUID(),
        sessionId: randomUUID(),
        context: 'admin',
        displayName: 'Admin',
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    const state = {
        marker: true,
        revoked: false,
        role: true,
        failures: 0,
        until: null as Date | null,
        validRecovery: true,
        proofs: new Set([tokenHash('p'.repeat(43))]),
        audits: [] as string[],
    };
    class MemoryDriver extends DummyDriver {
        override acquireConnection(): Promise<DatabaseConnection> {
            return Promise.resolve<DatabaseConnection>({
                executeQuery: (query) => {
                    const q = query.sql;
                    let rows: unknown[] = [];
                    if (q.startsWith('select id from meal.admin_session_unlocks'))
                        rows =
                            state.marker && (!q.includes('token_hash') || state.proofs.has(String(query.parameters[1])))
                                ? [{ id: randomUUID() }]
                                : [];
                    else if (q.includes('select admin_critical_until')) rows = [{ admin_critical_until: state.until }];
                    else if (q.includes('select expires_at,admin_mfa_failures'))
                        rows = state.revoked
                            ? []
                            : [
                                  {
                                      expires_at: new Date(actor.expiresAt),
                                      admin_mfa_failures: state.failures,
                                      admin_critical_until: state.until,
                                  },
                              ];
                    else if (q.includes('from "users"'))
                        rows = [
                            {
                                status: 'active',
                                archived_at: null,
                                email_verified_at: new Date(),
                                is_test_account: false,
                            },
                        ];
                    else if (q.includes('from "staff_role_assignments"'))
                        rows = state.role ? [{ id: randomUUID() }] : [];
                    else if (q.includes('from "mfa_factors"'))
                        rows = [{ id: randomUUID(), verified_at: new Date(), revoked_at: null }];
                    else if (q.startsWith('update "mfa_recovery_codes"')) {
                        rows = state.validRecovery ? [{ id: randomUUID() }] : [];
                        state.validRecovery = false;
                    } else if (q.includes('set admin_mfa_failures=least')) {
                        state.failures++;
                        if (state.failures >= 5) state.revoked = true;
                    } else if (q.includes('set admin_mfa_failures=0')) state.failures = 0;
                    else if (q.includes('set admin_critical_until=')) state.until = query.parameters[0] as Date;
                    else if (q.startsWith('insert into meal.admin_session_unlocks'))
                        state.proofs.add(String(query.parameters[2]));
                    else if (q.includes('and admin_critical_until>now()'))
                        rows =
                            !state.revoked && state.until && state.until > new Date() ? [{ id: actor.sessionId }] : [];
                    else throw new Error(`Unexpected SQL: ${q}`);
                    return Promise.resolve({ rows: rows as never[] });
                },
                streamQuery: () => {
                    throw new Error('No streaming');
                },
            });
        }
    }
    const db = new Kysely<DatabaseSchema>({
        dialect: {
            createDriver: () => new MemoryDriver(),
            createAdapter: () => new PostgresAdapter(),
            createQueryCompiler: () => new PostgresQueryCompiler(),
            createIntrospector: (db) => new PostgresIntrospector(db),
        },
    });
    const database = {
        db,
        transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
    } as unknown as DatabaseService;
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    const auth = {
        principal: () => {
            if (state.revoked) throw new UnauthorizedException();
            return Promise.resolve(actor);
        },
        rateLimit: async () => {},
        audit: (_tx: unknown, _id: string, action: string) => {
            state.audits.push(action);
            return Promise.resolve();
        },
    } as unknown as AuthService;
    return { service: new AdminAccessService(database, auth, config), state, actor, db, database };
}

await test('admin input uses normalized username and never accepts password at unlock/confirmation', () => {
    assert.deepEqual(adminLoginSchema.parse({ login: 'AdMiN', password: '1', context: 'admin' }), {
        login: 'admin',
        password: '1',
        context: 'admin',
    });
    assert.equal(
        adminLoginSchema.safeParse({ email: 'admin@test.test', password: '1', context: 'admin' }).success,
        false,
    );
    assert.equal(adminCodeSchema.safeParse({ code: '123456', method: 'totp', password: '1' }).success, false);
});
await test('admin proof is required, bound to portal session, survives reload and rejects legacy cookie markers', async () => {
    const { service, state, db } = fixture();
    try {
        assert.equal((await service.status('cookie', undefined)).status, 'locked');
        await assert.rejects(service.principal('cookie', undefined), AdminLockedException);
        await assert.rejects(service.principal('cookie', 'wrong'.repeat(9)), AdminLockedException);
        assert.equal((await service.status('cookie', 'p'.repeat(43))).status, 'unlocked');
        assert.equal((await service.status('cookie', 'p'.repeat(43))).status, 'unlocked');
        state.marker = false;
        await assert.rejects(service.status('legacy-staff-cookie', 'p'.repeat(43)), UnauthorizedException);
    } finally {
        await db.destroy();
    }
});
await test('transaction-local admin role revalidation rejects a revoked role', async () => {
    const { service, state, actor, db } = fixture();
    try {
        const tx = db as unknown as Parameters<Parameters<DatabaseService['transaction']>[0]>[0];
        await service.assertAdminRole(tx, actor);
        state.role = false;
        await assert.rejects(service.assertAdminRole(tx, actor), ForbiddenException);
    } finally {
        await db.destroy();
    }
});
await test('unlock consumes recovery once, leaves absolute expiry unchanged; critical window reusable and clamped', async () => {
    const { service, state, actor, db, database } = fixture();
    try {
        const before = actor.expiresAt;
        const unlocked = await service.verify(
            'cookie',
            undefined,
            { code: 'unused-recovery', method: 'recovery' },
            'unlock',
            'ip',
            randomUUID(),
        );
        assert.ok('unlockToken' in unlocked);
        assert.equal(actor.expiresAt, before);
        await assert.rejects(
            service.verify(
                'cookie',
                undefined,
                { code: 'unused-recovery', method: 'recovery' },
                'unlock',
                'ip',
                randomUUID(),
            ),
            UnauthorizedException,
        );
        state.validRecovery = true;
        const confirmed = await service.verify(
            'cookie',
            'p'.repeat(43),
            { code: 'next-recovery', method: 'recovery' },
            'critical',
            'ip',
            randomUUID(),
        );
        assert.ok(Date.parse(confirmed.criticalUntil!) > Date.now() + 29 * 60000);
        const tx = db as unknown as Parameters<Parameters<DatabaseService['transaction']>[0]>[0];
        await service.assertCritical(tx, actor);
        await service.assertCritical(tx, actor);
        assert.equal((await service.status('cookie', undefined)).criticalUntil, null);
        state.until = new Date(Date.now() - 1);
        await assert.rejects(service.assertCritical(tx, actor), AdminConfirmationRequiredException);
        assert.ok(database);
        const now = new Date();
        assert.equal(criticalExpiry(now, new Date(now.getTime() + 60000)).getTime(), now.getTime() + 60000);
    } finally {
        await db.destroy();
    }
});
await test('five rejected verifies commit attempts, revoke remembered session; stale role prevents factor use', async () => {
    const { service, state, db } = fixture();
    try {
        state.validRecovery = false;
        for (let n = 1; n <= 5; n++) {
            await assert.rejects(
                service.verify(
                    'cookie',
                    undefined,
                    { code: 'invalid-code', method: 'recovery' },
                    'unlock',
                    'ip',
                    randomUUID(),
                ),
                UnauthorizedException,
            );
            assert.equal(state.failures, n);
        }
        assert.equal(state.revoked, true);
        assert.equal(state.audits.length, 5);
        await assert.rejects(service.status('cookie', 'p'.repeat(43)), UnauthorizedException);
        state.revoked = false;
        state.role = false;
        state.validRecovery = true;
        await assert.rejects(
            service.verify(
                'cookie',
                undefined,
                { code: 'unused-code', method: 'recovery' },
                'unlock',
                'ip',
                randomUUID(),
            ),
            UnauthorizedException,
        );
        assert.equal(state.validRecovery, true);
    } finally {
        await db.destroy();
    }
});

await test('HTTP locked proof error is distinct; critical confirmation forbids password and needs proof, logout remains available', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config),
        access = app.get(AdminAccessService),
        auth = app.get(AuthService);
    let verifies = 0,
        logouts = 0;
    access.principal = (_cookie, proof) => {
        if (proof !== 'p'.repeat(43)) throw new AdminLockedException();
        return Promise.resolve({
            id: randomUUID(),
            sessionId: randomUUID(),
            context: 'admin',
            displayName: 'Admin',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
        });
    };
    access.verify = () => {
        verifies++;
        return Promise.resolve({ criticalUntil: new Date(Date.now() + 60000).toISOString() });
    };
    auth.logout = () => {
        logouts++;
        return Promise.resolve();
    };
    try {
        const csrf = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' });
        const headers = {
            origin: config.ADMIN_FRONTEND_ORIGIN!,
            cookie: csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; ') + '; meal_admin=remembered',
            'x-csrf-token': csrf.json<{ data: { token: string } }>().data.token,
        };
        const locked = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/me', headers });
        assert.equal(locked.statusCode, 403);
        assert.equal(locked.json<{ error: { code: string } }>().error.code, 'ADMIN_LOCKED');
        const post = (payload: Record<string, string>, proof?: string) =>
            app.inject({
                method: 'POST',
                url: '/api/v1/admin/auth/critical-confirm',
                headers: { ...headers, ...(proof ? { 'x-admin-unlock': proof } : {}) },
                payload,
            });
        assert.equal((await post({ code: '123456', method: 'totp' })).statusCode, 403);
        assert.equal((await post({ code: '123456', method: 'totp', password: '1' }, 'p'.repeat(43))).statusCode, 400);
        assert.equal((await post({ code: '123456', method: 'totp' }, 'p'.repeat(43))).statusCode, 200);
        assert.equal(verifies, 1);
        assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/auth/logout', headers })).statusCode, 200);
        assert.equal(logouts, 1);
        const preflight = await app.inject({
            method: 'OPTIONS',
            url: '/api/v1/admin/auth/me',
            headers: {
                origin: config.ADMIN_FRONTEND_ORIGIN!,
                'access-control-request-method': 'GET',
                'access-control-request-headers': 'x-admin-unlock',
            },
        });
        assert.match(String(preflight.headers['access-control-allow-headers']), /X-Admin-Unlock/i);
    } finally {
        await app.close();
    }
});
