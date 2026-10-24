import { z } from 'zod';

const text = z.string().trim().min(1).max(10000);
const url = z.url().refine((value) => new URL(value).protocol === 'https:', 'Требуется HTTPS-ссылка');
export const newsAudienceSchema = z
    .strictObject({
        plans: z.array(z.enum(['free', 'plus', 'pro'])).max(3),
        genders: z.array(z.enum(['female', 'male', 'unknown'])).max(3),
        families: z.array(z.enum(['yes', 'no'])).max(2),
        registeredFrom: z.iso.datetime().nullable(),
        registeredTo: z.iso.datetime().nullable(),
        activeFrom: z.iso.datetime().nullable(),
        activeTo: z.iso.datetime().nullable(),
    })
    .refine(
        (a) =>
            (!a.registeredFrom || !a.registeredTo || a.registeredFrom <= a.registeredTo) &&
            (!a.activeFrom || !a.activeTo || a.activeFrom <= a.activeTo),
        'Начало диапазона позже окончания',
    );
export const newsContentSchema = z.strictObject({
    type: z.enum(['article', 'important']).default('article'),
    title: z.string().trim().min(1).max(200),
    pages: z
        .array(
            z.strictObject({
                blocks: z
                    .array(
                        z.discriminatedUnion('kind', [
                            z.strictObject({ kind: z.literal('text'), text }),
                            z.strictObject({ kind: z.literal('image'), url, alt: z.string().trim().min(1).max(300) }),
                            z.strictObject({ kind: z.literal('link'), url, text: z.string().trim().min(1).max(300) }),
                        ]),
                    )
                    .min(1)
                    .max(30),
            }),
        )
        .min(1)
        .max(10),
    sources: z.array(z.strictObject({ claim: z.string().trim().min(1).max(500), source: text })).max(30),
    audience: newsAudienceSchema,
    channels: z
        .array(z.enum(['in_app', 'email', 'push']))
        .min(1)
        .max(3),
    category: z.enum(['service', 'marketing']),
});
export const newsItemSchema = z.strictObject({
    id: z.uuid(),
    version: z.number().int().positive(),
    content: newsContentSchema,
    status: z.enum(['draft', 'scheduled', 'published', 'cancelled']),
    scheduledAt: z.iso.datetime().nullable(),
    history: z.array(z.strictObject({ version: z.number().int(), at: z.iso.datetime(), content: newsContentSchema })),
});
const target = { id: z.uuid(), version: z.number().int().positive() };
const key = { idempotencyKey: z.uuid() };
export const newsCommandSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('list') }),
    z.strictObject({
        action: z.literal('save'),
        id: z.uuid(),
        version: z.number().int().min(0),
        content: newsContentSchema,
        ...key,
    }),
    z.strictObject({ action: z.literal('preview'), ...target }),
    z.strictObject({ action: z.literal('launch'), ...target, ...key, scheduledAt: z.iso.datetime().nullable() }),
    z.strictObject({ action: z.literal('cancel'), ...target, ...key }),
    z.strictObject({
        action: z.literal('test'),
        ...target,
        ...key,
        recipients: z
            .array(z.enum(['admin', 'moderator']))
            .min(1)
            .max(2),
    }),
]);
export const newsResultSchema = z.strictObject({
    items: z.array(newsItemSchema),
    preview: z
        .strictObject({
            id: z.uuid(),
            version: z.number().int(),
            recipients: z.number().int().min(0),
            preliminary: z.literal(true),
            mock: z.boolean(),
        })
        .nullable(),
    message: z.string(),
});
export type NewsCommand = z.infer<typeof newsCommandSchema>;
export type NewsResult = z.infer<typeof newsResultSchema>;
export type NewsItem = z.infer<typeof newsItemSchema>;
export type NewsContent = z.infer<typeof newsContentSchema>;

export const publicNewsBlockSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text'), text }),
    z.strictObject({ kind: z.literal('image'), url, alt: z.string().trim().min(1).max(300) }),
    z.strictObject({ kind: z.literal('link'), url, text: z.string().trim().min(1).max(300) }),
]);
export const publicNewsCardSchema = z.strictObject({
    id: z.uuid(),
    type: z.enum(['article', 'important']),
    title: z.string(),
    publishedAt: z.iso.datetime(),
    coverImage: z.strictObject({ url, alt: z.string() }).nullable(),
    pageCount: z.number().int().positive(),
});
export const publicNewsListSchema = z.strictObject({
    items: z.array(publicNewsCardSchema),
    nextCursor: z.string().nullable(),
});
export const publicNewsDetailSchema = publicNewsCardSchema.extend({
    pages: z.array(z.strictObject({ blocks: z.array(publicNewsBlockSchema) })).min(1),
    readAt: z.iso.datetime().nullable(),
});
export const publicNewsQuerySchema = z.strictObject({
    cursor: z.string().trim().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const newsReadSchema = z.strictObject({ idempotencyKey: z.uuid() });
export const newsReadResultSchema = z.strictObject({ id: z.uuid(), readAt: z.iso.datetime() });
