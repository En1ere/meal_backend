import { z } from 'zod';

export const notificationCategorySchema = z.enum([
    'security',
    'inventory',
    'planning',
    'cooking',
    'family',
    'community',
    'moderation',
    'support',
    'subscription',
    'ai',
    'achievements',
    'news',
]);
export const notificationPrioritySchema = z.enum(['critical', 'important', 'informational', 'marketing']);
export const notificationItemSchema = z.strictObject({
    id: z.uuid(),
    category: notificationCategorySchema,
    priority: notificationPrioritySchema,
    title: z.string(),
    body: z.string(),
    href: z.string().nullable(),
    occurredAt: z.iso.datetime(),
    readAt: z.iso.datetime().nullable(),
    groupedCount: z.number().int().positive(),
    version: z.number().int().positive(),
});
export const notificationListQuerySchema = z
    .object({
        category: z.union([z.literal('all'), notificationCategorySchema]).default('all'),
        unread: z.enum(['0', '1']).default('0'),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        offset: z.coerce.number().int().min(0).max(10000).default(0),
    })
    .strict();
export const notificationListSchema = z.strictObject({
    items: z.array(notificationItemSchema),
    total: z.number().int().nonnegative(),
    unreadCount: z.number().int().nonnegative(),
    categoryCounts: z.record(notificationCategorySchema, z.number().int().nonnegative()),
});
const command = z.strictObject({ expectedVersion: z.number().int().positive(), idempotencyKey: z.uuid() });
export const notificationReadSchema = command;
export const notificationReadAllSchema = z.strictObject({
    category: z.union([z.literal('all'), notificationCategorySchema]),
    idempotencyKey: z.uuid(),
});
export const notificationMutationSchema = z.strictObject({ updated: z.number().int().nonnegative() });
export const notificationPreferenceSchema = z.strictObject({
    category: notificationCategorySchema,
    push: z.boolean(),
    email: z.boolean(),
});
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const notificationPreferencesSchema = z.strictObject({
    categories: z.array(notificationPreferenceSchema).length(notificationCategorySchema.options.length),
    quietHours: z.strictObject({ start: time, end: time }),
    planReminderTime: time,
    timezone: z.string(),
    urgentFoodRisk: z.boolean(),
    version: z.number().int().positive(),
    deliveryAvailable: z.strictObject({ push: z.boolean(), email: z.boolean() }),
});
export const notificationPreferencesUpdateSchema = notificationPreferencesSchema
    .omit({ version: true, deliveryAvailable: true })
    .extend({ expectedVersion: z.number().int().positive(), idempotencyKey: z.uuid() })
    .strict()
    .superRefine((value, ctx) => {
        if (value.quietHours.start === value.quietHours.end)
            ctx.addIssue({
                code: 'custom',
                path: ['quietHours'],
                message: 'Начало и конец тихих часов должны различаться',
            });
        try {
            new Intl.DateTimeFormat('en', { timeZone: value.timezone });
        } catch {
            ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'Неизвестный часовой пояс' });
        }
        if (new Set(value.categories.map((x) => x.category)).size !== notificationCategorySchema.options.length)
            ctx.addIssue({
                code: 'custom',
                path: ['categories'],
                message: 'Каждая категория должна быть указана один раз',
            });
    });
export const notificationCategories = [
    ['security', 'Безопасность'],
    ['inventory', 'Запасы и сроки'],
    ['planning', 'План питания'],
    ['cooking', 'Приготовление'],
    ['family', 'Семья'],
    ['community', 'Комментарии и рецепты'],
    ['moderation', 'Модерация'],
    ['support', 'Поддержка'],
    ['subscription', 'Тариф и trial'],
    ['ai', 'AI-лимиты'],
    ['achievements', 'Достижения'],
    ['news', 'Новости и предложения'],
] as const;
