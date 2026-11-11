import type {
    AiProviderPort,
    FrozenProviderRequest,
    ProviderFailureCategory,
    ProviderReadOutcome,
    ProviderSubmitOutcome,
} from './ai-provider-port.js';
import { frozenProviderRequestSchema } from './ai-provider-port.js';
import type { YandexAiAdapterConfig } from './yandex-ai-adapter.config.js';

type Fetch = typeof globalThis.fetch;

type YandexResponsePayload = {
    id?: unknown;
    status?: unknown;
    error?: { code?: unknown } | null;
    usage?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        input_tokens_details?: { cached_tokens?: unknown } | null;
        output_tokens_details?: { reasoning_tokens?: unknown } | null;
    } | null;
    output?: Array<{
        type?: unknown;
        content?: Array<{ type?: unknown; text?: unknown }>;
    }>;
};

const boundedTokenCount = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : 0;

function safeCategory(status: number): ProviderFailureCategory {
    if (status === 401) return 'authentication_failed';
    if (status === 403) return 'permission_denied';
    if (status === 429) return 'rate_limited';
    return 'request_invalid';
}

function outputText(payload: YandexResponsePayload) {
    return (payload.output ?? [])
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
        .map((item) => item.text as string)
        .join('\n')
        .trim();
}

function providerUsage(payload: YandexResponsePayload) {
    return {
        inputTokens: boundedTokenCount(payload.usage?.input_tokens),
        outputTokens: boundedTokenCount(payload.usage?.output_tokens),
        cachedInputTokens: boundedTokenCount(payload.usage?.input_tokens_details?.cached_tokens),
        reasoningTokens: boundedTokenCount(payload.usage?.output_tokens_details?.reasoning_tokens),
    };
}

export class YandexAiAdapter implements AiProviderPort {
    constructor(
        private readonly config: YandexAiAdapterConfig,
        private readonly fetch: Fetch = globalThis.fetch,
    ) {}

    status() {
        return {
            configured: this.config.readiness !== 'unconfigured',
            enabled: this.config.enabled,
            readiness: this.config.readiness,
            profiles: this.config.profiles ? Object.keys(this.config.profiles) : [],
            monthlyBudgetRub: this.config.monthlyBudgetRub,
            store: this.config.store,
        };
    }

    private unavailable(): ProviderSubmitOutcome | null {
        if (this.config.readiness === 'unconfigured')
            return { kind: 'rejected', category: 'provider_unconfigured', retryable: false };
        if (!this.config.enabled) return { kind: 'rejected', category: 'provider_disabled', retryable: false };
        return null;
    }

    private headers() {
        return {
            authorization: `Api-Key ${this.config.apiKey!}`,
            'content-type': 'application/json',
        };
    }

    private signal(signal?: AbortSignal) {
        return AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(this.config.timeoutMs)]);
    }

    async submit(request: FrozenProviderRequest, signal?: AbortSignal): Promise<ProviderSubmitOutcome> {
        const unavailable = this.unavailable();
        if (unavailable) return unavailable;
        const parsed = frozenProviderRequestSchema.safeParse(request);
        if (!parsed.success) return { kind: 'rejected', category: 'request_invalid', retryable: false };
        const profile = this.config.profiles?.[parsed.data.profileVersion];
        if (!profile) return { kind: 'rejected', category: 'profile_mismatch', retryable: false };
        if (Buffer.byteLength(parsed.data.input, 'utf8') > profile.maxInputBytes)
            return { kind: 'rejected', category: 'input_limit_exceeded', retryable: false };
        if (parsed.data.maxOutputTokens > profile.maxOutputTokens)
            return { kind: 'rejected', category: 'profile_mismatch', retryable: false };
        let response: Response;
        try {
            response = await this.fetch(new URL('responses', this.config.endpoint!), {
                method: 'POST',
                signal: this.signal(signal),
                headers: { ...this.headers(), 'x-client-request-id': parsed.data.clientRequestId },
                body: JSON.stringify({
                    model: profile.model,
                    instructions: parsed.data.instructions,
                    input: parsed.data.input,
                    max_output_tokens: parsed.data.maxOutputTokens,
                    reasoning: { effort: parsed.data.profileVersion.includes('balanced') ? 'low' : 'minimal' },
                    text: {
                        format: {
                            type: 'json_schema',
                            name: parsed.data.resultSchema.name,
                            strict: true,
                            schema: parsed.data.resultSchema.schema,
                        },
                    },
                    background: true,
                    store: false,
                    stream: false,
                    truncation: 'disabled',
                    conversation: null,
                }),
            });
        } catch {
            return { kind: 'unknown_without_identity', clientRequestId: parsed.data.clientRequestId };
        }
        if (!response.ok) {
            if (response.status >= 500)
                return { kind: 'unknown_without_identity', clientRequestId: parsed.data.clientRequestId };
            return { kind: 'rejected', category: safeCategory(response.status), retryable: false };
        }
        let payload: YandexResponsePayload;
        try {
            payload = (await response.json()) as YandexResponsePayload;
        } catch {
            return { kind: 'unknown_without_identity', clientRequestId: parsed.data.clientRequestId };
        }
        if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 200)
            return { kind: 'unknown_without_identity', clientRequestId: parsed.data.clientRequestId };
        return {
            kind: 'accepted',
            providerResponseId: payload.id,
            clientRequestId: parsed.data.clientRequestId,
        };
    }

    async read(providerResponseId: string, signal?: AbortSignal): Promise<ProviderReadOutcome> {
        if (!this.config.enabled || !/^[A-Za-z0-9_-]{1,200}$/.test(providerResponseId)) return { kind: 'unknown' };
        let response: Response;
        try {
            response = await this.fetch(
                new URL(`responses/${encodeURIComponent(providerResponseId)}`, this.config.endpoint!),
                { signal: this.signal(signal), headers: this.headers() },
            );
        } catch {
            return { kind: 'unknown' };
        }
        if (!response.ok) return { kind: 'unknown' };
        let payload: YandexResponsePayload;
        try {
            payload = (await response.json()) as YandexResponsePayload;
        } catch {
            return { kind: 'unknown' };
        }
        if (payload.status === 'queued') return { kind: 'queued' };
        if (payload.status === 'in_progress') return { kind: 'running' };
        if (payload.status === 'completed') {
            const text = outputText(payload);
            if (!text) return { kind: 'failed', category: 'invalid_structured_result' };
            try {
                return { kind: 'succeeded', rawResult: JSON.parse(text) as unknown, usage: providerUsage(payload) };
            } catch {
                return { kind: 'failed', category: 'invalid_structured_result' };
            }
        }
        if (payload.status === 'failed') return { kind: 'failed', category: 'provider_failed' };
        if (payload.status === 'cancelled') return { kind: 'cancelled', category: 'provider_cancelled' };
        if (payload.status === 'incomplete') return { kind: 'incomplete', category: 'provider_incomplete' };
        return { kind: 'unknown' };
    }
}
