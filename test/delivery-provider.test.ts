import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import {
    DeliveryBoundaryError,
    DisabledEmailDeliveryProvider,
    DisabledWebPushDeliveryProvider,
    emailDeliveryRequestSchema,
    emailDeliveryTransition,
    evaluateDeliveryPolicy,
    validateEmailDeliverySnapshot,
    validateWebPushDeliverySnapshot,
    verifiedEmailEvent,
    webPushDeliveryRequestSchema,
    webPushDeliveryTransition,
    type DeliveryPolicyInput,
    type EmailDeliveryRequest,
    type WebPushDeliveryRequest,
} from '../src/modules/delivery-infrastructure/delivery-provider.js';

const deliveryId = 'c9cc69e6-430f-4ef8-b6fe-335647a248d0';
const subscriptionId = '988f0dab-5708-426c-a404-6ab18a8e4b80';
const userId = '19f15f6b-4e74-4d3e-9781-965d57aff62b';
const emailRequest: EmailDeliveryRequest = {
    deliveryId,
    idempotencyKey: 'mail-1',
    recipient: { userId, address: 'user@example.com' },
    classification: 'security',
    content: { templateId: 'account.verify-v1', locale: 'ru-RU', variables: { actionUrl: 'https://meal.example' } },
};
const pushRequest: WebPushDeliveryRequest = {
    deliveryId,
    idempotencyKey: 'push-1',
    subscription: {
        subscriptionId,
        endpoint: 'https://push.example/subscription',
        p256dh: 'a'.repeat(32),
        auth: 'b'.repeat(24),
    },
    content: { title: 'План готов', body: 'Откройте приложение, чтобы посмотреть план.', href: '/plan' },
    ttlSeconds: 3_600,
    urgency: 'normal',
};

const policy = (overrides: Partial<DeliveryPolicyInput> = {}): DeliveryPolicyInput => ({
    channel: 'email',
    classification: 'notification',
    priority: 'important',
    criticalReason: null,
    channelEnabled: true,
    emailVerified: true,
    marketingConsent: false,
    urgentFoodRiskOptIn: false,
    quietHours: { start: '22:00', end: '08:00', timeZone: 'Asia/Yekaterinburg' },
    ...overrides,
});

void test('email request accepts only bounded templates and does not permit arbitrary provider fields', () => {
    assert.equal(emailDeliveryRequestSchema.safeParse(emailRequest).success, true);
    assert.equal(
        emailDeliveryRequestSchema.safeParse({ ...emailRequest, recipient: { userId, address: 'not-email' } }).success,
        false,
    );
    assert.equal(
        emailDeliveryRequestSchema.safeParse({
            ...emailRequest,
            content: { ...emailRequest.content, html: '<b>x</b>' },
        }).success,
        false,
    );
    assert.equal(
        emailDeliveryRequestSchema.safeParse({ ...emailRequest, apiKey: 'must-not-cross-boundary' }).success,
        false,
    );
});

void test('delivery policy blocks disabled or unverified channels and requires marketing consent', () => {
    assert.deepEqual(evaluateDeliveryPolicy(policy({ channelEnabled: false })), {
        action: 'block',
        reason: 'channel_disabled',
    });
    assert.deepEqual(evaluateDeliveryPolicy(policy({ emailVerified: false })), {
        action: 'block',
        reason: 'email_unverified',
    });
    assert.deepEqual(evaluateDeliveryPolicy(policy({ classification: 'marketing', priority: 'marketing' })), {
        action: 'block',
        reason: 'marketing_consent_missing',
    });
});

void test('quiet hours defer ordinary delivery but only approved critical reasons bypass them', () => {
    const quietNow = new Date('2026-10-09T19:30:00.000Z'); // 00:30 in Asia/Yekaterinburg
    assert.deepEqual(evaluateDeliveryPolicy(policy(), quietNow), { action: 'defer', reason: 'quiet_hours' });
    assert.deepEqual(
        evaluateDeliveryPolicy(
            policy({ classification: 'security', priority: 'critical', criticalReason: 'account_security' }),
            quietNow,
        ),
        { action: 'allow', reason: 'ready' },
    );
    assert.throws(
        () => evaluateDeliveryPolicy(policy({ criticalReason: 'food_risk' }), quietNow),
        /Critical reason requires critical priority/,
    );
    assert.deepEqual(evaluateDeliveryPolicy(policy({ priority: 'critical', criticalReason: 'food_risk' }), quietNow), {
        action: 'defer',
        reason: 'quiet_hours',
    });
    assert.deepEqual(
        evaluateDeliveryPolicy(
            policy({ priority: 'critical', criticalReason: 'food_risk', urgentFoodRiskOptIn: true }),
            quietNow,
        ),
        { action: 'allow', reason: 'ready' },
    );
});

void test('email provider result remains delivery-bound and terminal failures stay immutable', () => {
    const snapshot = {
        provider: 'email_candidate',
        externalId: 'message-1',
        deliveryId,
        state: 'accepted',
        occurredAt: '2026-10-09T09:00:00.000Z',
    };
    assert.deepEqual(validateEmailDeliverySnapshot(emailRequest, snapshot), snapshot);
    assert.throws(
        () => validateEmailDeliverySnapshot(emailRequest, { ...snapshot, deliveryId: crypto.randomUUID() }),
        (error: unknown) => error instanceof DeliveryBoundaryError && error.code === 'binding_mismatch',
    );
    assert.equal(emailDeliveryTransition('queued', 'accepted'), 'accepted');
    assert.equal(emailDeliveryTransition('sent', 'delivered'), 'delivered');
    assert.equal(emailDeliveryTransition('delivered', 'complained'), 'complained');
    assert.throws(
        () => emailDeliveryTransition('complained', 'delivered'),
        (error: unknown) => error instanceof DeliveryBoundaryError && error.code === 'invalid_transition',
    );
});

void test('email webhook requires verified signature and exposes only a bounded event', () => {
    const event = {
        provider: 'email_candidate',
        eventId: 'event-1',
        externalId: 'message-1',
        deliveryId,
        state: 'bounced',
        occurredAt: '2026-10-09T09:02:00.000Z',
        reasonCode: 'mailbox-unavailable',
    };
    assert.throws(
        () => verifiedEmailEvent(event, false),
        (error: unknown) => error instanceof DeliveryBoundaryError && error.code === 'unverified_webhook',
    );
    assert.deepEqual(verifiedEmailEvent(event, true), event);
    assert.throws(
        () => verifiedEmailEvent({ ...event, recipient: 'must-not-be-persisted' }, true),
        (error: unknown) => error instanceof DeliveryBoundaryError && error.code === 'invalid_request',
    );
});

void test('Web Push requires HTTPS, bounded payload and binds provider result to the subscription', () => {
    assert.equal(webPushDeliveryRequestSchema.safeParse(pushRequest).success, true);
    assert.equal(
        webPushDeliveryRequestSchema.safeParse({
            ...pushRequest,
            subscription: { ...pushRequest.subscription, endpoint: 'http://push.example/subscription' },
        }).success,
        false,
    );
    assert.equal(
        webPushDeliveryRequestSchema.safeParse({
            ...pushRequest,
            content: { ...pushRequest.content, href: 'https://evil.example' },
        }).success,
        false,
    );
    const snapshot = {
        provider: 'push_candidate',
        externalId: null,
        deliveryId,
        subscriptionId,
        state: 'gone',
        occurredAt: '2026-10-09T09:00:00.000Z',
    };
    assert.deepEqual(validateWebPushDeliverySnapshot(pushRequest, snapshot), snapshot);
    assert.throws(
        () => validateWebPushDeliverySnapshot(pushRequest, { ...snapshot, subscriptionId: crypto.randomUUID() }),
        (error: unknown) => error instanceof DeliveryBoundaryError && error.code === 'binding_mismatch',
    );
    assert.equal(webPushDeliveryTransition('accepted', 'gone'), 'gone');
    assert.throws(
        () => webPushDeliveryTransition('gone', 'sent'),
        (error: unknown) => error instanceof DeliveryBoundaryError && error.code === 'invalid_transition',
    );
});

void test('unselected email and Web Push providers are explicit fail-closed infrastructure', async () => {
    const email = new DisabledEmailDeliveryProvider();
    const push = new DisabledWebPushDeliveryProvider();
    assert.deepEqual(email.status(), { configured: false, provider: null });
    assert.deepEqual(push.status(), { configured: false, provider: null });
    await assert.rejects(email.send(emailRequest), ServiceUnavailableException);
    await assert.rejects(email.verifyWebhook({ headers: {}, rawBody: new Uint8Array() }), ServiceUnavailableException);
    await assert.rejects(push.send(pushRequest), ServiceUnavailableException);
});
