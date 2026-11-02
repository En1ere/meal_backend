import { z } from 'zod';

const ocrPreviewResponseSchema = z.strictObject({
    text: z.string().max(20_000),
    confidence: z.number().min(0).max(100),
    requiresReview: z.literal(true),
    warnings: z.array(z.string().min(1).max(500)).max(8),
});

export type OcrPreviewResponse = z.infer<typeof ocrPreviewResponseSchema>;

export class OcrPreviewClientError extends Error {
    constructor(public readonly code: 'invalid_file' | 'busy' | 'timeout' | 'unavailable' | 'invalid_response') {
        super(`ocr_preview_${code}`);
    }
}

async function boundedJson(response: Response): Promise<unknown> {
    if (!response.body) throw new OcrPreviewClientError('invalid_response');
    const contentLength = response.headers.get('content-length');
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > 131_072))
        throw new OcrPreviewClientError('invalid_response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 131_072) {
            await reader.cancel();
            throw new OcrPreviewClientError('invalid_response');
        }
        chunks.push(value);
    }
    try {
        return JSON.parse(
            Buffer.concat(
                chunks.map((chunk) => Buffer.from(chunk)),
                total,
            ).toString('utf8'),
        );
    } catch {
        throw new OcrPreviewClientError('invalid_response');
    }
}

export async function requestOcrPreview(
    config: Readonly<{ url: string; token: string; timeoutMs: number }>,
    input: Readonly<{ bytes: Buffer; mimeType: string }>,
    requestSignal?: AbortSignal,
): Promise<OcrPreviewResponse> {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
    let response: Response;
    try {
        response = await fetch(`${config.url}/recognize`, {
            method: 'POST',
            headers: {
                'content-type': input.mimeType,
                'content-length': String(input.bytes.byteLength),
                'x-ocr-preview-token': config.token,
            },
            body: Uint8Array.from(input.bytes),
            signal,
        });
    } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError'))
            throw new OcrPreviewClientError('timeout');
        throw new OcrPreviewClientError('unavailable');
    }
    if (response.status === 409 || response.status === 429 || response.status === 503)
        throw new OcrPreviewClientError('busy');
    if (response.status === 408 || response.status === 504) throw new OcrPreviewClientError('timeout');
    if ([400, 413, 415, 422].includes(response.status)) throw new OcrPreviewClientError('invalid_file');
    if (!response.ok) throw new OcrPreviewClientError('unavailable');
    const parsed = ocrPreviewResponseSchema.safeParse(await boundedJson(response));
    if (!parsed.success) throw new OcrPreviewClientError('invalid_response');
    return parsed.data;
}
