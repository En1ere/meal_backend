import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, openApiDocument } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';

await test('health, envelope, request ID, missing database and CORS are distinct', async () => {
    const app = await createApp(readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
    try {
        const response = await app.inject({ method: 'GET', url: '/health/live' });
        assert.equal(response.statusCode, 200);
        const body = response.json<{ data: { status: string }; meta: { requestId: string } }>();
        assert.equal(body.data.status, 'ok');
        assert.equal(body.meta.requestId, response.headers['x-request-id']);
        assert.equal(response.headers['cache-control'], 'no-store');
        const unavailable = await app.inject({ method: 'GET', url: '/health/ready' });
        assert.equal(unavailable.statusCode, 503);
        assert.equal(unavailable.json<{ error: { code: string } }>().error.code, 'UNAVAILABLE');
        const missing = await app.inject({ method: 'GET', url: '/api/v1/not-existing' });
        assert.equal(missing.statusCode, 404);
        assert.equal(missing.json<{ error: { code: string } }>().error.code, 'NOT_FOUND');
        const untrusted = await app.inject({
            method: 'GET',
            url: '/health/live',
            headers: { origin: 'https://untrusted.test' },
        });
        assert.notEqual(untrusted.headers['access-control-allow-origin'], 'https://untrusted.test');
        const document = openApiDocument(app);
        assert.ok(document.paths['/health/live']);
        assert.ok(document.paths['/health/ready']);
    } finally {
        await app.close();
    }
});

await test('invalid deployment configuration fails before startup without secret disclosure', () => {
    assert.throws(() => readConfig({ PORT: '-1' }), /PORT/);
    assert.throws(() => readConfig({ NODE_ENV: 'production' }), /Production/);
    assert.throws(() => readConfig({ FRONTEND_ORIGIN: 'http://localhost:3000/path' }), /origin/);
    assert.throws(
        () => readConfig({ DATABASE_URL: 'postgres://user:secret@localhost/wrong' }),
        (error: unknown) => {
            return error instanceof Error && !error.message.includes('secret');
        },
    );
});
