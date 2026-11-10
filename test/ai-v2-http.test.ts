import assert from 'node:assert/strict';
import { UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createApp } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';
import { AuthService } from '../src/modules/auth/public.js';
import { errorEnvelopeSchema } from '../src/shared/http/openapi-responses.js';

type Operation = {
    operationId?: string;
    requestBody?: { content?: { 'application/json'?: { schema?: unknown } } };
    responses?: Record<string, unknown>;
};
type Document = {
    info: { version: string };
    paths: Record<string, { get?: Operation; post?: Operation }>;
};

const document = JSON.parse(await readFile('contracts/openapi.json', 'utf8')) as Document;

void test('public AI v2 exposes only the ready backend meal-plan route', () => {
    assert.equal(document.info.version, '0.0.73');
    const preview = document.paths['/api/v1/ai/v2/preview']?.post;
    const run = document.paths['/api/v1/ai/v2/run']?.post;
    const operation = document.paths['/api/v1/ai/v2/operations/{id}']?.get;
    assert.equal(preview?.operationId, 'AiV2Controller_preview');
    assert.equal(run?.operationId, 'AiV2Controller_run');
    assert.equal(operation?.operationId, 'AiV2Controller_operation');
    assert.ok(document.paths['/api/v1/ai/preview']?.post, 'legacy preview remains available');

    const request = JSON.stringify(preview?.requestBody);
    assert.match(request, /shopping_list_generation/u);
    assert.match(request, /from_meal_plan/u);
    assert.match(request, /mealPlanId/u);
    assert.doesNotMatch(request, /provider|model|prompt/u);

    const runRequest = JSON.stringify(run?.requestBody);
    assert.match(runRequest, /previewId/u);
    assert.match(runRequest, /idempotencyKey/u);
    assert.doesNotMatch(runRequest, /provider|model|familyReserve/u);
});

void test('public AI v2 responses omit internal provider and financial mechanics', () => {
    for (const operation of [
        document.paths['/api/v1/ai/v2/run']?.post,
        document.paths['/api/v1/ai/v2/operations/{id}']?.get,
    ]) {
        const response = JSON.stringify(operation?.responses?.['200']);
        assert.match(response, /shopping_list_generation/u);
        assert.match(response, /warningCodes/u);
        assert.doesNotMatch(response, /providerCostState|financialState|providerProfile|requestedModel/u);
    }
    const previewResponse = JSON.stringify(document.paths['/api/v1/ai/v2/preview']?.post?.responses?.['200']);
    assert.match(previewResponse, /ai-task-policy-v4/u);
    assert.doesNotMatch(previewResponse, /sources|provider|model/u);
});

void test('public AI v2 is protected by the user session boundary', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config);
    try {
        app.get(AuthService).principal = () => Promise.reject(new UnauthorizedException());
        const csrf = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
        const cookie = csrf.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
        const response = await app.inject({
            method: 'POST',
            url: '/api/v1/ai/v2/preview',
            headers: {
                origin: config.FRONTEND_ORIGIN,
                cookie,
                'x-csrf-token': csrf.json<{ data: { token: string } }>().data.token,
            },
            payload: {
                task: 'shopping_list_generation',
                mode: 'from_meal_plan',
                input: {
                    mealPlanId: '018f47a0-34a7-7b8d-9c10-111111111111',
                    version: 1,
                    selection: {
                        scope: 'private',
                        view: 'week',
                        date: '2026-11-10',
                        timezone: 'Asia/Yekaterinburg',
                    },
                },
            },
        });
        assert.equal(response.statusCode, 401);
        assert.equal(errorEnvelopeSchema.safeParse(response.json<unknown>()).success, true);
    } finally {
        await app.close();
    }
});
