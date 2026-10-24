import { z } from 'zod';
export const preferenceChangeSchema = z.strictObject({
    channel: z.enum(['browser', 'mobilePush', 'email']),
    enabled: z.boolean(),
});
export const notificationSettingsSchema = z.strictObject({
    preferences: z.strictObject({ browser: z.boolean(), mobilePush: z.boolean(), email: z.boolean() }),
    verifiedEmail: z.string().email().nullable(),
});
export const supportReopenSchema = z.strictObject({
    version: z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .max(19),
    idempotencyKey: z.string().uuid(),
});
export const supportReplySchema = supportReopenSchema.extend({ body: z.string().trim().min(1).max(10000) });
export const supportCommandResultSchema = z.strictObject({
    ticketId: z.string().uuid(),
    version: z.string(),
    status: z.string(),
    assigneeId: z.string().uuid().nullable(),
    messageId: z.string().uuid().nullable(),
});
export type PreferenceChange = z.infer<typeof preferenceChangeSchema>;
export type SupportCommand = z.infer<typeof supportReopenSchema> & { body?: string };
export const supportMessagesSearchSchema = z.strictObject({
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .max(1500)
        .optional(),
    limit: z.number().int().min(1).max(50).default(25),
});
export const supportMessagesSchema = z.strictObject({
    items: z.array(
        z.strictObject({
            id: z.string().uuid(),
            body: z.string(),
            authorId: z.string().uuid(),
            createdAt: z.string().datetime(),
            internal: z.literal(false),
        }),
    ),
    nextCursor: z.string().nullable(),
});
