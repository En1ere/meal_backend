import { z } from 'zod';

export const adminSectionSchema = z.enum([
    'overview',
    'queues',
    'users',
    'sanctions',
    'subscriptions',
    'families',
    'payments',
    'support',
    'catalog',
    'news',
    'audit',
    'rollback',
    'legal-requests',
    'operations',
    'errors',
    'metrics',
    'access',
]);
export type AdminSection = z.infer<typeof adminSectionSchema>;
export const adminSearchSchema = z.strictObject({
    queue: z.literal('recipes').optional(),
    query: z.string().trim().max(100).optional(),
    status: z.string().trim().max(64).optional(),
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .max(1500)
        .optional(),
    limit: z.number().int().min(1).max(50).optional(),
});
export type AdminSearch = z.infer<typeof adminSearchSchema>;
export const adminRecordSchema = z.strictObject({
    id: z.string().uuid(),
    title: z.string(),
    status: z.string().nullable(),
    updatedAt: z.string().datetime().nullable(),
    version: z.string(),
    fields: z.array(z.strictObject({ key: z.string(), label: z.string(), value: z.string().nullable() })),
    related: z.array(z.strictObject({ label: z.string(), section: adminSectionSchema, id: z.string().uuid() })),
    actions: z.array(
        z.strictObject({ key: z.string(), label: z.string(), enabled: z.boolean(), reason: z.string().nullable() }),
    ),
});
export type AdminRecord = z.infer<typeof adminRecordSchema>;
export const adminPageSchema = z.strictObject({
    section: adminSectionSchema,
    availability: z.enum(['available', 'unavailable', 'requires_query']),
    reason: z.string().nullable(),
    items: z.array(adminRecordSchema),
    nextCursor: z.string().nullable(),
});
export const adminDetailSchema = z.strictObject({
    section: adminSectionSchema,
    item: adminRecordSchema,
    collections: z.array(z.strictObject({ key: z.string(), label: z.string() })),
});
export const adminRelatedSearchSchema = z.strictObject({
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .max(1500)
        .optional(),
    limit: z.number().int().min(1).max(50).optional(),
});
export const adminRelatedPageSchema = z.strictObject({
    items: z.array(adminRecordSchema),
    nextCursor: z.string().nullable(),
});
export type AdminRelatedSearch = z.infer<typeof adminRelatedSearchSchema>;
