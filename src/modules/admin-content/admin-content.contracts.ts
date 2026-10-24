import { z } from 'zod';
export const contentSectionSchema = z.enum(['queues', 'catalog']);
export const contentParamsSchema = z.strictObject({ section: contentSectionSchema, id: z.uuid() });
const fields = z.record(z.string(), z.string().nullable());
export const contentRevisionSchema = z.strictObject({ id: z.uuid(), version: z.number().int().positive(), fields });
export const contentCardSchema = z.strictObject({
    id: z.uuid(),
    version: z.number().int().positive(),
    name: z.string(),
    fields,
    variants: z.array(z.string()),
    authors: z.array(z.string()),
    sources: z.array(z.string()),
    aliasOf: z.uuid().nullable(),
});
export const contentResultSchema = z.strictObject({
    section: contentSectionSchema,
    id: z.uuid(),
    version: z.number().int().positive(),
    current: contentRevisionSchema.nullable(),
    pending: contentRevisionSchema.nullable(),
    status: z.string(),
    history: z.array(
        z.strictObject({ action: z.string(), reason: z.string(), actor: z.string(), at: z.iso.datetime() }),
    ),
    cards: z.array(contentCardSchema),
    comparison: z
        .strictObject({
            left: contentCardSchema,
            right: contentCardSchema,
            conflicts: z.array(z.string()),
            blockedReason: z.string().nullable(),
            resolved: fields,
            canonicalId: z.uuid(),
            previewKey: z.string(),
        })
        .nullable(),
    message: z.string(),
});
const key = { idempotencyKey: z.uuid() };
export const contentModerateSchema = z
    .strictObject({
        action: z.enum(['approve', 'reject', 'hide', 'unpublish']),
        version: z.number().int().positive(),
        reason: z.string().trim().max(2000),
        ...key,
    })
    .refine((c) => c.action === 'approve' || c.reason.length > 0, 'Укажите причину');
export const contentCompareSchema = z.strictObject({
    leftId: z.uuid(),
    rightId: z.uuid(),
    leftVersion: z.number().int().positive(),
    rightVersion: z.number().int().positive(),
    canonicalId: z.uuid(),
    choices: z.record(z.string(), z.enum(['left', 'right'])),
});
export const contentMergeSchema = contentCompareSchema.extend({
    previewKey: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
    ...key,
});
export const contentNotDuplicateSchema = z.strictObject({
    leftId: z.uuid(),
    rightId: z.uuid(),
    leftVersion: z.number().int().positive(),
    rightVersion: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2000),
    ...key,
});
export type ContentResult = z.infer<typeof contentResultSchema>;
export type ContentCard = z.infer<typeof contentCardSchema>;
export type ContentCompare = z.infer<typeof contentCompareSchema>;
export type ContentCommand =
    | { action: 'load' }
    | { action: 'moderate'; data: z.infer<typeof contentModerateSchema> }
    | { action: 'compare'; data: ContentCompare }
    | { action: 'merge'; data: z.infer<typeof contentMergeSchema> }
    | { action: 'not-duplicate'; data: z.infer<typeof contentNotDuplicateSchema> };
