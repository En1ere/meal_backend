import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, openApiDocument } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';
import { errorEnvelopeSchema } from '../src/shared/http/openapi-responses.js';

const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const registeredPath = (path: string) => path.replaceAll(/\{([^}]+)\}/g, ':$1');
const requestPath = (path: string) =>
    path.replaceAll(/\{([^}]+)\}/g, (_match, name: string) => {
        if (name === 'queue') return 'recipes';
        if (name === 'username') return 'pro1';
        if (name === 'token') return 'invalid-token';
        return '00000000-0000-4000-8000-000000000001';
    });
const invalidRequestPath = (path: string) =>
    path.replaceAll(/\{([^}]+)\}/g, (_match, name: string) => {
        if (name === 'username') return '!';
        if (name === 'token' || name === 'code') return 'invalid';
        return 'not-a-valid-parameter';
    });

const requestAddress = (index: number) => `198.18.${Math.floor(index / 250)}.${(index % 250) + 1}`;

const cookieFrom = (value: string | string[] | undefined) => {
    const first = Array.isArray(value) ? value[0] : value;
    assert.ok(first, 'CSRF bootstrap did not set a cookie');
    return first.split(';', 1)[0];
};

await test('every OpenAPI operation is registered and reaches documented defensive HTTP boundaries', async () => {
    const app = await createApp(
        readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', SECURITY_KEY: 'test-security-key-'.padEnd(43, 'x') }),
    );
    try {
        const document = openApiDocument(app);
        const server = app.getHttpAdapter().getInstance();
        const visited = new Set<string>();
        let requestIndex = 0;
        const userCsrf = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
        const adminCsrf = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' });
        const csrf = {
            user: {
                cookie: cookieFrom(userCsrf.headers['set-cookie']),
                token: userCsrf.json<{ data: { token: string } }>().data.token,
                origin: 'http://localhost:3000',
            },
            admin: {
                cookie: cookieFrom(adminCsrf.headers['set-cookie']),
                token: adminCsrf.json<{ data: { token: string } }>().data.token,
                origin: 'http://localhost:3002',
            },
        };

        for (const [path, pathItem] of Object.entries(document.paths))
            for (const method of methods) {
                const operation = pathItem?.[method];
                if (!operation) continue;
                const operationId = operation.operationId;
                assert.ok(operationId, `${method.toUpperCase()} ${path} has no operationId`);
                assert.equal(visited.has(operationId), false, `duplicate operationId ${operationId}`);
                visited.add(operationId);

                const upperMethod = method.toUpperCase() as HttpMethod;
                assert.equal(
                    server.hasRoute({ method: upperMethod, url: registeredPath(path) }),
                    true,
                    `${operationId}: route is absent from the live Fastify registry`,
                );

                const csrfContext = path.startsWith('/api/v1/admin/') ? csrf.admin : csrf.user;
                const scenarios = [
                    {
                        name: 'anonymous',
                        url: requestPath(path),
                        headers:
                            method === 'get'
                                ? { origin: csrfContext.origin }
                                : {
                                      origin: csrfContext.origin,
                                      cookie: csrfContext.cookie,
                                      'x-csrf-token': csrfContext.token,
                                  },
                    },
                    {
                        name: 'forged session cookies',
                        url: requestPath(path),
                        headers: {
                            origin: csrfContext.origin,
                            cookie: `${csrfContext.cookie}; meal_user=forged; meal_staff=forged; meal_admin=forged`,
                            ...(method === 'get' ? {} : { 'x-csrf-token': csrfContext.token }),
                        },
                    },
                    ...(path.includes('{')
                        ? [
                              {
                                  name: 'malformed path parameters',
                                  url: invalidRequestPath(path),
                                  headers:
                                      method === 'get'
                                          ? { origin: csrfContext.origin }
                                          : {
                                                origin: csrfContext.origin,
                                                cookie: csrfContext.cookie,
                                                'x-csrf-token': csrfContext.token,
                                            },
                              },
                          ]
                        : []),
                    ...(method === 'get'
                        ? []
                        : [
                              { name: 'missing CSRF origin', url: requestPath(path), headers: {} },
                              {
                                  name: 'cross-site CSRF origin',
                                  url: requestPath(path),
                                  headers: { origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site' },
                              },
                          ]),
                ];

                for (const scenario of scenarios) {
                    const response = await app.inject({
                        method: upperMethod,
                        url: scenario.url,
                        remoteAddress: requestAddress(requestIndex++),
                        headers: scenario.headers,
                        ...(method === 'get' ? {} : { payload: {} }),
                    });
                    const label: string = `${operationId} (${scenario.name})`;
                    assert.match(
                        String(response.headers['x-request-id']),
                        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
                        `${label}: missing or invalid request ID`,
                    );
                    assert.match(
                        String(response.headers['cache-control']),
                        /(?:^|,\s*)no-store(?:,|$)/i,
                        `${label}: response can be stored by an intermediary`,
                    );
                    assert.notEqual(response.statusCode, 500, `${label}: unhandled error`);
                    assert.notEqual(response.statusCode, 501, `${label}: unimplemented route`);
                    assert.ok(
                        operation.responses[String(response.statusCode)] ?? operation.responses.default,
                        `${label}: undocumented HTTP ${response.statusCode}`,
                    );
                    if (scenario.name.includes('CSRF'))
                        assert.equal(response.statusCode, 403, `${label}: mutation bypassed the global CSRF guard`);
                    if (response.statusCode >= 400)
                        assert.equal(
                            errorEnvelopeSchema.safeParse(response.json<unknown>()).success,
                            true,
                            `${label}: invalid error envelope`,
                        );
                }
            }

        assert.equal(visited.size, 351);
        assert.ok(requestIndex > 1_200, `expected a broad state matrix, got only ${requestIndex} requests`);
    } finally {
        await app.close();
    }
});
