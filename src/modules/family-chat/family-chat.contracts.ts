import { z } from 'zod';

export const chatReactionSchema = z.enum(['like', 'heart', 'laugh', 'surprise']);
export const familyChatQuerySchema = z.strictObject({
    q: z.string().trim().max(100).default(''),
    before: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
});
export const chatMessageCreateSchema = z.strictObject({
    body: z.string().trim().min(1).max(4_000),
    replyToId: z.uuid().nullable().default(null),
    mentionUserIds: z.array(z.uuid()).max(20).default([]),
    idempotencyKey: z.uuid(),
});
export const chatMessageUpdateSchema = z.strictObject({
    body: z.string().trim().min(1).max(4_000),
    mentionUserIds: z.array(z.uuid()).max(20).default([]),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const chatMessageRemoveSchema = z.strictObject({
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const chatMessageHideSchema = z.strictObject({ idempotencyKey: z.uuid() });
export const chatReactionCommandSchema = z.strictObject({
    reaction: chatReactionSchema,
    active: z.boolean(),
    idempotencyKey: z.uuid(),
});
export const chatPinCommandSchema = z.strictObject({ pinned: z.boolean(), idempotencyKey: z.uuid() });
export const chatDraftCommandSchema = z.strictObject({
    body: z.string().max(4_000),
    expectedVersion: z.number().int().positive().nullable(),
    idempotencyKey: z.uuid(),
});
export const chatReadCommandSchema = z.strictObject({ messageId: z.uuid(), idempotencyKey: z.uuid() });

const actorSchema = z.strictObject({ userId: z.uuid(), displayName: z.string() });
const reactionSummarySchema = z.strictObject({
    reaction: chatReactionSchema,
    count: z.number().int().positive(),
    reactedByMe: z.boolean(),
});
export const familyChatMessageSchema = z.strictObject({
    id: z.uuid(),
    body: z.string(),
    author: actorSchema,
    sentAt: z.iso.datetime(),
    editedAt: z.iso.datetime().nullable(),
    removedForAllAt: z.iso.datetime().nullable(),
    replyTo: z
        .strictObject({ id: z.uuid(), body: z.string(), removedForAll: z.boolean(), author: actorSchema })
        .nullable(),
    mentions: z.array(actorSchema),
    reactions: z.array(reactionSummarySchema),
    pinned: z.boolean(),
    canEdit: z.boolean(),
    canRemoveForAll: z.boolean(),
    version: z.number().int().positive(),
});
export const familyChatDraftSchema = z.strictObject({ body: z.string(), version: z.number().int().positive() });
export const familyChatSchema = z.strictObject({
    threadId: z.uuid().nullable(),
    joinedAt: z.iso.datetime(),
    items: z.array(familyChatMessageSchema),
    pinned: z.array(familyChatMessageSchema),
    draft: familyChatDraftSchema.nullable(),
    members: z.array(actorSchema),
    nextBefore: z.iso.datetime().nullable(),
});
export const familyChatMutationSchema = z.strictObject({ message: familyChatMessageSchema.nullable() });
