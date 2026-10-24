import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { createApp } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';
import { AuthService, type Principal } from '../src/modules/auth/auth.service.js';
import { AdminReadService } from '../src/modules/admin/admin-read.service.js';
import { AdminAccessService } from '../src/modules/admin-auth/admin-access.service.js';
import {
    adminPageSchema,
    adminDetailSchema,
    adminSectionSchema,
    adminRelatedPageSchema,
} from '../src/modules/admin/admin-read.contracts.js';
import { adminRelatedSources } from '../src/modules/admin/admin-related.sources.js';
import { AdminActionsService } from '../src/modules/admin-actions/admin-actions.service.js';
import {
    notificationSettingsSchema,
    supportCommandResultSchema,
    supportMessagesSchema,
} from '../src/modules/admin-actions/admin-actions.contracts.js';

await test('all 17 administrative read routes validate envelopes and reject unauthorized/unsupported/input-injected access', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config),
        auth = app.get(AuthService),
        read = app.get(AdminReadService);
    app.get(AdminAccessService).principal = (token) => auth.principal(token, 'staff');
    const id = randomUUID();
    const principal: Principal = {
        id,
        sessionId: randomUUID(),
        context: 'admin',
        displayName: 'Admin',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    auth.principal = (token) => {
        if (!token) return Promise.reject(new UnauthorizedException());
        return Promise.resolve({ ...principal, context: token === 'moderator' ? 'moderator' : 'admin' });
    };
    const item = {
        id,
        title: 'Record',
        status: null,
        updatedAt: null,
        version: '1',
        fields: [],
        related: [],
        actions: [],
    };
    let searches = 0;
    read.search = (section, _input, actor) => {
        assert.equal(actor.id, id);
        searches++;
        if (section === 'overview')
            return Promise.resolve({
                section,
                availability: 'available' as const,
                reason: 'Overview',
                items: [item],
                nextCursor: null,
            });
        return Promise.resolve({ section, availability: 'available', reason: null, items: [item], nextCursor: null });
    };
    read.detail = (section) => {
        if (section === 'overview') throw new Error('No overview detail');
        return Promise.resolve({ section, item, collections: [] });
    };
    let relatedReads = 0;
    read.related = (_section, parentId, _collection, input, actor) => {
        assert.equal(parentId, id);
        assert.equal(actor.id, id);
        assert.equal(input.limit, 25);
        relatedReads++;
        return Promise.resolve({ items: [item], nextCursor: null });
    };
    try {
        const csrf = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' });
        const cookie = csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        const headers = {
            origin: config.ADMIN_FRONTEND_ORIGIN!,
            cookie: `${cookie}; meal_admin=valid`,
            'x-csrf-token': csrf.json<{ data: { token: string } }>().data.token,
        };
        for (const section of adminSectionSchema.options) {
            const response = await app.inject({
                method: 'POST',
                url: `/api/v1/admin/${section}/search`,
                headers,
                payload: {},
            });
            assert.equal(response.statusCode, 200, section);
            const result = response.json<{ data: unknown; meta: { requestId: string } }>();
            assert.equal(adminPageSchema.parse(result.data).section, section);
            assert.ok(result.meta.requestId);
            if (section !== 'overview') {
                const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/${section}/${id}`, headers });
                assert.equal(detail.statusCode, 200);
                assert.equal(adminDetailSchema.parse(detail.json<{ data: unknown }>().data).item.id, id);
            }
        }
        assert.equal(searches, 17);
        for (const [section, collections] of Object.entries(adminRelatedSources)) {
            for (const collection of Object.keys(collections)) {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/v1/admin/${section}/${id}/related/${collection}/search`,
                    headers,
                    payload: { limit: 25 },
                });
                assert.equal(response.statusCode, 200, `${section}/${collection}`);
                assert.equal(adminRelatedPageSchema.parse(response.json<{ data: unknown }>().data).items[0]?.id, id);
            }
        }
        assert.equal(relatedReads, 34);
        assert.equal(
            (
                await app.inject({
                    method: 'POST',
                    url: `/api/v1/admin/payments/${id}/related/attempts/search`,
                    headers,
                    payload: { limit: 51 },
                })
            ).statusCode,
            400,
        );
        assert.equal(relatedReads, 34);
        for (const payload of [{ limit: 51 }, { query: 'x'.repeat(101) }, { table: 'users' }, { limit: 1.5 }]) {
            const result = await app.inject({ method: 'POST', url: '/api/v1/admin/users/search', headers, payload });
            assert.equal(result.statusCode, 400);
        }
        assert.equal(
            (await app.inject({ method: 'POST', url: '/api/v1/admin/passwords/search', headers, payload: {} }))
                .statusCode,
            400,
        );
        assert.equal(
            (await app.inject({ method: 'GET', url: '/api/v1/admin/users/not-uuid', headers })).statusCode,
            400,
        );
        assert.equal(
            (
                await app.inject({
                    method: 'POST',
                    url: '/api/v1/admin/users/search',
                    headers: { ...headers, cookie },
                    payload: {},
                })
            ).statusCode,
            401,
        );
        assert.equal(
            (
                await app.inject({
                    method: 'POST',
                    url: '/api/v1/admin/users/search',
                    headers: { ...headers, cookie: `${cookie}; meal_admin=moderator` },
                    payload: {},
                })
            ).statusCode,
            403,
        );
        assert.equal(
            (await app.inject({ method: 'POST', url: `/api/v1/admin/users/${id}/delete`, headers, payload: {} }))
                .statusCode,
            404,
        );
        assert.equal(searches, 17);
    } finally {
        await app.close();
    }
});

await test('administrative command HTTP schemas preserve preferences/support envelopes and reject forged fields before service', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config),
        auth = app.get(AuthService),
        actions = app.get(AdminActionsService);
    app.get(AdminAccessService).principal = (token) => auth.principal(token, 'staff');
    const id = randomUUID(),
        key = randomUUID();
    auth.principal = () =>
        Promise.resolve({
            id,
            sessionId: randomUUID(),
            context: 'admin',
            displayName: 'Admin',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
        });
    let calls = 0;
    actions.preferences = (_actor, _requestId, change) => {
        calls++;
        return Promise.resolve({
            preferences: { browser: change?.channel === 'browser' && change.enabled, mobilePush: false, email: false },
            verifiedEmail: 'admin@example.test',
        });
    };
    actions.support = (ticketId, kind, input) => {
        calls++;
        assert.equal(input.idempotencyKey, key);
        return Promise.resolve({
            ticketId,
            status: kind === 'reply' ? 'waiting_for_user' : 'waiting_for_support',
            version: '2',
            assigneeId: id,
            messageId: kind === 'reply' ? randomUUID() : null,
        });
    };
    actions.messages = () => Promise.resolve({ items: [], nextCursor: null });
    try {
        const csrf = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' });
        const headers = {
            origin: config.ADMIN_FRONTEND_ORIGIN!,
            cookie: `${csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; ')}; meal_admin=valid`,
            'x-csrf-token': csrf.json<{ data: { token: string } }>().data.token,
        };
        for (const method of ['GET', 'POST'] as const) {
            const response = await app.inject({
                method,
                url: '/api/v1/admin/notification-preferences',
                headers,
                ...(method === 'POST' ? { payload: { channel: 'browser', enabled: true } } : {}),
            });
            assert.equal(response.statusCode, 200);
            assert.equal(
                notificationSettingsSchema.parse(response.json<{ data: unknown }>().data).preferences.browser,
                method === 'POST',
            );
        }
        for (const kind of ['reply', 'reopen']) {
            const response = await app.inject({
                method: 'POST',
                url: `/api/v1/admin/support/${id}/${kind}`,
                headers,
                payload: { version: '1', idempotencyKey: key, ...(kind === 'reply' ? { body: ' Answer ' } : {}) },
            });
            assert.equal(response.statusCode, 200);
            assert.equal(supportCommandResultSchema.parse(response.json<{ data: unknown }>().data).ticketId, id);
        }
        const messages = await app.inject({
            method: 'POST',
            url: `/api/v1/admin/support/${id}/messages/search`,
            headers,
            payload: {},
        });
        assert.equal(messages.statusCode, 200);
        assert.deepEqual(supportMessagesSchema.parse(messages.json<{ data: unknown }>().data).items, []);
        for (const payload of [
            { body: ' ', version: '1', idempotencyKey: key },
            { body: 'Answer', version: '1', idempotencyKey: key, authorId: id },
        ])
            assert.equal(
                (await app.inject({ method: 'POST', url: `/api/v1/admin/support/${id}/reply`, headers, payload }))
                    .statusCode,
                400,
            );
        assert.equal(
            (
                await app.inject({
                    method: 'POST',
                    url: '/api/v1/admin/notification-preferences',
                    headers,
                    payload: { channel: 'email', enabled: true, userId: id },
                })
            ).statusCode,
            400,
        );
        assert.equal(calls, 4);
    } finally {
        await app.close();
    }
});
