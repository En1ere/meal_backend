import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { scanPreviewSchema } from '../src/modules/inventory-ingest/ingest.contracts.js';
import { OcrPreviewClientError, requestOcrPreview } from '../src/modules/inventory-ingest/ocr-preview.client.js';

void test('OCR preview contract always requires manual review', () => {
    const value = {
        images: [{ filename: 'receipt.jpg', text: 'Молоко milk', confidence: 87 }],
        warnings: ['Проверьте результат'],
        requiresReview: true,
    } as const;
    assert.deepEqual(scanPreviewSchema.parse(value), value);
    assert.equal(scanPreviewSchema.safeParse({ ...value, requiresReview: false }).success, false);
    assert.equal(scanPreviewSchema.safeParse({ images: value.images, warnings: value.warnings }).success, false);
});

void test('OCR preview client sends one bounded authenticated image and validates a strict response', async () => {
    const originalFetch = globalThis.fetch;
    let observed = false;
    globalThis.fetch = (input, init) => {
        observed = true;
        const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        assert.equal(requestUrl, 'http://ocr-preview:3100/recognize');
        assert.equal(init?.method, 'POST');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('content-type'), 'image/png');
        assert.equal(headers.get('content-length'), '4');
        assert.equal(headers.get('x-ocr-preview-token'), 'b'.repeat(64));
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    text: 'Молоко milk',
                    confidence: 91,
                    requiresReview: true,
                    warnings: ['Проверьте результат'],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        );
    };
    try {
        const result = await requestOcrPreview(
            { url: 'http://ocr-preview:3100', token: 'b'.repeat(64), timeoutMs: 5_000 },
            { bytes: Buffer.from([1, 2, 3, 4]), mimeType: 'image/png' },
        );
        assert.equal(observed, true);
        assert.equal(result.requiresReview, true);
        assert.equal(result.text, 'Молоко milk');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

void test('OCR preview client rejects busy, malformed and review-bypassing responses', async () => {
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = () => Promise.resolve(new Response('{"code":"OCR_BUSY"}', { status: 503 }));
        await assert.rejects(
            requestOcrPreview(
                { url: 'http://ocr-preview:3100', token: 'c'.repeat(64), timeoutMs: 5_000 },
                { bytes: Buffer.from([1]), mimeType: 'image/jpeg' },
            ),
            (error: unknown) => error instanceof OcrPreviewClientError && error.code === 'busy',
        );
        globalThis.fetch = () =>
            Promise.resolve(
                new Response(JSON.stringify({ text: 'x', confidence: 1, requiresReview: false, warnings: [] }), {
                    status: 200,
                }),
            );
        await assert.rejects(
            requestOcrPreview(
                { url: 'http://ocr-preview:3100', token: 'c'.repeat(64), timeoutMs: 5_000 },
                { bytes: Buffer.from([1]), mimeType: 'image/jpeg' },
            ),
            (error: unknown) => error instanceof OcrPreviewClientError && error.code === 'invalid_response',
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

void test('checked-in RU and EN OCR models match the immutable local manifest', async () => {
    const manifest = JSON.parse(await readFile('resources/ocr/models.manifest.json', 'utf8')) as {
        files: { name: string; sha256: string }[];
    };
    assert.deepEqual(manifest.files.map((entry) => entry.name).sort(), ['eng.traineddata', 'rus.traineddata']);
    for (const entry of manifest.files) {
        const bytes = await readFile(`resources/ocr/${entry.name}`);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    }
});

void test('Compose and runtime keep OCR preview isolated, authenticated and resource bounded', async () => {
    const [compose, common, verify, bootstrap, disable, server, dockerfile] = await Promise.all(
        [
            'deploy/compose.ocr-preview.yml',
            'deploy/common.sh',
            'deploy/verify.sh',
            'deploy/bootstrap-ocr-preview.sh',
            'deploy/disable-ocr-preview.sh',
            'scripts/run-ocr-preview-server.mjs',
            'Dockerfile',
        ].map((path) => readFile(path, 'utf8')),
    );
    if (!compose || !common || !verify || !bootstrap || !disable || !server || !dockerfile)
        throw new Error('OCR preview deployment files are missing');
    assert.match(compose, /internal: true/);
    assert.match(compose, /mem_limit: 512m/);
    assert.match(compose, /pids_limit: 64/);
    assert.match(compose, /cpus: 0\.75/);
    assert.match(compose, /read_only: true/);
    assert.match(compose, /cap_drop: \[ALL\]/);
    assert.match(compose, /OCR_PREVIEW_TOKEN_FILE: \/run\/secrets\/ocr_preview_token/);
    assert.doesNotMatch(compose, /ports:/);
    assert.doesNotMatch(compose, /meal-db|meal-egress|meal-media/);
    assert.match(common, /OCR_PREVIEW_ENABLED:-false/);
    assert.match(verify, /OCR preview must use only its private network/);
    assert.match(bootstrap, /openssl rand -hex 32/);
    assert.match(disable, /compose rm -f ocr-preview/);
    assert.match(server, /timingSafeEqual/);
    assert.match(server, /request\.headers\['transfer-encoding'\]/);
    assert.match(server, /maxOldGenerationSizeMb: 192/);
    assert.match(server, /models\.manifest\.json/);
    assert.match(dockerfile, /scripts\/run-ocr-preview-server\.mjs/);
});
