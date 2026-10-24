import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export const paymentStateSchema = z.enum([
    'pending',
    'requires_action',
    'processing',
    'unknown',
    'succeeded',
    'failed',
    'cancelled',
]);
export type PaymentState = z.infer<typeof paymentStateSchema>;

const providerCodeSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/);
const providerReferenceSchema = z.string().trim().min(1).max(200);
const moneySchema = z.strictObject({
    amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal('RUB'),
});
const httpsUrlSchema = z.url().refine((value) => new URL(value).protocol === 'https:', 'Expected HTTPS URL');

export const paymentStartRequestSchema = moneySchema.extend({
    orderId: z.uuid(),
    idempotencyKey: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(500),
    returnUrl: httpsUrlSchema,
});
export type PaymentStartRequest = z.infer<typeof paymentStartRequestSchema>;

export const paymentLookupRequestSchema = z.strictObject({
    provider: providerCodeSchema,
    externalId: providerReferenceSchema,
    orderId: z.uuid(),
});
export type PaymentLookupRequest = z.infer<typeof paymentLookupRequestSchema>;

export const paymentSnapshotSchema = moneySchema.extend({
    provider: providerCodeSchema,
    externalId: providerReferenceSchema,
    orderId: z.uuid(),
    state: paymentStateSchema,
    checkoutUrl: httpsUrlSchema.nullable(),
    occurredAt: z.iso.datetime(),
});
export type PaymentSnapshot = z.infer<typeof paymentSnapshotSchema>;

export type PaymentWebhookRequest = Readonly<{
    headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    rawBody: Uint8Array;
}>;

export const verifiedPaymentEventSchema = moneySchema.extend({
    provider: providerCodeSchema,
    eventId: providerReferenceSchema,
    externalId: providerReferenceSchema,
    orderId: z.uuid(),
    state: paymentStateSchema,
    occurredAt: z.iso.datetime(),
    metadata: z
        .strictObject({
            code: z.string().trim().min(1).max(100).optional(),
            liveMode: z.boolean().optional(),
        })
        .default({}),
});
export type VerifiedPaymentEvent = z.infer<typeof verifiedPaymentEventSchema>;

export interface PaymentProvider {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    createPayment(request: PaymentStartRequest): Promise<PaymentSnapshot>;
    lookupPayment(request: PaymentLookupRequest): Promise<PaymentSnapshot>;
    verifyWebhook(request: PaymentWebhookRequest): Promise<VerifiedPaymentEvent>;
}

export class PaymentBoundaryError extends Error {
    constructor(
        public readonly code: 'invalid_request' | 'binding_mismatch' | 'invalid_transition' | 'unverified_webhook',
    ) {
        super(code);
    }
}

const transitions: Readonly<Record<PaymentState, ReadonlySet<PaymentState>>> = {
    pending: new Set(['pending', 'requires_action', 'processing', 'unknown', 'succeeded', 'failed', 'cancelled']),
    requires_action: new Set(['requires_action', 'processing', 'unknown', 'succeeded', 'failed', 'cancelled']),
    processing: new Set(['processing', 'unknown', 'succeeded', 'failed', 'cancelled']),
    unknown: new Set(['unknown', 'processing', 'succeeded', 'failed', 'cancelled']),
    succeeded: new Set(['succeeded']),
    failed: new Set(['failed']),
    cancelled: new Set(['cancelled']),
};

export function paymentTransition(current: PaymentState, next: PaymentState): PaymentState {
    if (!transitions[current].has(next)) throw new PaymentBoundaryError('invalid_transition');
    return next;
}

export function validatePaymentSnapshot(request: PaymentStartRequest, raw: unknown): PaymentSnapshot {
    const parsedRequest = paymentStartRequestSchema.parse(request);
    const result = paymentSnapshotSchema.safeParse(raw);
    if (!result.success) throw new PaymentBoundaryError('invalid_request');
    if (
        result.data.orderId !== parsedRequest.orderId ||
        result.data.amountMinor !== parsedRequest.amountMinor ||
        result.data.currency !== parsedRequest.currency
    ) {
        throw new PaymentBoundaryError('binding_mismatch');
    }
    return result.data;
}

export function verifiedPaymentEvent(raw: unknown, signatureVerified: boolean): VerifiedPaymentEvent {
    if (!signatureVerified) throw new PaymentBoundaryError('unverified_webhook');
    const result = verifiedPaymentEventSchema.safeParse(raw);
    if (!result.success) throw new PaymentBoundaryError('invalid_request');
    return result.data;
}

@Injectable()
export class DisabledPaymentProvider implements PaymentProvider {
    status() {
        return { configured: false, provider: null } as const;
    }

    private unavailable<T>(): Promise<T> {
        return Promise.reject(new ServiceUnavailableException('Payment provider is not configured'));
    }

    createPayment(request: PaymentStartRequest): Promise<PaymentSnapshot> {
        void request;
        return this.unavailable();
    }

    lookupPayment(request: PaymentLookupRequest): Promise<PaymentSnapshot> {
        void request;
        return this.unavailable();
    }

    verifyWebhook(request: PaymentWebhookRequest): Promise<VerifiedPaymentEvent> {
        void request;
        return this.unavailable();
    }
}
