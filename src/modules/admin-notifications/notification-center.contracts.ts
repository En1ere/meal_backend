import { z } from 'zod';

export const notificationCategorySchema = z.enum([
    'security',
    'payments',
    'support',
    'moderation',
    'operations',
    'campaigns',
]);
const channels = z.strictObject({ browser: z.boolean(), mobilePush: z.boolean(), email: z.boolean() });
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const notificationCenterSettingsSchema = z.strictObject({
    categories: z.strictObject({
        security: channels,
        payments: channels,
        support: channels,
        moderation: channels,
        operations: channels,
        campaigns: channels,
    }),
    quietHours: z.strictObject({ start: clock, end: clock, timeZone: z.string().min(1).max(100) }),
    thresholds: z.strictObject({
        count: z.number().int().min(1).max(100000),
        windowMinutes: z.number().int().min(1).max(10080),
        repeatMinutes: z.number().int().min(1).max(10080),
    }),
});
export const notificationCenterUpdateSchema = z.strictObject({
    expectedVersion: z.number().int().min(1),
    settings: notificationCenterSettingsSchema,
});
export const notificationReadSchema = z.strictObject({ id: z.uuid() });
export const notificationItemSchema = z.strictObject({
    id: z.uuid(),
    category: notificationCategorySchema,
    title: z.string().max(200),
    summary: z.string().max(1000),
    createdAt: z.iso.datetime(),
    readAt: z.iso.datetime().nullable(),
    occurrences: z.number().int().min(1),
    destination: z.enum([
        '/admin/access',
        '/admin/payments',
        '/admin/support',
        '/admin/queues/recipes',
        '/admin/errors',
        '/admin/news',
    ]),
});
export const notificationCenterSchema = z.strictObject({
    version: z.number().int().min(1),
    settings: notificationCenterSettingsSchema,
    verifiedEmail: z.email().nullable(),
    items: z.array(notificationItemSchema),
    deliveryConnected: z.boolean(),
});
export type NotificationCenterSettings = z.infer<typeof notificationCenterSettingsSchema>;
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;
export type NotificationCenter = z.infer<typeof notificationCenterSchema>;

// Runtime timezone validation is deliberately separate from the portable OpenAPI shape.
export function validNotificationTimeZone(value: string): boolean {
    try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format();
        return true;
    } catch {
        return false;
    }
}
export function notificationQuietNow(
    settings: NotificationCenterSettings,
    category: NotificationCategory,
    now: Date,
): boolean {
    if (category === 'security') return false;
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: settings.quietHours.timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(now);
    const time = `${parts.find((part) => part.type === 'hour')!.value}:${parts.find((part) => part.type === 'minute')!.value}`;
    const { start, end } = settings.quietHours;
    return start < end ? time >= start && time < end : time >= start || time < end;
}
