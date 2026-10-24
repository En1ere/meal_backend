import { z } from 'zod';

export const planCodeSchema = z.enum(['free', 'plus', 'pro']);
export const entitlementSchema = z.strictObject({
    plan: planCodeSchema,
    source: z.enum(['none', 'personal', 'family', 'trial', 'gift']),
    subscriptionId: z.uuid().nullable(),
    familyId: z.uuid().nullable(),
    periodEndsAt: z.iso.datetime().nullable(),
    graceEndsAt: z.iso.datetime().nullable(),
    capabilities: z.strictObject({
        family: z.boolean(),
        qr: z.boolean(),
        planningRange: z.boolean(),
        smartShopping: z.boolean(),
        familyChat: z.boolean(),
        familyNotes: z.boolean(),
        calendar: z.boolean(),
        finance: z.boolean(),
        diary: z.boolean(),
        aiMonthlyAllowance: z.number().int().nonnegative(),
    }),
});

export type Entitlement = z.infer<typeof entitlementSchema>;
export type PlanCode = z.infer<typeof planCodeSchema>;
