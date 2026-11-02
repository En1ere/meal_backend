import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { scanPreviewSchema } from '../dist/src/modules/inventory-ingest/ingest.contracts.js';

const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maximumBytes = 10 * 1024 * 1024;
const host = process.env.OCR_PREVIEW_HOST ?? '0.0.0.0';
const port = Number(process.env.OCR_PREVIEW_PORT ?? '3100');
const timeoutMs = Number(process.env.OCR_PREVIEW_TIMEOUT_MS ?? '60000');
const tokenFile = process.env.OCR_PREVIEW_TOKEN_FILE;
const modelsPath = resolve(process.env.OCR_MODELS_PATH ?? 'resources/ocr');

if (
    process.env.NODE_ENV !== 'production' ||
    host !== '0.0.0.0' ||
    port !== 3100 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 120_000 ||
    !tokenFile ||
    !isAbsolute(tokenFile)
)
    throw new Error('ocr_preview_invalid_configuration');

const token = (await readFile(tokenFile, 'utf8')).replace(/\r?\n$/, '');
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('ocr_preview_invalid_token');
const tokenBytes = Buffer.from(token);

const manifest = JSON.parse(await readFile(join(modelsPath, 'models.manifest.json'), 'utf8'));
if (
    !manifest ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 2 ||
    manifest.files.some(
        (entry) =>
            !entry ||
            !['rus.traineddata', 'eng.traineddata'].includes(entry.name) ||
            !/^[a-f0-9]{64}$/.test(entry.sha256),
    ) ||
    new Set(manifest.files.map((entry) => entry.name)).size !== 2
)
    throw new Error('ocr_preview_invalid_model_manifest');
for (const entry of manifest.files) {
    const bytes = await readFile(join(modelsPath, entry.name));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
        throw new Error('ocr_preview_model_checksum_mismatch');
}

let active = false;
let activeWorker = null;
let stopping = false;

function send(response, status, payload) {
    if (response.destroyed || response.headersSent) return;
    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.byteLength),
        'cache-control': 'no-store',
    });
    response.end(body);
}

function authorized(header) {
    if (typeof header !== 'string' || header.length !== token.length) return false;
    const candidate = Buffer.from(header);
    return candidate.byteLength === tokenBytes.byteLength && timingSafeEqual(candidate, tokenBytes);
}

async function readExactBody(request, declaredLength) {
    const chunks = [];
    let total = 0;
    for await (const value of request) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        total += chunk.byteLength;
        if (total > maximumBytes || total > declaredLength) throw new Error('invalid_body_length');
        chunks.push(chunk);
    }
    if (total !== declaredLength) throw new Error('invalid_body_length');
    return Buffer.concat(chunks, total);
}

function recognize(bytes, mimeType, request) {
    return new Promise((resolveResult, rejectResult) => {
        const worker = new Worker(new URL('../dist/src/modules/inventory-ingest/ingest.worker.js', import.meta.url), {
            workerData: {
                kind: 'scan',
                files: [{ filename: 'preview', mimetype: mimeType, bytes }],
                limits: {
                    fileBytes: maximumBytes,
                    photos: 1,
                    pixels: 12_000_000,
                    rows: 1,
                    sheets: 1,
                    columns: 1,
                    expandedBytes: maximumBytes,
                    timeoutMs,
                },
                models: modelsPath,
            },
            resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
        });
        activeWorker = worker;
        let done = false;
        const finish = (error, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            request.off('aborted', abort);
            activeWorker = null;
            void worker.terminate();
            if (error) rejectResult(error);
            else resolveResult(value);
        };
        const abort = () => finish(new Error('request_aborted'));
        const timer = setTimeout(() => finish(new Error('worker_timeout')), timeoutMs);
        request.once('aborted', abort);
        worker.once('message', (message) => {
            if (!message || message.ok !== true) return finish(new Error('invalid_image'));
            const parsed = scanPreviewSchema.safeParse(message.data);
            if (!parsed.success || parsed.data.images.length !== 1) return finish(new Error('invalid_worker_response'));
            const image = parsed.data.images[0];
            finish(null, {
                text: image.text,
                confidence: image.confidence,
                requiresReview: true,
                warnings: parsed.data.warnings,
            });
        });
        worker.once('error', () => finish(new Error('worker_failed')));
        worker.once('exit', () => {
            if (!done) finish(new Error('worker_exited'));
        });
    });
}

const server = createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    if (request.method === 'GET' && request.url === '/healthz') {
        send(response, stopping ? 503 : 200, { status: stopping ? 'stopping' : 'ok' });
        return;
    }
    if (request.method !== 'POST' || request.url !== '/recognize') {
        send(response, 404, { code: 'NOT_FOUND' });
        return;
    }
    if (!authorized(request.headers['x-ocr-preview-token'])) {
        response.setHeader('connection', 'close');
        send(response, 401, { code: 'UNAUTHORIZED' });
        return;
    }
    if (stopping || active) {
        response.setHeader('connection', 'close');
        send(response, 503, { code: 'OCR_BUSY' });
        return;
    }
    const mimeType = request.headers['content-type'];
    const rawLength = request.headers['content-length'];
    if (
        typeof mimeType !== 'string' ||
        !allowedMimeTypes.has(mimeType) ||
        typeof rawLength !== 'string' ||
        !/^\d+$/.test(rawLength) ||
        request.headers['transfer-encoding']
    ) {
        response.setHeader('connection', 'close');
        send(response, 415, { code: 'OCR_INPUT_REJECTED' });
        return;
    }
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > maximumBytes) {
        response.setHeader('connection', 'close');
        send(response, 413, { code: 'OCR_INPUT_REJECTED' });
        return;
    }
    active = true;
    try {
        const bytes = await readExactBody(request, declaredLength);
        const result = await recognize(bytes, mimeType, request);
        send(response, 200, result);
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'worker_timeout') send(response, 504, { code: 'OCR_TIMEOUT' });
        else if (message !== 'request_aborted') send(response, 422, { code: 'OCR_INPUT_REJECTED' });
    } finally {
        active = false;
    }
});

for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        server.close(() => process.exit(0));
        if (activeWorker) void activeWorker.terminate();
        setTimeout(() => process.exit(1), 5_000).unref();
    });

server.headersTimeout = 10_000;
server.requestTimeout = timeoutMs + 5_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 10;
server.listen(port, host, () => console.log('ocr_preview ready'));
