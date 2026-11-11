import { z } from 'zod';

export const aiV2ProviderDispatchStateSchema = z.enum([
    'prepared',
    'submit_claimed',
    'accepted',
    'read_claimed',
    'queued',
    'running',
    'read_unknown',
    'succeeded',
    'failed',
    'cancelled',
    'incomplete',
    'rejected',
    'unknown_without_identity',
]);

export type AiV2ProviderDispatchState = z.infer<typeof aiV2ProviderDispatchStateSchema>;

const transitions: Readonly<Record<AiV2ProviderDispatchState, readonly AiV2ProviderDispatchState[]>> = {
    prepared: ['submit_claimed'],
    submit_claimed: ['accepted', 'rejected', 'unknown_without_identity'],
    accepted: ['read_claimed'],
    queued: ['read_claimed'],
    running: ['read_claimed'],
    read_unknown: ['read_claimed'],
    read_claimed: ['queued', 'running', 'read_unknown', 'succeeded', 'failed', 'cancelled', 'incomplete'],
    succeeded: [],
    failed: [],
    cancelled: [],
    incomplete: [],
    rejected: [],
    unknown_without_identity: [],
};

export function aiV2ProviderTransitionAllowed(from: AiV2ProviderDispatchState, to: AiV2ProviderDispatchState) {
    return transitions[from].includes(to);
}

export function aiV2ProviderNextCommand(state: AiV2ProviderDispatchState): 'submit' | 'read' | 'none' {
    if (state === 'prepared') return 'submit';
    if (['accepted', 'queued', 'running', 'read_unknown'].includes(state)) return 'read';
    return 'none';
}

export const aiV2ProviderUsageSchema = z.strictObject({
    inputTokens: z.number().int().min(0).max(10_000_000),
    outputTokens: z.number().int().min(0).max(10_000_000),
    cachedInputTokens: z.number().int().min(0).max(10_000_000),
    reasoningTokens: z.number().int().min(0).max(10_000_000),
});

export type AiV2ProviderUsage = z.infer<typeof aiV2ProviderUsageSchema>;

export type AiV2PersistedReadOutcome =
    | { kind: 'queued'; nextReadAt: Date }
    | { kind: 'running'; nextReadAt: Date }
    | { kind: 'unknown'; nextReadAt: Date }
    | {
          kind: 'succeeded';
          validatedResultSnapshot: unknown;
          usage: AiV2ProviderUsage;
          actualCostRub: string;
      }
    | {
          kind: 'failed';
          usage: AiV2ProviderUsage;
          actualCostRub: string;
      }
    | {
          kind: 'cancelled';
          usage: AiV2ProviderUsage;
          actualCostRub: string;
      }
    | {
          kind: 'incomplete';
          usage: AiV2ProviderUsage;
          actualCostRub: string;
      };
