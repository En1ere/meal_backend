import { z } from 'zod';

export const criticalPurposeSchema = z.enum(['export', 'account_lifecycle']);
export const criticalReauthRequestSchema = z.strictObject({
    purpose: criticalPurposeSchema,
    password: z.string().min(1).max(1024),
    factor: z.strictObject({ method: z.enum(['totp', 'recovery']), code: z.string().min(6).max(64) }).nullable(),
});
export const criticalReauthResultSchema = z.strictObject({
    reauthToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    purpose: criticalPurposeSchema,
    expiresAt: z.iso.datetime(),
});
export type CriticalPurpose = z.infer<typeof criticalPurposeSchema>;
