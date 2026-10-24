import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import cases from '../contracts/http-cases.json' with { type: 'json' };
import { createApp } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';
import { errorEnvelopeSchema } from '../src/shared/http/openapi-responses.js';

await test('portable backend/mock HTTP cases: validation and CSRF precedence without database', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config);
    try {
        const csrf = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
        const cookie = csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        const token = csrf.json<{ data: { token: string } }>().data.token;
        for (const item of cases) {
            const response = await app.inject({
                method: item.method as 'GET' | 'POST',
                url: item.path,
                headers: { origin: config.FRONTEND_ORIGIN, ...(item.csrf ? { cookie, 'x-csrf-token': token } : {}) },
                ...(item.body ? { payload: item.body } : {}),
            });
            assert.equal(response.statusCode, item.status, item.name);
            if (item.code)
                assert.equal(errorEnvelopeSchema.parse(response.json<unknown>()).error.code, item.code, item.name);
        }
    } finally {
        await app.close();
    }
});
