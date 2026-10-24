export type AiContinuationPolicyInput = {
    now: number;
    taskStatus: string;
    cost: number;
    interval: {
        endsAt: Date | string;
        clarificationsUsed: number;
        status: string;
    } | null;
};

export type AiContinuationPolicy = {
    state: 'ready' | 'processing' | 'wait';
    included: boolean;
    clarificationsUsed: number;
    clarificationsRemaining: number;
    intervalEndsAt: string | null;
    nextMessageCost: number;
};

/** The billing window is anchored to a user message; provider latency never extends it. */
export function aiContinuationPolicy(input: AiContinuationPolicyInput): AiContinuationPolicy {
    const interval = input.interval;
    const processing = input.taskStatus === 'processing' || interval?.status === 'processing';
    const endsAt = interval ? new Date(interval.endsAt) : null;
    const included = Boolean(
        endsAt &&
        Number.isFinite(endsAt.getTime()) &&
        endsAt.getTime() > input.now &&
        input.taskStatus !== 'refunded' &&
        interval?.status === 'completed',
    );
    const used = included ? Math.min(2, Math.max(0, interval?.clarificationsUsed ?? 0)) : 0;
    const wait = included && used >= 2;
    return {
        state: processing ? 'processing' : wait ? 'wait' : 'ready',
        included,
        clarificationsUsed: used,
        clarificationsRemaining: included ? 2 - used : 2,
        intervalEndsAt: included ? endsAt!.toISOString() : null,
        nextMessageCost: included ? 0 : input.cost,
    };
}
