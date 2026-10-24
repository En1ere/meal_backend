import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { AdminAccessService } from '../src/modules/admin-auth/admin-access.service.js';
import { readConfig } from '../src/app/config.js';
import { createApp } from '../src/app/create-app.js';

await test('admin IP configuration accepts empty or exact addresses and rejects malformed restrictions', () => {
    assert.deepEqual(readConfig({}).ADMIN_ALLOWED_IPS, []);
    assert.deepEqual(readConfig({ ADMIN_ALLOWED_IPS: '  ' }).ADMIN_ALLOWED_IPS, []);
    assert.deepEqual(readConfig({ ADMIN_ALLOWED_IPS: '192.0.2.10, 2001:db8::10' }).ADMIN_ALLOWED_IPS, [
        '192.0.2.10',
        '2001:db8::10',
    ]);
    for (const value of ['*', 'true', 'example.test', '192.0.2.10/24', ',', '192.0.2.10,', '999.1.1.1'])
        assert.throws(() => readConfig({ ADMIN_ALLOWED_IPS: value }), /ADMIN_ALLOWED_IPS/);
});

await test('admin routes enforce IP restriction before auth and ignore spoofed untrusted forwarding', async () => {
    const app = await createApp(
        readConfig({
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
            SECURITY_KEY: randomBytes(32).toString('base64'),
            ADMIN_ALLOWED_IPS: '192.0.2.10,2001:db8::10',
        }),
    );
    app.get(AdminAccessService).principal = () => {
        throw new UnauthorizedException();
    };
    try {
        for (const remoteAddress of ['192.0.2.10', '::ffff:192.0.2.10', '2001:db8:0:0:0:0:0:10'])
            assert.equal(
                (await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf', remoteAddress })).statusCode,
                200,
            );
        for (const url of ['/api/v1/admin/auth/csrf', '/api/v1/admin/auth/me', '/api/v1/%61dmin/auth/csrf']) {
            const response = await app.inject({
                method: 'GET',
                url,
                remoteAddress: '198.51.100.2',
                headers: { 'x-forwarded-for': '192.0.2.10', 'x-real-ip': '192.0.2.10' },
            });
            assert.ok([403, 404].includes(response.statusCode));
        }
        assert.equal(
            (await app.inject({ method: 'GET', url: '/api/v1/admin/auth/me', remoteAddress: '192.0.2.10' })).statusCode,
            401,
        );
        assert.equal(
            (await app.inject({ method: 'GET', url: '/health/live', remoteAddress: '198.51.100.2' })).statusCode,
            200,
        );
        assert.equal(
            (await app.inject({ method: 'GET', url: '/api/v1/auth/csrf', remoteAddress: '198.51.100.2' })).statusCode,
            200,
        );
    } finally {
        await app.close();
    }
});

await test('only explicitly trusted proxies supply the client IP; empty list leaves admin auth intact', async () => {
    for (const allowed of ['', '192.0.2.10']) {
        const app = await createApp(
            readConfig({
                NODE_ENV: 'test',
                LOG_LEVEL: 'silent',
                SECURITY_KEY: randomBytes(32).toString('base64'),
                ADMIN_ALLOWED_IPS: allowed,
                TRUSTED_PROXY_CIDRS: '127.0.0.1',
            }),
        );
        app.get(AdminAccessService).principal = () => {
            throw new UnauthorizedException();
        };
        try {
            for (const forwarded of ['192.0.2.10', '198.51.100.2', '192.0.2.10, 198.51.100.2']) {
                const response = await app.inject({
                    method: 'GET',
                    url: '/api/v1/admin/auth/csrf',
                    remoteAddress: '127.0.0.1',
                    headers: { 'x-forwarded-for': forwarded },
                });
                assert.equal(response.statusCode, !allowed || forwarded === '192.0.2.10' ? 200 : 403);
            }
            assert.equal(
                (await app.inject({ method: 'GET', url: '/api/v1/admin/auth/me', remoteAddress: '192.0.2.10' }))
                    .statusCode,
                401,
            );
        } finally {
            await app.close();
        }
    }
});
