import { z } from 'zod';
export const operationSchema = z.enum(['retry', 'cancel', 'new', 'in_progress', 'resolved', 'ignored']);
export const operationsCommandSchema = z.strictObject({
    section: z.enum(['operations', 'errors']),
    id: z.uuid(),
    action: z.enum(['inspect', 'preview', 'execute']),
    operation: operationSchema,
    reason: z.string().trim().max(2000),
    ignoreUntil: z.iso.datetime().nullable(),
    expectedVersion: z.string().max(100),
    idempotencyKey: z.uuid(),
});
export const operationsResultSchema = z.strictObject({
    id: z.uuid(),
    version: z.string(),
    status: z.string(),
    kind: z.string(),
    failure: z.string(),
    allowed: z.array(z.strictObject({ operation: operationSchema, enabled: z.boolean(), reason: z.string() })),
    preview: z.strictObject({ summary: z.string(), critical: z.boolean() }).nullable(),
    message: z.string(),
});
export type OperationsResult = z.infer<typeof operationsResultSchema>;
export type Operation = z.infer<typeof operationSchema>;
