import { z } from 'zod';
export const reviewParamsSchema = z.strictObject({ section: z.enum(['legal-requests', 'rollback']), id: z.uuid() });
export const reviewResultSchema = z.strictObject({
    section: z.enum(['legal-requests', 'rollback']),
    id: z.uuid(),
    version: z.number().int().positive(),
    status: z.string(),
    requesterId: z.uuid().nullable(),
    identityVerified: z.boolean(),
    identityEvidence: z.string().nullable(),
    dependencies: z.array(
        z.strictObject({ label: z.string(), state: z.enum(['ready', 'blocked', 'info']), detail: z.string() }),
    ),
    exportData: z
        .strictObject({
            id: z.uuid(),
            expiresAt: z.iso.datetime(),
            status: z.enum(['ready', 'expired']),
            sections: z.array(z.string()),
        })
        .nullable(),
    items: z.array(
        z.strictObject({
            id: z.uuid(),
            targetId: z.uuid(),
            before: z.string(),
            after: z.string(),
            current: z.string(),
            expectedVersion: z.number().int(),
            actualVersion: z.number().int(),
            state: z.enum(['ready', 'conflict', 'blocked', 'applied']),
            reason: z.string(),
        }),
    ),
    history: z.array(
        z.strictObject({ action: z.string(), reason: z.string(), actor: z.string(), at: z.iso.datetime() }),
    ),
    previewKey: z.string().nullable(),
    message: z.string(),
    relatedRequests: z.array(z.strictObject({ id: z.uuid(), label: z.string() })),
});
export const reviewPreviewSchema = z.strictObject({ version: z.number().int().positive() });
export const reviewExecuteSchema = z.strictObject({
    version: z.number().int().positive(),
    previewKey: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
    idempotencyKey: z.uuid(),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type ReviewCommand =
    | { action: 'load' }
    | { action: 'preview'; data: z.infer<typeof reviewPreviewSchema> }
    | { action: 'prepare-export' | 'apply-rollback'; data: z.infer<typeof reviewExecuteSchema> };
