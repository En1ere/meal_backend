import { z } from 'zod';

export const aiProviderProfileVersionSchema = z.enum(['yandex-alice-flash-economy-v1', 'yandexgpt-5.1-balanced-v1']);

export const frozenProviderRequestSchema = z.strictObject({
    clientRequestId: z.uuid(),
    profileVersion: aiProviderProfileVersionSchema,
    instructions: z.string().min(1).max(8_192),
    input: z.string().min(1).max(65_536),
    maxOutputTokens: z.number().int().min(16).max(2_000),
    resultSchema: z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        schema: z.record(z.string(), z.unknown()),
    }),
});

export type FrozenProviderRequest = z.infer<typeof frozenProviderRequestSchema>;

export const providerFailureCategorySchema = z.enum([
    'authentication_failed',
    'permission_denied',
    'request_invalid',
    'rate_limited',
    'provider_unconfigured',
    'provider_disabled',
    'profile_mismatch',
    'input_limit_exceeded',
    'invalid_structured_result',
    'provider_failed',
    'provider_cancelled',
    'provider_incomplete',
]);

export type ProviderFailureCategory = z.infer<typeof providerFailureCategorySchema>;

export const providerSubmitOutcomeSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('accepted'),
        providerResponseId: z.string().min(1).max(200),
        clientRequestId: z.uuid(),
    }),
    z.strictObject({
        kind: z.literal('rejected'),
        category: providerFailureCategorySchema,
        retryable: z.literal(false),
    }),
    z.strictObject({
        kind: z.literal('unknown_without_identity'),
        clientRequestId: z.uuid(),
    }),
]);

export type ProviderSubmitOutcome = z.infer<typeof providerSubmitOutcomeSchema>;

export const providerUsageSchema = z.strictObject({
    inputTokens: z.number().int().min(0).max(10_000_000),
    outputTokens: z.number().int().min(0).max(10_000_000),
    cachedInputTokens: z.number().int().min(0).max(10_000_000),
    reasoningTokens: z.number().int().min(0).max(10_000_000),
});

export const providerReadOutcomeSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.enum(['queued', 'running']) }),
    z.strictObject({
        kind: z.literal('succeeded'),
        rawResult: z.unknown(),
        usage: providerUsageSchema,
    }),
    z.strictObject({
        kind: z.enum(['failed', 'cancelled', 'incomplete']),
        category: providerFailureCategorySchema,
    }),
    z.strictObject({ kind: z.literal('unknown') }),
]);

export type ProviderReadOutcome = z.infer<typeof providerReadOutcomeSchema>;

export interface AiProviderPort {
    submit(request: FrozenProviderRequest, signal?: AbortSignal): Promise<ProviderSubmitOutcome>;
    read(providerResponseId: string, signal?: AbortSignal): Promise<ProviderReadOutcome>;
}

export const AI_V2_PROVIDER_PORT = Symbol('AI_V2_PROVIDER_PORT');
export const AI_V2_PROVIDER_RUNTIME = Symbol('AI_V2_PROVIDER_RUNTIME');

export type AiV2ProviderRuntime = {
    kind: 'simulator' | 'yandex';
    readiness: 'unconfigured' | 'disabled' | 'ready';
    profileVersions: readonly string[];
};

export type ProviderDispatchState =
    | { kind: 'prepared' }
    | { kind: 'accepted'; providerResponseId: string }
    | { kind: 'rejected' | 'unknown_without_identity' | 'terminal' };

export function providerCommandFor(state: ProviderDispatchState): 'submit' | 'read' | 'none' {
    if (state.kind === 'prepared') return 'submit';
    if (state.kind === 'accepted') return 'read';
    return 'none';
}

export function providerFinancialEffect(outcome: ProviderSubmitOutcome) {
    if (outcome.kind === 'accepted') return { userQuota: 'reserved', providerBudget: 'held' } as const;
    if (outcome.kind === 'unknown_without_identity') return { userQuota: 'released', providerBudget: 'held' } as const;
    return { userQuota: 'released', providerBudget: 'released' } as const;
}
