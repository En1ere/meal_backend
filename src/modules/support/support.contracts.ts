import { z } from 'zod';

export const supportCategories = [
    ['general', 'Общий вопрос'],
    ['ai_appeal', 'Обращение по AI'],
    ['ownership_change', 'Смена владельца семьи'],
    ['insurance_extension', 'Продление срока хранения'],
    ['payments', 'Оплата и тариф'],
    ['complaints', 'Жалоба'],
    ['recipe_authorship', 'Рецепт и авторство'],
] as const;
export const supportCategorySchema = z.enum(supportCategories.map(([code]) => code));
export const supportStatusSchema = z.enum(['open', 'waiting_for_support', 'waiting_for_user', 'closed']);
export const supportAttachmentSchema = z.strictObject({
    id: z.uuid(),
    name: z.string(),
    mime: z.string(),
    size: z.number().int().nonnegative(),
    duration: z.number().nonnegative().nullable(),
    status: z.enum(['pending', 'ready', 'rejected', 'hidden']),
    downloadUrl: z.string().nullable(),
});
export const supportMessageSchema = z.strictObject({
    id: z.uuid(),
    body: z.string(),
    author: z.enum(['user', 'support']),
    authorLabel: z.string(),
    own: z.boolean(),
    createdAt: z.iso.datetime(),
    edited: z.boolean(),
    version: z.number().int().positive(),
    attachments: z.array(supportAttachmentSchema),
});
export const supportTicketSchema = z.strictObject({
    id: z.uuid(),
    number: z.string(),
    category: supportCategorySchema,
    categoryLabel: z.string(),
    status: supportStatusSchema,
    statusLabel: z.string(),
    subject: z.string(),
    createdAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
    version: z.number().int().positive(),
});
export const supportListSchema = z.strictObject({
    items: z.array(supportTicketSchema),
    total: z.number().int().nonnegative(),
});
export const supportDetailSchema = z.strictObject({
    ticket: supportTicketSchema,
    messages: z.array(supportMessageSchema),
});
export const supportMetaSchema = z.strictObject({
    categories: z.array(z.strictObject({ code: supportCategorySchema, label: z.string() })),
    uploadMode: z.enum(['unavailable', 'simulation', 'ready']),
    attachmentPolicy: z.strictObject({
        maxFiles: z.literal(5),
        maxBytes: z.literal(10485760),
        maxVideoSeconds: z.literal(10),
        mime: z.array(z.string()),
    }),
});
export const supportListQuerySchema = z.object({
    category: supportCategorySchema.or(z.literal('all')).catch('all'),
    status: supportStatusSchema.or(z.enum(['all', 'active'])).catch('all'),
    limit: z.coerce.number().int().min(1).max(50).catch(20),
    offset: z.coerce.number().int().min(0).catch(0),
});
const attachmentInput = z.strictObject({
    name: z.string().trim().min(1).max(255),
    mime: z.enum([
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/pdf',
        'video/mp4',
        'video/webm',
        'video/quicktime',
    ]),
    size: z.number().int().min(1).max(10485760),
    duration: z.number().min(0).max(10).nullable(),
});
const mutation = { idempotencyKey: z.uuid(), expectedVersion: z.number().int().positive() };
export const supportCreateSchema = z.strictObject({
    category: supportCategorySchema,
    subject: z.string().trim().min(3).max(160),
    body: z.string().trim().min(1).max(10000),
    attachments: z.array(attachmentInput).max(5).default([]),
    idempotencyKey: z.uuid(),
});
export const supportReplySchema = z.strictObject({
    body: z.string().trim().min(1).max(10000),
    attachments: z.array(attachmentInput).max(5).default([]),
    ...mutation,
});
export const supportEditSchema = z.strictObject({
    body: z.string().trim().min(1).max(10000),
    messageVersion: z.number().int().positive(),
    ...mutation,
});
export const supportStateSchema = z.strictObject(mutation);
