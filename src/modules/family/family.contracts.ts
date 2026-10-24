import { z } from 'zod';
import { entitlementSchema } from '../entitlements/entitlements.contracts.js';

export const familyCreateSchema = z.strictObject({
    name: z.string().trim().min(1).max(80),
    idempotencyKey: z.uuid(),
});

export const familyMemberSchema = z.strictObject({
    id: z.uuid(),
    userId: z.uuid(),
    displayName: z.string().min(1),
    role: z.enum(['owner', 'member']),
    joinedAt: z.iso.datetime(),
});

export const familyContextSchema = z.strictObject({
    state: z.enum(['none', 'active', 'blocked']),
    entitlement: entitlementSchema,
    family: z
        .strictObject({
            id: z.uuid(),
            name: z.string(),
            version: z.number().int().positive(),
            role: z.enum(['owner', 'member']),
            memberCount: z.number().int().positive(),
            seatLimit: z.number().int().min(4).max(12),
            members: z.array(familyMemberSchema).max(12),
        })
        .nullable(),
    blockedReason: z.enum(['coverage_required']).nullable(),
});

export type FamilyContext = z.infer<typeof familyContextSchema>;

const familyCommandSchema = z.strictObject({
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});

export const familyAiQuotaRedistributionSchema = z.strictObject({
    applies: z.boolean(),
    periodEndsAt: z.iso.datetime().nullable(),
    unspentActions: z.number().int().nonnegative(),
    memberCountBefore: z.number().int().nonnegative(),
    memberCountAfter: z.number().int().nonnegative(),
    shareAfter: z.number().int().nonnegative(),
    familyReserveAfter: z.number().int().nonnegative(),
    currentUserBefore: z.number().int().nonnegative(),
    currentUserAfter: z.number().int().nonnegative(),
});

export const familyLeavePreviewSchema = z.strictObject({
    familyId: z.uuid(),
    familyVersion: z.number().int().positive(),
    role: z.enum(['owner', 'member']),
    willArchive: z.boolean(),
    recommendedMembershipId: z.uuid().nullable(),
    candidates: z.array(familyMemberSchema),
    aiQuotaRedistribution: familyAiQuotaRedistributionSchema,
});

export const familyLeaveSchema = familyCommandSchema
    .extend({
        selection: z.enum(['automatic', 'manual']),
        successorMembershipId: z.uuid().nullable(),
    })
    .strict()
    .superRefine((value, context) => {
        if (value.selection === 'manual' && !value.successorMembershipId)
            context.addIssue({ code: 'custom', path: ['successorMembershipId'], message: 'Выберите преемника' });
        if (value.selection === 'automatic' && value.successorMembershipId)
            context.addIssue({ code: 'custom', path: ['successorMembershipId'], message: 'Автовыбор не принимает ID' });
    });

export const familyMemberRemoveSchema = familyCommandSchema;

export const familyLifecycleResultSchema = z.strictObject({
    familyId: z.uuid(),
    archived: z.boolean(),
    leftMembershipId: z.uuid(),
    successorMembershipId: z.uuid().nullable(),
});

export const ownershipNoticeSchema = z.strictObject({
    notice: z
        .strictObject({
            notificationId: z.uuid(),
            transferId: z.uuid(),
            title: z.string(),
            body: z.string(),
            version: z.number().int().positive(),
        })
        .nullable(),
});

export const ownershipNoticeDismissSchema = familyCommandSchema.extend({ notificationId: z.uuid() }).strict();

export const ownershipNoticeDismissResultSchema = z.strictObject({ dismissed: z.boolean() });

export const ownershipTransferRequestSchema = z.strictObject({
    id: z.uuid(),
    status: z.enum(['pending', 'accepted', 'declined', 'cancelled']),
    version: z.number().int().positive(),
    familyId: z.uuid(),
    familyVersion: z.number().int().positive(),
    from: familyMemberSchema,
    to: familyMemberSchema,
    createdAt: z.iso.datetime(),
    review: z.strictObject({
        seatLimit: z.number().int().min(4).max(12),
        paidSeats: z.number().int().min(0).max(8),
        memberCount: z.number().int().positive(),
        coverage: z.strictObject({
            before: z.enum(['active', 'blocked']),
            after: z.enum(['active', 'blocked']),
            willChange: z.boolean(),
            blockedReason: z.literal('coverage_recalculation_unavailable').nullable(),
        }),
    }),
});
export const ownershipCoveragePreviewSchema = z.strictObject({
    before: z.enum(['active', 'blocked']),
    after: z.enum(['active', 'blocked']),
    willChange: z.boolean(),
    blockedReason: z.literal('coverage_recalculation_unavailable').nullable(),
});
export const ownershipTransferPreviewSchema = z.strictObject({
    familyId: z.uuid(),
    familyVersion: z.number().int().positive(),
    from: familyMemberSchema,
    to: familyMemberSchema,
    seatLimit: z.number().int().min(4).max(12),
    paidSeats: z.number().int().min(0).max(8),
    memberCount: z.number().int().positive(),
    coverage: ownershipCoveragePreviewSchema,
    effects: z.strictObject({
        formerOwnerRemains: z.literal(true),
        paidSeatsMoveWithFamily: z.literal(true),
        personalSubscriptionsChange: z.literal(false),
    }),
    previewKey: z.string().length(64),
    canSubmit: z.boolean(),
    blockers: z.array(z.string().min(1).max(100)),
});
export const ownershipWorkspaceSchema = z.strictObject({
    familyId: z.uuid(),
    familyVersion: z.number().int().positive(),
    owner: familyMemberSchema,
    candidates: z.array(familyMemberSchema).max(11),
    seatLimit: z.number().int().min(4).max(12),
    paidSeats: z.number().int().min(0).max(8),
    pendingRequest: ownershipTransferRequestSchema.nullable(),
});
export const ownershipPreviewInputSchema = z.strictObject({
    targetMembershipId: z.uuid(),
    expectedFamilyVersion: z.number().int().positive(),
});
export const ownershipRequestCreateSchema = ownershipPreviewInputSchema.extend({
    previewKey: z.string().length(64),
    idempotencyKey: z.uuid(),
});
export const ownershipRequestDecisionSchema = z.strictObject({
    expectedVersion: z.number().int().positive(),
    expectedFamilyVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const ownershipRequestDetailSchema = z.strictObject({
    request: ownershipTransferRequestSchema,
    token: z.uuid(),
    preview: ownershipTransferPreviewSchema,
});
export const ownershipRequestResultSchema = z.strictObject({
    request: ownershipTransferRequestSchema,
    token: z.uuid(),
    family: familyContextSchema,
});

export const familyInvitationSchema = z.strictObject({
    id: z.uuid(),
    recipientLogin: z.string(),
    recipientDisplayName: z.string(),
    status: z.enum(['proposed', 'pending', 'accepted', 'cancelled', 'expired']),
    proposedByMe: z.boolean(),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    version: z.number().int().positive(),
});
export const familyInvitationListSchema = z.strictObject({ items: z.array(familyInvitationSchema).max(100) });
export const familyInvitationCreateSchema = familyCommandSchema.extend({
    login: z
        .string()
        .trim()
        .min(3)
        .max(30)
        .regex(/^[A-Za-z0-9_]+$/),
});
export const familyInvitationDecisionSchema = z.strictObject({
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const familyInvitationResultSchema = z.strictObject({
    invitation: familyInvitationSchema,
    token: z.string().min(32).max(128).nullable(),
});
export const familyInvitationPreviewSchema = z.strictObject({
    familyName: z.string(),
    familyVersion: z.number().int().positive(),
    inviterName: z.string(),
    recipientLogin: z.string(),
    status: z.enum(['pending', 'accepted', 'cancelled', 'expired']),
    expiresAt: z.iso.datetime(),
    aiQuotaRedistribution: familyAiQuotaRedistributionSchema,
});
export const familyInvitationAcceptSchema = z.strictObject({
    token: z.string().min(32).max(128),
    expectedFamilyVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});

export type FamilyMember = z.infer<typeof familyMemberSchema>;
