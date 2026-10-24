import { z } from 'zod';
export const billingParamsSchema = z.strictObject({
    section: z.enum(['users', 'subscriptions', 'payments']),
    id: z.string().uuid(),
});
export const billingCommandSchema = z.strictObject({
    version: z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .max(19),
    idempotencyKey: z.string().uuid(),
    action: z.enum(['grant', 'extend', 'revokeGift', 'freeze', 'unfreeze', 'refund']),
    plan: z.enum(['plus', 'pro']),
    until: z.string().datetime().nullable(),
    targetId: z.string().uuid().nullable(),
    amountMinor: z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .max(16)
        .nullable(),
    effect: z.enum(['preserve', 'terminate']),
    reason: z.string().trim().min(1).max(5000),
    confirmed: z.literal(true),
    accessConfirmed: z.boolean(),
});
export const billingResultSchema = z.strictObject({ id: z.string().uuid(), version: z.string(), status: z.string() });
export const billingViewSchema = z.strictObject({
    id: z.string().uuid(),
    version: z.string(),
    ownerId: z.string().uuid(),
    payerId: z.string().uuid().nullable(),
    plan: z.string(),
    status: z.string(),
    frozen: z.boolean(),
    quota: z.number().int().min(0),
    refreshAt: z.string().nullable(),
    periods: z.array(
        z.strictObject({
            id: z.string().uuid(),
            source: z.enum(['paid', 'gift']),
            startsAt: z.string(),
            endsAt: z.string(),
            revoked: z.boolean(),
        }),
    ),
    payment: z
        .strictObject({
            paidMinor: z.string(),
            returnedMinor: z.string(),
            reservedMinor: z.string(),
            currency: z.literal('RUB'),
            status: z.string(),
            targetId: z.string().uuid(),
            targetKind: z.enum(['period', 'package']),
            packageRemaining: z.number().int().min(0).nullable(),
        })
        .nullable(),
    history: z.array(z.strictObject({ action: z.string(), reason: z.string(), at: z.string() })),
    notice: z.string(),
});
