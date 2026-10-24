import { z } from 'zod';
const version = z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .max(19);
export const supportAttachmentInputSchema = z.strictObject({
    name: z.string().trim().min(1).max(200),
    type: z.enum([
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
export const supportManageSchema = z.strictObject({
    version,
    idempotencyKey: z.string().uuid(),
    action: z.enum(['assign', 'note', 'edit', 'attach', 'hide']),
    targetId: z.string().uuid().nullable(),
    text: z.string().trim().max(10000),
    attachments: z.array(supportAttachmentInputSchema).max(5),
});
export const supportCreateSchema = z.strictObject({
    idempotencyKey: z.string().uuid(),
    requesterId: z.string().uuid(),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10000),
});
export const supportManagedResultSchema = z.strictObject({ ticketId: z.string().uuid(), version });
export const supportWorkspaceSchema = z.strictObject({
    version,
    assigneeId: z.string().uuid().nullable(),
    staff: z.array(z.strictObject({ id: z.string().uuid(), label: z.string() })),
    messages: z.array(
        z.strictObject({
            id: z.string().uuid(),
            body: z.string(),
            authorId: z.string().uuid(),
            internal: z.boolean(),
            edited: z.boolean(),
            canEdit: z.boolean(),
            revisions: z.array(z.strictObject({ body: z.string(), createdAt: z.string() })),
        }),
    ),
    attachments: z.array(
        supportAttachmentInputSchema.extend({
            id: z.string().uuid(),
            messageId: z.string().uuid(),
            status: z.enum(['uploading', 'pending', 'ready', 'rejected', 'hidden']),
            reason: z.string().nullable(),
        }),
    ),
});
