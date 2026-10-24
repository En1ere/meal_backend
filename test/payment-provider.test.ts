import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import {
    DisabledPaymentProvider,
    PaymentBoundaryError,
    paymentStartRequestSchema,
    paymentTransition,
    validatePaymentSnapshot,
    verifiedPaymentEvent,
    type PaymentStartRequest,
} from '../src/modules/payments/payment-provider.js';

const orderId = 'c9cc69e6-430f-4ef8-b6fe-335647a248d0';
const request = (overrides: Partial<PaymentStartRequest> = {}): PaymentStartRequest => ({
    orderId,
    idempotencyKey: 'checkout-1',
    amountMinor: 59_900,
    currency: 'RUB',
    description: 'Pro на месяц',
    returnUrl: 'https://meal.example/settings/subscription',
    ...overrides,
});

void test('payment start request binds safe integer RUB money and an HTTPS return URL', () => {
    assert.equal(paymentStartRequestSchema.safeParse(request()).success, true);
    assert.equal(paymentStartRequestSchema.safeParse(request({ amountMinor: 0 })).success, false);
    assert.equal(paymentStartRequestSchema.safeParse(request({ amountMinor: 1.5 })).success, false);
    assert.equal(paymentStartRequestSchema.safeParse({ ...request(), currency: 'USD' }).success, false);
    assert.equal(
        paymentStartRequestSchema.safeParse(request({ returnUrl: 'http://meal.example/settings/subscription' }))
            .success,
        false,
    );
});

void test('provider snapshot cannot change order, amount or currency and exposes only HTTPS checkout', () => {
    const snapshot = {
        provider: 'provider_candidate',
        externalId: 'pay-1',
        orderId,
        state: 'requires_action',
        amountMinor: 59_900,
        currency: 'RUB',
        checkoutUrl: 'https://checkout.example/pay-1',
        occurredAt: '2026-10-09T09:00:00.000Z',
    };
    assert.deepEqual(validatePaymentSnapshot(request(), snapshot), snapshot);
    for (const changed of [
        { ...snapshot, orderId: crypto.randomUUID() },
        { ...snapshot, amountMinor: 59_901 },
    ]) {
        assert.throws(
            () => validatePaymentSnapshot(request(), changed),
            (error: unknown) => error instanceof PaymentBoundaryError && error.code === 'binding_mismatch',
        );
    }
    assert.throws(
        () => validatePaymentSnapshot(request(), { ...snapshot, currency: 'USD' }),
        (error: unknown) => error instanceof PaymentBoundaryError && error.code === 'invalid_request',
    );
    assert.throws(
        () => validatePaymentSnapshot(request(), { ...snapshot, checkoutUrl: 'javascript:alert(1)' }),
        (error: unknown) => error instanceof PaymentBoundaryError && error.code === 'invalid_request',
    );
});

void test('payment state machine keeps terminal provider outcomes immutable', () => {
    assert.equal(paymentTransition('pending', 'requires_action'), 'requires_action');
    assert.equal(paymentTransition('requires_action', 'unknown'), 'unknown');
    assert.equal(paymentTransition('unknown', 'succeeded'), 'succeeded');
    assert.equal(paymentTransition('succeeded', 'succeeded'), 'succeeded');
    for (const [current, next] of [
        ['succeeded', 'failed'],
        ['failed', 'processing'],
        ['cancelled', 'succeeded'],
    ] as const) {
        assert.throws(
            () => paymentTransition(current, next),
            (error: unknown) => error instanceof PaymentBoundaryError && error.code === 'invalid_transition',
        );
    }
});

void test('webhook normalization requires prior signature verification and stores a bounded projection', () => {
    const event = {
        provider: 'provider_candidate',
        eventId: 'event-1',
        externalId: 'pay-1',
        orderId,
        state: 'succeeded',
        amountMinor: 59_900,
        currency: 'RUB',
        occurredAt: '2026-10-09T09:01:00.000Z',
        metadata: { code: 'payment.succeeded', liveMode: false },
    };
    assert.throws(
        () => verifiedPaymentEvent(event, false),
        (error: unknown) => error instanceof PaymentBoundaryError && error.code === 'unverified_webhook',
    );
    assert.deepEqual(verifiedPaymentEvent(event, true), event);
    assert.throws(
        () => verifiedPaymentEvent({ ...event, rawPayload: { card: 'not allowed' } }, true),
        (error: unknown) => error instanceof PaymentBoundaryError && error.code === 'invalid_request',
    );
});

void test('unselected payment provider is registered as explicit fail-closed infrastructure', async () => {
    const provider = new DisabledPaymentProvider();
    assert.deepEqual(provider.status(), { configured: false, provider: null });
    await assert.rejects(provider.createPayment(request()), ServiceUnavailableException);
    await assert.rejects(
        provider.lookupPayment({ provider: 'provider_candidate', externalId: 'pay-1', orderId }),
        ServiceUnavailableException,
    );
    await assert.rejects(
        provider.verifyWebhook({ headers: {}, rawBody: new Uint8Array() }),
        ServiceUnavailableException,
    );
});
