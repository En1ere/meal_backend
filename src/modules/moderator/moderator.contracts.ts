import { z } from 'zod';

export const moderatorQueueSchema = z.enum([
    'recipes',
    'recipe_variants',
    'products',
    'reports',
    'support',
    'authorship',
]);

export const moderatorQueueSummarySchema = z.strictObject({
    key: moderatorQueueSchema,
    title: z.string(),
    count: z.number().int().nonnegative().nullable(),
    available: z.boolean(),
});

export const moderatorQueueItemSchema = z.strictObject({
    id: z.uuid(),
    queue: moderatorQueueSchema,
    title: z.string(),
    status: z.string(),
    assignment: z.enum(['unassigned', 'mine', 'other']),
    priority: z.enum(['normal', 'high', 'critical']),
    dueAt: z.iso.datetime().nullable(),
    version: z.number().int().positive(),
    canClaim: z.boolean(),
    canSkip: z.boolean(),
    canOpen: z.boolean(),
});

export const moderatorOverviewSchema = z.strictObject({
    queues: z.array(moderatorQueueSummarySchema),
    assigned: z.array(moderatorQueueItemSchema),
    sla: z.strictObject({ state: z.enum(['normal', 'attention', 'unknown']), label: z.string() }),
});

export const moderatorQueuePageSchema = z.strictObject({
    queue: moderatorQueueSchema,
    title: z.string(),
    items: z.array(moderatorQueueItemSchema),
    nextCursor: z.string().nullable(),
});

const materialSchema = z.strictObject({ title: z.string(), content: z.string() });
export const moderatorItemSchema = z.strictObject({
    id: z.uuid(),
    queue: moderatorQueueSchema,
    title: z.string(),
    status: z.string(),
    version: z.number().int().positive(),
    assignment: z.enum(['unassigned', 'mine', 'other']),
    publicView: materialSchema,
    original: materialSchema.nullable(),
    context: z.array(z.string()),
    signals: z.array(z.string()),
    related: z.array(z.strictObject({ id: z.uuid(), title: z.string() })),
    actions: z.array(z.enum(['approve', 'reject', 'publish', 'hide', 'unpublish'])),
});

export const moderatorClaimSchema = z.strictObject({
    version: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});

export const moderatorDecisionSchema = z.strictObject({
    action: z.enum(['approve', 'reject', 'publish', 'hide', 'unpublish']),
    category: z.string().trim().min(1).max(100),
    reason: z.string().trim().min(3).max(1000),
    version: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});

export const moderatorSupportSchema = z.strictObject({
    id: z.uuid(),
    version: z.number().int().positive(),
    subject: z.string(),
    status: z.string(),
    category: z.string(),
    assignment: z.enum(['unassigned', 'mine', 'other']),
    context: z.array(z.string()),
    related: z.strictObject({ id: z.uuid(), title: z.string(), href: z.string() }).nullable(),
    messages: z.array(
        z.strictObject({
            id: z.uuid(),
            author: z.enum(['user', 'support']),
            body: z.string(),
            createdAt: z.iso.datetime(),
        }),
    ),
    canReply: z.boolean(),
    canReopen: z.boolean(),
});

export const moderatorSupportReplySchema = z.strictObject({
    message: z.string().trim().min(1).max(10000),
    version: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});

export const moderatorSupportReopenSchema = z.strictObject({
    version: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
