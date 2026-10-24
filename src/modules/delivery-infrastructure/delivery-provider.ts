import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

export const EMAIL_DELIVERY_PROVIDER = Symbol('EMAIL_DELIVERY_PROVIDER');
export const WEB_PUSH_DELIVERY_PROVIDER = Symbol('WEB_PUSH_DELIVERY_PROVIDER');

const providerCodeSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/);
const providerReferenceSchema = z.string().trim().min(1).max(500);
const policyCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const httpsUrlSchema = z.url().refine((value) => new URL(value).protocol === 'https:', 'Expected HTTPS URL');
const relativeHrefSchema = z
    .string()
    .max(500)
    .refine((value) => /^\/(?!\/)/.test(value), 'Expected an application-relative URL');
const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const deliveryClassificationSchema = z.enum(['security', 'transactional', 'notification', 'marketing']);
export type DeliveryClassification = z.infer<typeof deliveryClassificationSchema>;
export const deliveryPrioritySchema = z.enum(['critical', 'important', 'informational', 'marketing']);
export type DeliveryPriority = z.infer<typeof deliveryPrioritySchema>;

export const deliveryPolicyInputSchema = z
    .strictObject({
        channel: z.enum(['email', 'web_push']),
        classification: deliveryClassificationSchema,
        priority: deliveryPrioritySchema,
        criticalReason: z.enum(['account_security', 'payment', 'food_risk']).nullable(),
        channelEnabled: z.boolean(),
        emailVerified: z.boolean(),
        marketingConsent: z.boolean(),
        urgentFoodRiskOptIn: z.boolean(),
        quietHours: z
            .strictObject({
                start: clockSchema,
                end: clockSchema,
                timeZone: z.string().trim().min(1).max(100),
            })
            .nullable(),
    })
    .superRefine((value, context) => {
        if ((value.classification === 'marketing') !== (value.priority === 'marketing'))
            context.addIssue({
                code: 'custom',
                path: ['priority'],
                message: 'Marketing classification and priority differ',
            });
        if (value.criticalReason !== null && value.priority !== 'critical')
            context.addIssue({
                code: 'custom',
                path: ['criticalReason'],
                message: 'Critical reason requires critical priority',
            });
        if (value.quietHours?.start === value.quietHours?.end)
            context.addIssue({ code: 'custom', path: ['quietHours'], message: 'Quiet hours must differ' });
        if (value.quietHours)
            try {
                new Intl.DateTimeFormat('en', { timeZone: value.quietHours.timeZone }).format();
            } catch {
                context.addIssue({ code: 'custom', path: ['quietHours', 'timeZone'], message: 'Unknown time zone' });
            }
    });
export type DeliveryPolicyInput = z.infer<typeof deliveryPolicyInputSchema>;

export type DeliveryPolicyDecision = Readonly<{
    action: 'allow' | 'defer' | 'block';
    reason: 'ready' | 'channel_disabled' | 'email_unverified' | 'marketing_consent_missing' | 'quiet_hours';
}>;

const templateVariablesSchema = z
    .record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/), z.string().max(2_000))
    .superRefine((value, context) => {
        if (Object.keys(value).length > 30)
            context.addIssue({ code: 'custom', message: 'Too many template variables' });
    });

export const emailDeliveryRequestSchema = z.strictObject({
    deliveryId: z.uuid(),
    idempotencyKey: z.string().trim().min(1).max(200),
    recipient: z.strictObject({
        userId: z.uuid().nullable(),
        address: z.email().max(254),
    }),
    classification: deliveryClassificationSchema,
    content: z.strictObject({
        templateId: policyCodeSchema,
        locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
        variables: templateVariablesSchema,
    }),
});
export type EmailDeliveryRequest = z.infer<typeof emailDeliveryRequestSchema>;

export const emailDeliveryStateSchema = z.enum([
    'queued',
    'accepted',
    'deferred',
    'sent',
    'unknown',
    'delivered',
    'bounced',
    'complained',
    'failed',
]);
export type EmailDeliveryState = z.infer<typeof emailDeliveryStateSchema>;

export const emailDeliverySnapshotSchema = z.strictObject({
    provider: providerCodeSchema,
    externalId: providerReferenceSchema,
    deliveryId: z.uuid(),
    state: emailDeliveryStateSchema,
    occurredAt: z.iso.datetime(),
});
export type EmailDeliverySnapshot = z.infer<typeof emailDeliverySnapshotSchema>;

export type EmailWebhookRequest = Readonly<{
    headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    rawBody: Uint8Array;
}>;

export const verifiedEmailEventSchema = z.strictObject({
    provider: providerCodeSchema,
    eventId: providerReferenceSchema,
    externalId: providerReferenceSchema,
    deliveryId: z.uuid(),
    state: z.enum(['delivered', 'bounced', 'complained', 'failed']),
    occurredAt: z.iso.datetime(),
    reasonCode: policyCodeSchema.nullable(),
});
export type VerifiedEmailEvent = z.infer<typeof verifiedEmailEventSchema>;

const webPushKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);
export const webPushDeliveryRequestSchema = z.strictObject({
    deliveryId: z.uuid(),
    idempotencyKey: z.string().trim().min(1).max(200),
    subscription: z.strictObject({
        subscriptionId: z.uuid(),
        endpoint: httpsUrlSchema,
        p256dh: webPushKeySchema,
        auth: webPushKeySchema,
    }),
    content: z.strictObject({
        title: z.string().trim().min(1).max(120),
        body: z.string().trim().min(1).max(300),
        href: relativeHrefSchema,
    }),
    ttlSeconds: z.number().int().min(0).max(86_400),
    urgency: z.enum(['very-low', 'low', 'normal', 'high']),
});
export type WebPushDeliveryRequest = z.infer<typeof webPushDeliveryRequestSchema>;

export const webPushDeliveryStateSchema = z.enum(['queued', 'accepted', 'unknown', 'sent', 'gone', 'failed']);
export type WebPushDeliveryState = z.infer<typeof webPushDeliveryStateSchema>;

export const webPushDeliverySnapshotSchema = z.strictObject({
    provider: providerCodeSchema,
    externalId: providerReferenceSchema.nullable(),
    deliveryId: z.uuid(),
    subscriptionId: z.uuid(),
    state: webPushDeliveryStateSchema,
    occurredAt: z.iso.datetime(),
});
export type WebPushDeliverySnapshot = z.infer<typeof webPushDeliverySnapshotSchema>;

export interface EmailDeliveryProvider {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    send(request: EmailDeliveryRequest): Promise<EmailDeliverySnapshot>;
    verifyWebhook(request: EmailWebhookRequest): Promise<VerifiedEmailEvent>;
}

export interface WebPushDeliveryProvider {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    send(request: WebPushDeliveryRequest): Promise<WebPushDeliverySnapshot>;
}

export class DeliveryBoundaryError extends Error {
    constructor(
        public readonly code: 'invalid_request' | 'binding_mismatch' | 'invalid_transition' | 'unverified_webhook',
    ) {
        super(code);
    }
}

const emailTransitions: Readonly<Record<EmailDeliveryState, ReadonlySet<EmailDeliveryState>>> = {
    queued: new Set(['queued', 'accepted', 'deferred', 'sent', 'unknown', 'failed']),
    accepted: new Set(['accepted', 'deferred', 'sent', 'unknown', 'failed']),
    deferred: new Set(['deferred', 'accepted', 'sent', 'unknown', 'failed']),
    sent: new Set(['sent', 'unknown', 'delivered', 'bounced', 'complained', 'failed']),
    unknown: new Set(['unknown', 'accepted', 'deferred', 'sent', 'delivered', 'bounced', 'complained', 'failed']),
    delivered: new Set(['delivered', 'complained']),
    bounced: new Set(['bounced']),
    complained: new Set(['complained']),
    failed: new Set(['failed']),
};

const webPushTransitions: Readonly<Record<WebPushDeliveryState, ReadonlySet<WebPushDeliveryState>>> = {
    queued: new Set(['queued', 'accepted', 'unknown', 'sent', 'gone', 'failed']),
    accepted: new Set(['accepted', 'unknown', 'sent', 'gone', 'failed']),
    unknown: new Set(['unknown', 'accepted', 'sent', 'gone', 'failed']),
    sent: new Set(['sent']),
    gone: new Set(['gone']),
    failed: new Set(['failed']),
};

function parseProviderResult<T>(schema: z.ZodType<T>, raw: unknown): T {
    const result = schema.safeParse(raw);
    if (!result.success) throw new DeliveryBoundaryError('invalid_request');
    return result.data;
}

function localClock(now: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(now);
    return `${parts.find((part) => part.type === 'hour')!.value}:${parts.find((part) => part.type === 'minute')!.value}`;
}

function isQuiet(now: Date, quietHours: NonNullable<DeliveryPolicyInput['quietHours']>): boolean {
    const time = localClock(now, quietHours.timeZone);
    return quietHours.start < quietHours.end
        ? time >= quietHours.start && time < quietHours.end
        : time >= quietHours.start || time < quietHours.end;
}

export function evaluateDeliveryPolicy(raw: DeliveryPolicyInput, now: Date = new Date()): DeliveryPolicyDecision {
    const input = deliveryPolicyInputSchema.parse(raw);
    if (!input.channelEnabled) return { action: 'block', reason: 'channel_disabled' };
    if (input.channel === 'email' && !input.emailVerified) return { action: 'block', reason: 'email_unverified' };
    if (input.classification === 'marketing' && !input.marketingConsent)
        return { action: 'block', reason: 'marketing_consent_missing' };
    const bypassQuietHours =
        input.priority === 'critical' &&
        (input.criticalReason === 'account_security' ||
            input.criticalReason === 'payment' ||
            (input.criticalReason === 'food_risk' && input.urgentFoodRiskOptIn));
    if (input.quietHours && !bypassQuietHours && isQuiet(now, input.quietHours))
        return { action: 'defer', reason: 'quiet_hours' };
    return { action: 'allow', reason: 'ready' };
}

export function emailDeliveryTransition(current: EmailDeliveryState, next: EmailDeliveryState): EmailDeliveryState {
    if (!emailTransitions[current].has(next)) throw new DeliveryBoundaryError('invalid_transition');
    return next;
}

export function webPushDeliveryTransition(
    current: WebPushDeliveryState,
    next: WebPushDeliveryState,
): WebPushDeliveryState {
    if (!webPushTransitions[current].has(next)) throw new DeliveryBoundaryError('invalid_transition');
    return next;
}

export function validateEmailDeliverySnapshot(request: EmailDeliveryRequest, raw: unknown): EmailDeliverySnapshot {
    const parsedRequest = emailDeliveryRequestSchema.parse(request);
    const result = parseProviderResult(emailDeliverySnapshotSchema, raw);
    if (parsedRequest.deliveryId !== result.deliveryId) throw new DeliveryBoundaryError('binding_mismatch');
    return result;
}

export function verifiedEmailEvent(raw: unknown, signatureVerified: boolean): VerifiedEmailEvent {
    if (!signatureVerified) throw new DeliveryBoundaryError('unverified_webhook');
    return parseProviderResult(verifiedEmailEventSchema, raw);
}

export function validateWebPushDeliverySnapshot(
    request: WebPushDeliveryRequest,
    raw: unknown,
): WebPushDeliverySnapshot {
    const parsedRequest = webPushDeliveryRequestSchema.parse(request);
    const result = parseProviderResult(webPushDeliverySnapshotSchema, raw);
    if (
        parsedRequest.deliveryId !== result.deliveryId ||
        parsedRequest.subscription.subscriptionId !== result.subscriptionId
    )
        throw new DeliveryBoundaryError('binding_mismatch');
    return result;
}

abstract class DisabledProvider {
    status() {
        return { configured: false, provider: null } as const;
    }

    protected unavailable<T>(message: string): Promise<T> {
        return Promise.reject(new ServiceUnavailableException(message));
    }
}

@Injectable()
export class DisabledEmailDeliveryProvider extends DisabledProvider implements EmailDeliveryProvider {
    send(request: EmailDeliveryRequest): Promise<EmailDeliverySnapshot> {
        void request;
        return this.unavailable('Email delivery provider is not configured');
    }

    verifyWebhook(request: EmailWebhookRequest): Promise<VerifiedEmailEvent> {
        void request;
        return this.unavailable('Email delivery provider is not configured');
    }
}

@Injectable()
export class DisabledWebPushDeliveryProvider extends DisabledProvider implements WebPushDeliveryProvider {
    send(request: WebPushDeliveryRequest): Promise<WebPushDeliverySnapshot> {
        void request;
        return this.unavailable('Web Push delivery provider is not configured');
    }
}
