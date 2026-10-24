import { z } from 'zod';
import { planCodeSchema } from '../entitlements/entitlements.contracts.js';

export const billingPeriodSchema = z.enum(['month', 'year']);

export const subscriptionSettingsSchema = z.strictObject({
    version: z.number().int().positive(),
    current: z.strictObject({
        plan: planCodeSchema,
        source: z.enum(['none', 'personal', 'family', 'trial', 'gift']),
        subscriptionId: z.uuid().nullable(),
        period: billingPeriodSchema.nullable(),
        startsAt: z.iso.datetime().nullable(),
        endsAt: z.iso.datetime().nullable(),
        autoRenew: z.boolean(),
        downgradeToFreeAt: z.iso.datetime().nullable(),
        scheduledPlan: planCodeSchema.nullable(),
    }),
    ai: z.strictObject({
        buckets: z.array(
            z.strictObject({
                id: z.uuid(),
                kind: z.enum(['subscription', 'transferred', 'family_reserve', 'purchased', 'trial']),
                granted: z.number().int().nonnegative(),
                balance: z.number().int().nonnegative(),
                reserved: z.number().int().nonnegative(),
                available: z.number().int().nonnegative(),
                expiresAt: z.iso.datetime().nullable(),
            }),
        ),
        total: z.number().int().nonnegative(),
        reserved: z.number().int().nonnegative(),
        available: z.number().int().nonnegative(),
    }),
    trial: z.strictObject({
        eligible: z.boolean(),
        reason: z.enum(['already_used', 'family_history', 'active_subscription', 'account_inactive']).nullable(),
        durationDays: z.literal(7),
        aiActions: z.literal(10),
    }),
    prices: z.strictObject({
        plus: z.strictObject({
            month: z.strictObject({ amountMinor: z.literal(39900), currency: z.literal('RUB') }),
            year: z.strictObject({ amountMinor: z.literal(389900), currency: z.literal('RUB') }),
        }),
        pro: z.strictObject({
            month: z.strictObject({ amountMinor: z.literal(59900), currency: z.literal('RUB') }),
            year: z.strictObject({ amountMinor: z.literal(589900), currency: z.literal('RUB') }),
        }),
    }),
    promotion: z
        .strictObject({
            offerId: z.uuid(),
            code: z.literal('post_trial_pro_10'),
            expiresAt: z.iso.datetime(),
            monthAmountMinor: z.literal(53900),
            yearAmountMinor: z.literal(530900),
            nextMonthAmountMinor: z.literal(59900),
            nextYearAmountMinor: z.literal(589900),
        })
        .nullable(),
    combination: z.strictObject({
        eligible: z.boolean(),
        reason: z.enum(['not_in_family', 'personal_plus_required', 'second_plus_required']).nullable(),
        familyId: z.uuid().nullable(),
        candidates: z.array(
            z.strictObject({
                userId: z.uuid(),
                displayName: z.string().min(1),
                subscriptionId: z.uuid(),
                endsAt: z.iso.datetime(),
            }),
        ),
        pending: z
            .strictObject({
                previewId: z.uuid(),
                combinationId: z.uuid(),
                recipientId: z.uuid(),
                endsAt: z.iso.datetime(),
                acceptedUserIds: z.array(z.uuid()),
                requiredUserIds: z.array(z.uuid()),
            })
            .nullable(),
    }),
});

export const versionedCommandSchema = z.strictObject({
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});

export const plusPreviewRequestSchema = versionedCommandSchema.extend({ period: billingPeriodSchema }).strict();

export const planPreviewRequestSchema = versionedCommandSchema
    .extend({
        targetPlan: z.enum(['plus', 'pro']),
        period: billingPeriodSchema,
        timing: z.enum(['now', 'period_end']),
        promotionOfferId: z.uuid().nullable().default(null),
    })
    .strict();

export const subscriptionPreviewSchema = z.strictObject({
    previewId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    plan: z.literal('plus'),
    period: billingPeriodSchema,
    amountMinor: z.number().int().positive(),
    currency: z.literal('RUB'),
    paymentMode: z.literal('simulation'),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
});

export const previewCommitSchema = z.strictObject({
    previewId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});

export const planChangePreviewSchema = z.strictObject({
    previewId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    operation: z.enum(['purchase', 'upgrade', 'scheduled_upgrade']),
    currentPlan: planCodeSchema,
    targetPlan: z.enum(['plus', 'pro']),
    period: billingPeriodSchema,
    timing: z.enum(['now', 'period_end']),
    fullAmountMinor: z.number().int().nonnegative(),
    creditMinor: z.number().int().nonnegative(),
    amountMinor: z.number().int().nonnegative(),
    currency: z.literal('RUB'),
    paymentMode: z.literal('simulation'),
    promotionOfferId: z.uuid().nullable(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    nextChargeAt: z.iso.datetime(),
    nextAmountMinor: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
});

export const renewalPreviewRequestSchema = versionedCommandSchema.extend({ enabled: z.boolean() }).strict();
export const renewalPreviewSchema = z.strictObject({
    previewId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    subscriptionId: z.uuid(),
    plan: z.enum(['plus', 'pro']),
    enabled: z.boolean(),
    nextChargeAt: z.iso.datetime(),
    nextAmountMinor: z.number().int().positive(),
    currency: z.literal('RUB'),
    paymentMode: z.literal('simulation'),
    expiresAt: z.iso.datetime(),
});

export const downgradePreviewRequestSchema = versionedCommandSchema
    .extend({ targetPlan: z.enum(['free', 'plus']).default('free') })
    .strict();

export const downgradePreviewSchema = z.strictObject({
    previewId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    subscriptionId: z.uuid(),
    currentPlan: z.enum(['plus', 'pro']),
    targetPlan: z.enum(['free', 'plus']),
    effectiveAt: z.iso.datetime(),
    period: billingPeriodSchema.nullable(),
    amountMinor: z.number().int().nonnegative(),
    currency: z.literal('RUB'),
    paymentMode: z.literal('simulation'),
    endsAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime(),
});

export const combinationPreviewRequestSchema = versionedCommandSchema
    .extend({ peerUserId: z.uuid(), recipientId: z.uuid() })
    .strict();
export const combinationPreviewSchema = z.strictObject({
    previewId: z.uuid(),
    combinationId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    familyId: z.uuid(),
    firstUserId: z.uuid(),
    secondUserId: z.uuid(),
    recipientId: z.uuid(),
    firstSubscriptionId: z.uuid(),
    secondSubscriptionId: z.uuid(),
    firstEndsAt: z.iso.datetime(),
    secondEndsAt: z.iso.datetime(),
    resultEndsAt: z.iso.datetime(),
    amountMinor: z.literal(0),
    currency: z.literal('RUB'),
    requiredUserIds: z.array(z.uuid()).min(2),
    expiresAt: z.iso.datetime(),
});
export const combinationConsentSchema = previewCommitSchema.extend({ combinationId: z.uuid() }).strict();
export const combinationConsentResultSchema = z.strictObject({
    status: z.enum(['consent_pending', 'applied']),
    combinationId: z.uuid(),
    acceptedUserIds: z.array(z.uuid()),
    requiredUserIds: z.array(z.uuid()),
    resultEndsAt: z.iso.datetime(),
    settings: subscriptionSettingsSchema,
});

export type BillingPeriod = z.infer<typeof billingPeriodSchema>;
export type SubscriptionPreview = z.infer<typeof subscriptionPreviewSchema>;
export type DowngradePreview = z.infer<typeof downgradePreviewSchema>;
export type PlanChangePreview = z.infer<typeof planChangePreviewSchema>;
export type RenewalPreview = z.infer<typeof renewalPreviewSchema>;
