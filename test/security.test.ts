import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { createApp } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';
import { encryptSecret, decryptSecret, tokenHash, verifyPassword } from '../src/modules/auth/crypto.js';
import { loginSchema } from '../src/modules/auth/auth.http.js';

await test('password verification matches existing seed format and rejects malformed hashes', async () => {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync('1', salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
    assert.equal(await verifyPassword('1', `scrypt$32768$8$1$${salt}$${hash}`), true);
    assert.equal(await verifyPassword('wrong', `scrypt$32768$8$1$${salt}$${hash}`), false);
    assert.equal(await verifyPassword('1', 'scrypt$999999999$8$1$x$y'), false);
});
await test('MFA ciphertext is authenticated and bound to one factor; hashes are not bearer tokens', () => {
    const key = randomBytes(32).toString('base64');
    const ciphertext = encryptSecret('TEST-SECRET', key, 'factor-a');
    assert.equal(decryptSecret(ciphertext, key, 'factor-a'), 'TEST-SECRET');
    assert.throws(() => decryptSecret(ciphertext, key, 'factor-b'));
    assert.throws(() => decryptSecret(ciphertext, randomBytes(32).toString('base64'), 'factor-a'));
    assert.equal(ciphertext.includes('TEST-SECRET'), false);
    assert.notEqual(tokenHash('session-token'), 'session-token');
});
await test('CSRF applies to login/logout, rejects cross origin, validates body and never leaks configuration', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config);
    try {
        const missing = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            payload: { email: 'admin@meal-planner.test', password: '1' },
        });
        assert.equal(missing.statusCode, 403);
        const nonce = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
        assert.equal(nonce.statusCode, 200);
        assert.equal(nonce.headers['cache-control'], 'no-store');
        assert.equal(nonce.headers['x-content-type-options'], 'nosniff');
        assert.equal(nonce.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(nonce.headers['referrer-policy'], 'no-referrer');
        assert.match(String(nonce.headers['content-security-policy']), /default-src 'self'/);
        assert.ok(nonce.cookies[0]?.httpOnly);
        const cookie = nonce.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        const token = nonce.json<{ data: { token: string } }>().data.token;
        const headers = { origin: config.FRONTEND_ORIGIN, cookie, 'x-csrf-token': token };
        const cross = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/logout',
            headers: { ...headers, origin: 'https://evil.test' },
        });
        assert.equal(cross.statusCode, 403);
        const invalid = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            headers,
            payload: { email: 'invalid', password: '1', role: 'admin' },
        });
        assert.equal(invalid.statusCode, 400);
        const unavailable = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            headers,
            payload: { email: 'admin@meal-planner.test', password: '1' },
        });
        assert.equal(unavailable.statusCode, 503);
        assert.equal(unavailable.body.includes(config.SECURITY_KEY!), false);
        const malformed = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            headers: { ...headers, 'content-type': 'application/json' },
            payload: '{oops',
        });
        assert.equal(malformed.statusCode, 400);
        assert.equal(malformed.json<{ error: { code: string } }>().error.code, 'INVALID_REQUEST');
        assert.equal(
            loginSchema.safeParse({ email: 'admin@meal-planner.test', password: '1', role: 'admin' }).success,
            false,
        );
    } finally {
        await app.close();
    }
});
await test('trust proxy requires an explicit address allowlist', () => {
    assert.throws(() => readConfig({ TRUSTED_PROXY_CIDRS: 'true' }));
    assert.deepEqual(readConfig({ TRUSTED_PROXY_CIDRS: '127.0.0.1,::1/128' }).TRUSTED_PROXY_CIDRS, [
        '127.0.0.1',
        '::1/128',
    ]);
});
