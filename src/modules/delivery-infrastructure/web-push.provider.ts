import { Inject, Injectable } from '@nestjs/common';
import webPush from 'web-push';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import {
    type WebPushDeliveryProvider,
    type WebPushDeliveryRequest,
    webPushDeliverySnapshotSchema,
} from './delivery-provider.js';

type Failure = {
    code: 'subscription_gone' | 'http_429' | 'http_5xx' | 'http_4xx' | 'http_other' | 'network_unknown';
    retryable: boolean;
    retryAfterSeconds: number | null;
};
const header = (value: unknown) =>
    typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
function retryAfterSeconds(value: unknown, now: Date) {
    const text = header(value)?.trim();
    if (!text) return null;
    if (/^\d{1,4}$/.test(text)) {
        const seconds = Number(text);
        return seconds >= 1 && seconds <= 3600 ? seconds : null;
    }
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return null;
    const seconds = Math.ceil((at - now.getTime()) / 1000);
    return seconds >= 1 && seconds <= 3600 ? seconds : null;
}
export function classifyWebPushFailure(error: unknown, now = new Date()) {
    const source = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
    const status = Number.isInteger(Number(source.statusCode)) ? Number(source.statusCode) : 0;
    const headers =
        typeof source.headers === 'object' && source.headers !== null
            ? (source.headers as Record<string, unknown>)
            : {};
    const retryAfter = retryAfterSeconds(headers['retry-after'], now);
    let state: 'gone' | 'failed' | 'unknown';
    let failure: Failure;
    if (status === 404 || status === 410) {
        state = 'gone';
        failure = { code: 'subscription_gone', retryable: false, retryAfterSeconds: null };
    } else if (status === 429) {
        state = 'failed';
        failure = { code: 'http_429', retryable: true, retryAfterSeconds: retryAfter };
    } else if (status >= 500 && status <= 599) {
        state = 'failed';
        failure = { code: 'http_5xx', retryable: true, retryAfterSeconds: retryAfter };
    } else if (status >= 400 && status <= 499) {
        state = 'failed';
        failure = { code: 'http_4xx', retryable: false, retryAfterSeconds: null };
    } else if (status > 0) {
        state = 'failed';
        failure = { code: 'http_other', retryable: false, retryAfterSeconds: null };
    } else {
        state = 'unknown';
        failure = { code: 'network_unknown', retryable: false, retryAfterSeconds: null };
    }
    return { state, failure };
}

@Injectable()
export class VapidWebPushProvider implements WebPushDeliveryProvider {
    constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
        if (config.WEB_PUSH_ENABLED)
            webPush.setVapidDetails(
                config.WEB_PUSH_VAPID_SUBJECT,
                config.WEB_PUSH_VAPID_PUBLIC_KEY!,
                config.WEB_PUSH_VAPID_PRIVATE_KEY!,
            );
    }
    status() {
        return this.config.WEB_PUSH_ENABLED
            ? ({ configured: true, provider: 'web-push' } as const)
            : ({ configured: false, provider: null } as const);
    }
    async send(request: WebPushDeliveryRequest) {
        try {
            const response = await webPush.sendNotification(
                {
                    endpoint: request.subscription.endpoint,
                    keys: { p256dh: request.subscription.p256dh, auth: request.subscription.auth },
                },
                JSON.stringify(request.content),
                { TTL: request.ttlSeconds, urgency: request.urgency, topic: request.topic ?? 'meal', timeout: 15_000 },
            );
            return webPushDeliverySnapshotSchema.parse({
                provider: 'web-push',
                externalId: response.headers.location ?? null,
                deliveryId: request.deliveryId,
                subscriptionId: request.subscription.subscriptionId,
                state: 'accepted',
                occurredAt: new Date().toISOString(),
                failure: null,
            });
        } catch (error) {
            const classified = classifyWebPushFailure(error);
            return webPushDeliverySnapshotSchema.parse({
                provider: 'web-push',
                externalId: null,
                deliveryId: request.deliveryId,
                subscriptionId: request.subscription.subscriptionId,
                state: classified.state,
                occurredAt: new Date().toISOString(),
                failure: classified.failure,
            });
        }
    }
}
