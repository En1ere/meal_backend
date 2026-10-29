import { z } from 'zod';

export const acceptanceGroupIdSchema = z.enum(['database', 'backend', 'admin', 'frontend']);
export const acceptanceStatusSchema = z.enum(['not_tested', 'passed', 'partial', 'failed']);
export const acceptanceCaseIdSchema = z
    .string()
    .min(3)
    .max(80)
    .regex(/^[a-z][a-z0-9-]+\.[a-z0-9-]+$/);
const timestamp = z.iso.datetime();
const checksum = z.string().regex(/^[0-9a-f]{64}$/);

export const acceptanceActorSchema = z.strictObject({
    id: z.uuid(),
    login: z.string().min(1).max(100),
    displayName: z.string().min(1).max(200).nullable(),
});

export const acceptanceResultSchema = z.strictObject({
    status: acceptanceStatusSchema,
    comment: z.string().max(1000),
    version: z.number().int().min(0),
    checkedBy: acceptanceActorSchema.nullable(),
    checkedAt: timestamp.nullable(),
    updatedAt: timestamp.nullable(),
});

export const acceptanceCaseSchema = z.strictObject({
    id: acceptanceCaseIdSchema,
    displayCode: z.string().regex(/^(?:DB|API|ADMIN|FRONTEND)-\d{2}$/),
    order: z.number().int().positive(),
    title: z.string().min(1).max(240),
    steps: z.array(z.string().min(1).max(2000)).min(1).max(100),
    expectedResult: z.string().min(1).max(2000),
    source: z.strictObject({
        file: z.string().min(1).max(240),
        anchor: z.string().min(1).max(240),
        checksum,
    }),
    result: acceptanceResultSchema,
});

export const acceptanceGroupSchema = z.strictObject({
    id: acceptanceGroupIdSchema,
    title: z.string().min(1).max(80),
    order: z.number().int().positive(),
    cases: z.array(acceptanceCaseSchema).min(1).max(50),
});

export const acceptanceWorkspaceSchema = z.strictObject({
    schemaVersion: z.literal(1),
    catalog: z.strictObject({ version: z.string().min(1).max(80), publishedOn: z.iso.date() }),
    run: z.strictObject({ id: z.uuid(), createdAt: timestamp }).nullable(),
    summary: z.strictObject({
        total: z.number().int().min(0),
        notTested: z.number().int().min(0),
        passed: z.number().int().min(0),
        partial: z.number().int().min(0),
        failed: z.number().int().min(0),
        completed: z.number().int().min(0),
    }),
    groups: z.array(acceptanceGroupSchema).length(4),
});

export const acceptanceUpdateSchema = z.strictObject({
    status: z.enum(['passed', 'partial', 'failed']),
    comment: z.string().trim().max(1000),
    expectedVersion: z.number().int().min(0),
    idempotencyKey: z.uuid(),
});

export const acceptanceResetSchema = z.strictObject({
    expectedVersion: z.number().int().min(0),
    idempotencyKey: z.uuid(),
});

export const acceptanceMutationResultSchema = z.strictObject({
    caseId: acceptanceCaseIdSchema,
    run: z.strictObject({ id: z.uuid(), createdAt: timestamp }),
    result: acceptanceResultSchema,
});

export type AcceptanceStatus = z.infer<typeof acceptanceStatusSchema>;
export type AcceptanceWorkspace = z.infer<typeof acceptanceWorkspaceSchema>;
export type AcceptanceUpdate = z.infer<typeof acceptanceUpdateSchema>;
export type AcceptanceReset = z.infer<typeof acceptanceResetSchema>;
export type AcceptanceMutationResult = z.infer<typeof acceptanceMutationResultSchema>;
