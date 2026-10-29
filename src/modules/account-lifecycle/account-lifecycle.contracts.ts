import { z } from 'zod';

export const lifecycleBlockerSchema = z.strictObject({
    code: z.enum([
        'family_owner',
        'active_subscription',
        'payment_records',
        'support_history',
        'audit_history',
        'legal_hold',
        'retention_policy_unconfigured',
        'retention_policy_changed',
        'admin_approval_required',
        'retention_wait',
        'export_not_ready',
        'backup_exclusion',
    ]),
    message: z.string().min(1).max(400),
    blocksFinalization: z.boolean(),
});
export const deletionRequestSchema = z.strictObject({
    id: z.uuid(),
    status: z.enum(['requested', 'retention_wait', 'ready', 'cancelled', 'rejected', 'finalized', 'blocked']),
    requestedAt: z.iso.datetime(),
    cancelUntil: z.iso.datetime().nullable(),
    finalizationNotBefore: z.iso.datetime().nullable(),
    cancelledAt: z.iso.datetime().nullable(),
    finalizedAt: z.iso.datetime().nullable(),
    policyVersion: z.string().nullable(),
    blockers: z.array(lifecycleBlockerSchema),
    version: z.number().int().positive(),
});
export const lifecycleStateSchema = z.strictObject({
    archived: z.boolean(),
    deletion: deletionRequestSchema.nullable(),
});
export const archiveAccountSchema = z.strictObject({
    reauthToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    idempotencyKey: z.uuid(),
});
export const archiveResultSchema = z.strictObject({ archived: z.literal(true) });
export const deletionPreviewSchema = z.strictObject({
    canRequest: z.literal(true),
    canFinalize: z.boolean(),
    blockers: z.array(lifecycleBlockerSchema),
    policyVersion: z.string().nullable(),
    finalizationNotBefore: z.iso.datetime().nullable(),
});
export const requestDeletionSchema = z.strictObject({
    reauthToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    idempotencyKey: z.uuid(),
    acknowledgement: z.literal(true),
});
export const deletionCommandSchema = z.strictObject({
    reauthToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expectedVersion: z.number().int().positive(),
});
export const retentionRunResultSchema = z.strictObject({
    inspected: z.number().int().nonnegative(),
    finalized: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
});
export const adminDeletionDecisionSchema = z.strictObject({
    decision: z.enum(['approve', 'reject']),
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(10).max(1000),
    idempotencyKey: z.uuid(),
});
