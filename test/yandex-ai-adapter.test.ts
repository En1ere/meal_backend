import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    YANDEX_AI_ENDPOINT,
    YandexAiAdapter,
    readYandexAiAdapterConfig,
    type FrozenProviderRequest,
} from '../src/modules/ai/public.js';

const apiKeyFile = fileURLToPath(new URL('../../test/fixtures/yandex-ai-key.txt', import.meta.url));
const clientRequestId = '018f2dd4-693f-7c4c-8b5d-c50d951f4f47';

const completeEnv = {
    YANDEX_AI_ENABLED: 'false',
    YANDEX_AI_STORE_FALSE_READBACK_VERIFIED: 'true',
    YANDEX_AI_API_KEY_FILE: apiKeyFile,
    YANDEX_AI_ENDPOINT,
    YANDEX_AI_FOLDER_ID: 'b1g1234567890abcdefg',
    YANDEX_AI_SERVICE_ACCOUNT_ID: 'aje1234567890abcdefg',
    YANDEX_AI_ECONOMY_PROFILE_VERSION: 'yandex-alice-flash-economy-v1',
    YANDEX_AI_BALANCED_PROFILE_VERSION: 'yandexgpt-5.1-balanced-v1',
    YANDEX_AI_MONTHLY_BUDGET_RUB: '1000.00',
} satisfies NodeJS.ProcessEnv;

const request: FrozenProviderRequest = {
    clientRequestId,
    profileVersion: 'yandex-alice-flash-economy-v1',
    instructions: 'Return only the requested JSON.',
    input: 'Question',
    maxOutputTokens: 100,
    resultSchema: {
        name: 'meal_result_v2',
        schema: {
            type: 'object',
            additionalProperties: false,
            properties: { answer: { type: 'string' } },
            required: ['answer'],
        },
    },
};

void test('Yandex config is fail closed and an API key alone never enables the adapter', () => {
    assert.equal(readYandexAiAdapterConfig({}).readiness, 'unconfigured');
    assert.equal(readYandexAiAdapterConfig({ YANDEX_AI_API_KEY_FILE: apiKeyFile }).readiness, 'unconfigured');
    assert.equal(readYandexAiAdapterConfig(completeEnv).readiness, 'disabled');
    assert.equal(readYandexAiAdapterConfig({ ...completeEnv, YANDEX_AI_ENABLED: 'true' }).readiness, 'ready');
    assert.equal(
        readYandexAiAdapterConfig({
            ...completeEnv,
            YANDEX_AI_ENABLED: 'true',
            YANDEX_AI_STORE_FALSE_READBACK_VERIFIED: 'false',
        }).readiness,
        'unconfigured',
    );
    assert.throws(() => readYandexAiAdapterConfig({ YANDEX_AI_API_KEY: 'inline-secret' }), /must use/);
    assert.throws(
        () => readYandexAiAdapterConfig({ ...completeEnv, YANDEX_AI_ENDPOINT: 'https://example.test/v1/' }),
        /Invalid input/,
    );
});

void test('disabled adapter rejects without a provider call and exposes no secret', async () => {
    let calls = 0;
    const config = readYandexAiAdapterConfig(completeEnv);
    const adapter = new YandexAiAdapter(config, () => {
        calls += 1;
        return Promise.resolve(new Response());
    });
    assert.deepEqual(await adapter.submit(request), {
        kind: 'rejected',
        category: 'provider_disabled',
        retryable: false,
    });
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(adapter.status()).includes('test-only-provider-credential'), false);
});

void test('adapter submits one bounded store-false structured request and reads success', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
        new Response(JSON.stringify({ id: 'response-1', status: 'queued' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }),
        new Response(
            JSON.stringify({
                id: 'response-1',
                status: 'completed',
                output: [{ type: 'message', content: [{ type: 'output_text', text: '{"answer":"ok"}' }] }],
                usage: {
                    input_tokens: 10,
                    output_tokens: 4,
                    input_tokens_details: { cached_tokens: 2 },
                    output_tokens_details: { reasoning_tokens: 1 },
                },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ];
    const adapter = new YandexAiAdapter(
        readYandexAiAdapterConfig({ ...completeEnv, YANDEX_AI_ENABLED: 'true' }),
        (url, init) => {
            calls.push({ url: url instanceof Request ? url.url : url.toString(), init });
            return Promise.resolve(responses.shift()!);
        },
    );
    assert.deepEqual(await adapter.submit(request), {
        kind: 'accepted',
        providerResponseId: 'response-1',
        clientRequestId,
    });
    assert.deepEqual(await adapter.read('response-1'), {
        kind: 'succeeded',
        rawResult: { answer: 'ok' },
        usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, reasoningTokens: 1 },
    });
    assert.equal(calls[0]?.url, `${YANDEX_AI_ENDPOINT}responses`);
    assert.equal(calls[1]?.url, `${YANDEX_AI_ENDPOINT}responses/response-1`);
    const requestBody = calls[0]?.init?.body;
    assert.equal(typeof requestBody, 'string');
    const body = JSON.parse(requestBody as string) as Record<string, unknown>;
    assert.equal(body.store, false);
    assert.equal(body.background, true);
    assert.equal(body.conversation, null);
    assert.equal(body.model, 'gpt://b1g1234567890abcdefg/aliceai-llm-flash');
    assert.equal((calls[0]?.init?.headers as Record<string, string>)['x-client-request-id'], clientRequestId);
});

void test('adapter maps confirmed rejection, timeout and missing identity without retrying', async () => {
    const enabled = readYandexAiAdapterConfig({ ...completeEnv, YANDEX_AI_ENABLED: 'true' });
    assert.deepEqual(
        await new YandexAiAdapter(enabled, () => Promise.resolve(new Response('{}', { status: 400 }))).submit(request),
        { kind: 'rejected', category: 'request_invalid', retryable: false },
    );
    assert.deepEqual(
        await new YandexAiAdapter(enabled, () => Promise.reject(new Error('private transport failure'))).submit(
            request,
        ),
        { kind: 'unknown_without_identity', clientRequestId },
    );
    assert.deepEqual(
        await new YandexAiAdapter(enabled, () => Promise.resolve(new Response('{}', { status: 503 }))).submit(request),
        { kind: 'unknown_without_identity', clientRequestId },
    );
    assert.deepEqual(
        await new YandexAiAdapter(enabled, () => Promise.resolve(new Response('not-json', { status: 200 }))).submit(
            request,
        ),
        { kind: 'unknown_without_identity', clientRequestId },
    );
    assert.deepEqual(
        await new YandexAiAdapter(enabled, () =>
            Promise.resolve(new Response(JSON.stringify({ status: 'queued' }), { status: 200 })),
        ).submit(request),
        { kind: 'unknown_without_identity', clientRequestId },
    );
});

void test('readback fails closed for transport and malformed structured output', async () => {
    const enabled = readYandexAiAdapterConfig({ ...completeEnv, YANDEX_AI_ENABLED: 'true' });
    assert.deepEqual(
        await new YandexAiAdapter(enabled, () => Promise.reject(new Error('private transport failure'))).read(
            'response-1',
        ),
        { kind: 'unknown' },
    );
    assert.deepEqual(
        await new YandexAiAdapter(enabled, () =>
            Promise.resolve(
                new Response(
                    JSON.stringify({
                        id: 'response-1',
                        status: 'completed',
                        output: [{ type: 'message', content: [{ type: 'output_text', text: 'not-json' }] }],
                    }),
                    { status: 200 },
                ),
            ),
        ).read('response-1'),
        { kind: 'failed', category: 'invalid_structured_result' },
    );
});
