import { z } from 'zod';
import { aiBucketSchema } from '../ai/ai.contracts.js';

export const adminFreeAiViewSchema = z.strictObject({
    user: z.strictObject({
        id: z.uuid(),
        login: z.string(),
        displayName: z.string(),
        status: z.string(),
        version: z.string().regex(/^[1-9][0-9]*$/),
    }),
    buckets: z.array(aiBucketSchema),
    total: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    recentOperations: z.array(
        z.strictObject({
            id: z.uuid(),
            taskId: z.uuid(),
            status: z.string(),
            cost: z.number().int().nonnegative(),
            createdAt: z.iso.datetime(),
        }),
    ),
});

export const adminFreeAiGrantSchema = z.strictObject({
    expectedUserVersion: z.string().regex(/^[1-9][0-9]*$/),
    actions: z.number().int().min(1).max(10_000),
    expiresAt: z.iso.datetime().nullable(),
    reason: z.string().trim().min(1).max(2000),
    idempotencyKey: z.uuid(),
    confirmed: z.literal(true),
});

export const adminFreeAiGrantResultSchema = z.strictObject({
    bucketId: z.uuid(),
    granted: z.number().int().positive(),
    balance: z.number().int().positive(),
    expiresAt: z.iso.datetime().nullable(),
});
