import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AdminAccessService } from '../src/modules/admin-auth/admin-access.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { createApp, openApiDocument } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';
import {
    createdResponseOperationIds,
    envelope,
    responseDataSchemas,
    errorEnvelopeSchema,
} from '../src/shared/http/openapi-responses.js';

await test('real HTTP success/errors conform to the schemas used in OpenAPI', async () => {
    const app = await createApp(readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
    try {
        const live = await app.inject({ method: 'GET', url: '/health/live' });
        assert.equal(envelope(responseDataSchemas.health).safeParse(live.json<unknown>()).success, true);
        const ready = await app.inject({ method: 'GET', url: '/health/ready' });
        assert.equal(errorEnvelopeSchema.safeParse(ready.json<unknown>()).success, true);
        const document = openApiDocument(app);
        assert.ok(Object.keys(document.paths).length >= 121);
        assert.ok(document.paths['/api/v1/ai/tasks/{id}']);
        assert.ok(document.paths['/api/v1/ai/tasks/{id}/messages']);
        assert.ok(document.paths['/api/v1/admin/free-ai/users/{id}']);
        assert.ok(document.paths['/api/v1/admin/free-ai/users/{id}/grants']);
        // Isolate HTTP guard wiring from the deliberately unavailable PostgreSQL.
        app.get(AdminAccessService).principal = () => Promise.reject(new UnauthorizedException());
        for (const path of [
            '/api/v1/admin/news-workspace',
            '/api/v1/admin/notification-center',
            '/api/v1/admin/governance/users/00000000-0000-4000-8000-000000000001',
            '/api/v1/admin/billing/users/00000000-0000-4000-8000-000000000001',
            '/api/v1/admin/content-workspace/queues/00000000-0000-4000-8000-000000000001',
            '/api/v1/admin/review-workspace/legal-requests/00000000-0000-4000-8000-000000000001',
        ]) {
            const response = await app.inject({ method: 'GET', url: path });
            assert.equal(response.statusCode, 401, path);
            assert.equal(errorEnvelopeSchema.safeParse(response.json<unknown>()).success, true, path);
        }
        for (const item of Object.values(document.paths))
            for (const method of ['get', 'post', 'put', 'patch'] as const) {
                const operation = item[method];
                if (!operation) continue;
                const successStatus = createdResponseOperationIds.has(operation.operationId ?? '') ? '201' : '200';
                assert.ok(operation.responses[successStatus], `${operation.operationId}: ${successStatus}`);
                assert.equal(operation.responses[successStatus === '201' ? '200' : '201'], undefined);
                assert.ok(operation.responses['401']);
                assert.ok(operation.responses['503']);
                if (method !== 'get')
                    assert.ok(
                        operation.parameters?.some(
                            (parameter) => 'name' in parameter && parameter.name === 'X-CSRF-Token',
                        ),
                    );
            }
        assert.ok(document.components?.securitySchemes?.meal_user);
        assert.ok(document.components?.securitySchemes?.meal_staff);
        assert.ok(document.components?.securitySchemes?.meal_admin);
    } finally {
        await app.close();
    }
});

await test('bulk import alone accepts a bounded payload above the ordinary JSON limit', async () => {
    const app = await createApp(readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
    try {
        const payload = { padding: 'x'.repeat(70000) };
        const ordinary = await app.inject({ method: 'POST', url: '/api/v1/inventory', payload });
        assert.equal(ordinary.statusCode, 413);
        const bulk = await app.inject({ method: 'POST', url: '/api/v1/inventory/import/commit', payload });
        // It reaches the authentication boundary, not a database or mutation.
        assert.ok([401, 403, 503].includes(bulk.statusCode), String(bulk.statusCode));
        const oversized = await app.inject({
            method: 'POST',
            url: '/api/v1/inventory/import/commit',
            payload: { padding: 'x'.repeat(8388608) },
        });
        assert.equal(oversized.statusCode, 413);
    } finally {
        await app.close();
    }
});

await test('multipart import normalizes an invalid content type to documented HTTP 415', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config);
    app.get(AuthService).principal = () =>
        Promise.resolve({
            id: '00000000-0000-4000-8000-000000000001',
            sessionId: '00000000-0000-4000-8000-000000000002',
            context: 'user',
            displayName: 'Test',
            expiresAt: '2099-01-01T00:00:00.000Z',
        });
    try {
        const csrf = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
        const csrfCookie = csrf.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
        const response = await app.inject({
            method: 'POST',
            url: '/api/v1/inventory/ingest/import',
            headers: {
                origin: config.FRONTEND_ORIGIN,
                cookie: `${csrfCookie}; meal_user=fixture`,
                'x-csrf-token': csrf.json<{ data: { token: string } }>().data.token,
            },
            payload: {},
        });
        assert.equal(response.statusCode, 415, response.body);
        assert.equal(response.json<{ error: { code: string } }>().error.code, 'UNSUPPORTED_MEDIA_TYPE');
        assert.equal(errorEnvelopeSchema.safeParse(response.json<unknown>()).success, true);
    } finally {
        await app.close();
    }
});
