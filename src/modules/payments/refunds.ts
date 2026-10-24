export type AccessTarget = Readonly<{ kind: 'subscription_period' | 'ai_package'; id: string }>;
export type RefundRequest = Readonly<{
    key: string;
    paymentId: string;
    amountMinor: number;
    currency: string;
    reason: string;
    access: { mode: 'preserve' } | { mode: 'revoke'; target: AccessTarget };
}>;
export type ProviderOutcome = 'pending' | 'unknown' | 'succeeded' | 'failed';
export interface RefundProvider {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    refund(request: RefundRequest): Promise<ProviderOutcome>;
    lookup(paymentId: string, key: string): Promise<ProviderOutcome>;
}
export type RefundRecord = Readonly<{ request: RefundRequest; status: ProviderOutcome }>;
export type RefundTransition = Readonly<{ record: RefundRecord; revoke: AccessTarget | null }>;

export class RefundError extends Error {
    constructor(
        public readonly code:
            'invalid_request' | 'not_found' | 'idempotency_conflict' | 'refund_limit' | 'provider_conflict',
    ) {
        super(code);
    }
}

function positiveMinor(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RefundError('invalid_request');
}

function identity(paymentId: string, key: string): string {
    return JSON.stringify([paymentId, key]);
}

function fingerprint(request: RefundRequest): string {
    return JSON.stringify([
        request.paymentId,
        request.key,
        request.amountMinor,
        request.currency,
        request.reason,
        request.access.mode,
        request.access.mode === 'revoke' ? request.access.target.kind : null,
        request.access.mode === 'revoke' ? request.access.target.id : null,
    ]);
}

/** In-memory domain harness only. Production must persist reservation and outbox atomically. */
export class MockRefundLedger {
    private readonly payments = new Map<
        string,
        { amountMinor: number; currency: string; targets: readonly AccessTarget[] }
    >();
    private readonly records = new Map<string, RefundRecord>();

    addPaidPayment(id: string, amountMinor: number, currency: string, targets: readonly AccessTarget[] = []): void {
        positiveMinor(amountMinor);
        if (!id || !/^[A-Z]{3}$/.test(currency) || this.payments.has(id)) throw new RefundError('invalid_request');
        this.payments.set(id, { amountMinor, currency, targets: structuredClone(targets) });
    }

    reserve(request: RefundRequest): RefundRecord {
        positiveMinor(request.amountMinor);
        if (!request.key.trim() || request.key.length > 200 || !request.reason.trim() || request.reason.length > 2000) {
            throw new RefundError('invalid_request');
        }
        const payment = this.payments.get(request.paymentId);
        if (!payment) throw new RefundError('not_found');
        if (payment.currency !== request.currency) throw new RefundError('invalid_request');
        if (request.access.mode !== 'preserve' && request.access.mode !== 'revoke')
            throw new RefundError('invalid_request');
        if (request.access.mode === 'revoke') {
            const target = request.access.target;
            if (!payment.targets.some((item) => item.id === target.id && item.kind === target.kind))
                throw new RefundError('invalid_request');
        }
        const id = identity(request.paymentId, request.key);
        const existing = this.records.get(id);
        if (existing) {
            if (fingerprint(existing.request) !== fingerprint(request)) throw new RefundError('idempotency_conflict');
            return structuredClone(existing);
        }
        let available = payment.amountMinor;
        for (const item of this.records.values()) {
            if (item.request.paymentId === request.paymentId && item.status !== 'failed')
                available -= item.request.amountMinor;
        }
        if (request.amountMinor > available) throw new RefundError('refund_limit');
        const record: RefundRecord = { request: structuredClone(request), status: 'pending' };
        this.records.set(id, record);
        return structuredClone(record);
    }

    settle(paymentId: string, key: string, outcome: ProviderOutcome): RefundTransition {
        if (!['pending', 'unknown', 'succeeded', 'failed'].includes(outcome)) throw new RefundError('invalid_request');
        const id = identity(paymentId, key);
        const existing = this.records.get(id);
        if (!existing) throw new RefundError('not_found');
        if (existing.status === 'succeeded' || existing.status === 'failed') {
            if (existing.status !== outcome) throw new RefundError('provider_conflict');
            return { record: structuredClone(existing), revoke: null };
        }
        const record = { ...existing, status: outcome };
        this.records.set(id, record);
        return {
            record: structuredClone(record),
            revoke:
                outcome === 'succeeded' && record.request.access.mode === 'revoke'
                    ? structuredClone(record.request.access.target)
                    : null,
        };
    }
}

/** Explicitly constructed test double; never registered in the Nest application. */
export class MockRefundProvider implements RefundProvider {
    private readonly entries = new Map<string, { request: RefundRequest; outcome: ProviderOutcome }>();

    constructor(private readonly initialOutcome: ProviderOutcome = 'succeeded') {}

    status() {
        return { configured: true, provider: 'mock' } as const;
    }

    refund(request: RefundRequest): Promise<ProviderOutcome> {
        const id = identity(request.paymentId, request.key);
        const entry = this.entries.get(id);
        if (entry && fingerprint(entry.request) !== fingerprint(request))
            return Promise.reject(new RefundError('idempotency_conflict'));
        if (!entry) this.entries.set(id, { request: structuredClone(request), outcome: this.initialOutcome });
        return Promise.resolve(entry?.outcome ?? this.initialOutcome);
    }

    lookup(paymentId: string, key: string): Promise<ProviderOutcome> {
        return Promise.resolve(this.entries.get(identity(paymentId, key))?.outcome ?? 'unknown');
    }

    resolve(paymentId: string, key: string, outcome: 'succeeded' | 'failed'): void {
        const entry = this.entries.get(identity(paymentId, key));
        if (!entry) throw new RefundError('not_found');
        if ((entry.outcome === 'succeeded' || entry.outcome === 'failed') && entry.outcome !== outcome)
            throw new RefundError('provider_conflict');
        entry.outcome = outcome;
    }
}
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export const REFUND_PROVIDER = Symbol('REFUND_PROVIDER');

@Injectable()
export class DisabledRefundProvider implements RefundProvider {
    status() {
        return { configured: false, provider: null } as const;
    }

    refund(request: RefundRequest): Promise<ProviderOutcome> {
        void request;
        return Promise.reject(new ServiceUnavailableException('Refund provider is not configured'));
    }

    lookup(paymentId: string, key: string): Promise<ProviderOutcome> {
        void paymentId;
        void key;
        return Promise.reject(new ServiceUnavailableException('Refund provider is not configured'));
    }
}
