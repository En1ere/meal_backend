import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { createApp } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';
import { AuthService, type Principal } from '../src/modules/auth/auth.service.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { AdminAccessService } from '../src/modules/admin-auth/admin-access.service.js';

await test('admin origin is exact, HTTPS in production and disabled when unconfigured in production', async () => {
    const base = {
        NODE_ENV: 'production',
        FRONTEND_ORIGIN: 'https://app.example.test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/meal_planner_postgres',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    };
    assert.throws(() => readConfig({ ...base, ADMIN_FRONTEND_ORIGIN: 'http://admin.example.test' }));
    assert.throws(() => readConfig({ ...base, ADMIN_FRONTEND_ORIGIN: 'https://admin.example.test/path' }));
    const app = await createApp(readConfig(base));
    try {
        assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })).statusCode, 503);
    } finally {
        await app.close();
    }
});

await test('admin namespace enforces isolated CSRF/cookie, admin context, MFA and separate origin', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config);
    const auth = app.get(AuthService);
    app.get(AdminAccessService).principal = (token) => auth.principal(token, 'staff');
    const principal: Principal = {
        id: randomUUID(),
        sessionId: randomUUID(),
        displayName: 'Administrator',
        context: 'admin',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    let seenContext = '',
        seenExpected: string | undefined;
    auth.login = (_email, _password, context) => {
        seenContext = context;
        return Promise.resolve({
            status: 'mfa_required' as const,
            challenge: 'a'.repeat(43),
            expiresAt: principal.expiresAt,
            enrollment: null,
        });
    };
    auth.completeMfa = (_challenge, _code, _method, _requestId, expected) => {
        seenExpected = expected;
        return Promise.resolve({ session: { token: 'b'.repeat(43), principal }, recoveryCodes: [] });
    };
    auth.principal = (token) => {
        if (!token) throw new UnauthorizedException();
        return Promise.resolve({ ...principal, context: token === 'moderator' ? 'moderator' : 'admin' });
    };
    auth.logout = async () => {};
    try {
        const csrf = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' });
        assert.equal(csrf.cookies[0]?.name, 'meal_admin_csrf');
        assert.equal(csrf.cookies[0]?.httpOnly, true);
        const cookie = csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        const headers = {
            origin: config.ADMIN_FRONTEND_ORIGIN!,
            cookie,
            'x-csrf-token': csrf.json<{ data: { token: string } }>().data.token,
        };
        const payload = { login: 'admin', password: '1', context: 'admin' };
        const post = (extra: Record<string, string> = {}, input = payload) =>
            app.inject({
                method: 'POST',
                url: '/api/v1/admin/auth/login',
                headers: { ...headers, ...extra },
                payload: input,
            });
        assert.equal((await post({ origin: config.FRONTEND_ORIGIN })).statusCode, 403);
        assert.equal(
            (
                await app.inject({
                    method: 'GET',
                    url: '/api/v1/%61dmin/auth/csrf',
                    headers: { origin: config.FRONTEND_ORIGIN },
                })
            ).statusCode,
            403,
        );
        const publicCsrf = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
        assert.equal(
            (
                await app.inject({
                    method: 'POST',
                    url: '/api/v1/%61dmin/auth/login',
                    headers: {
                        origin: config.FRONTEND_ORIGIN,
                        cookie: publicCsrf.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
                        'x-csrf-token': publicCsrf.json<{ data: { token: string } }>().data.token,
                    },
                    payload,
                })
            ).statusCode,
            403,
        );
        assert.equal((await post({ cookie: cookie.replace('meal_admin_csrf', 'meal_csrf') })).statusCode, 403);
        assert.equal((await post({}, { ...payload, context: 'moderator' })).statusCode, 400);
        const login = await post();
        assert.equal(login.statusCode, 200);
        assert.equal(login.cookies.length, 0);
        assert.equal(seenContext, 'admin');
        const verify = await app.inject({
            method: 'POST',
            url: '/api/v1/admin/auth/mfa/verify',
            headers,
            payload: { challenge: 'a'.repeat(43), code: '123456', method: 'totp' },
        });
        assert.equal(verify.statusCode, 200);
        assert.equal(seenExpected, 'admin');
        assert.equal(verify.cookies[0]?.name, 'meal_admin');
        assert.equal(verify.cookies[0]?.httpOnly, true);
        for (const cookie of ['meal_staff=valid', 'meal_user=valid'])
            assert.equal(
                (await app.inject({ method: 'GET', url: '/api/v1/admin/auth/me', headers: { cookie } })).statusCode,
                401,
            );
        assert.equal(
            (
                await app.inject({
                    method: 'GET',
                    url: '/api/v1/admin/auth/me',
                    headers: { cookie: 'meal_admin=moderator' },
                })
            ).statusCode,
            403,
        );
        assert.equal(
            (await app.inject({ method: 'GET', url: '/api/v1/admin/auth/me', headers: { cookie: 'meal_admin=valid' } }))
                .statusCode,
            200,
        );
        assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers })).statusCode, 403);
        const logout = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/logout', headers });
        assert.equal(logout.cookies[0]?.name, 'meal_admin');
    } finally {
        await app.close();
    }
});

await test('admin MFA rejects a moderator challenge inside transaction before reading or consuming a factor', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config);
    const auth = app.get(AuthService),
        database = app.get(DatabaseService);
    Object.defineProperty(database, 'db', { value: { destroy: async () => {} } });
    database.ready = () => Promise.resolve(true);
    let queries = 0;
    const query = {
        selectAll() {
            return query;
        },
        where() {
            return query;
        },
        forUpdate() {
            return query;
        },
        executeTakeFirst() {
            return Promise.resolve({
                purpose: 'staff_login',
                user_id: randomUUID(),
                factor_id: randomUUID(),
                expires_at: new Date(Date.now() + 600000),
                attempts: 0,
                auth_context: 'moderator',
            });
        },
    };
    const tx = {
        selectFrom() {
            queries++;
            return query;
        },
    };
    database.transaction = (callback) =>
        callback(tx as unknown as Parameters<Parameters<DatabaseService['transaction']>[0]>[0]);
    try {
        await assert.rejects(
            auth.completeMfa('a'.repeat(43), '123456', 'totp', randomUUID(), 'admin'),
            UnauthorizedException,
        );
        assert.equal(queries, 1);
    } finally {
        await app.close();
    }
});
