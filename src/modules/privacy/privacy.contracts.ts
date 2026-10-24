import { z } from 'zod';

export const privacyStateSchema = z.strictObject({
    version: z.number().int().nonnegative(),
    aiAccess: z.strictObject({
        enabled: z.boolean(),
        acceptedAt: z.iso.datetime().nullable(),
        consentVersion: z.string().nullable(),
        enableAvailable: z.boolean(),
        demonstration: z.boolean(),
    }),
});
export const privacyUpdateSchema = z.strictObject({
    enabled: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
    consentVersion: z.string().max(100).nullable(),
    accepted: z.boolean(),
    idempotencyKey: z.uuid(),
});
