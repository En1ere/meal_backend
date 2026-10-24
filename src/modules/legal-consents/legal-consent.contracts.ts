import { z } from 'zod';

export const LEGAL_CONSENT_CONTRACT_VERSION = 1 as const;
export const legalDocumentKindSchema = z.enum([
    'offer',
    'privacy_notice',
    'ai_data_access',
    'special_category',
    'dissemination',
    'marketing',
]);
export const optionalConsentKindSchema = z.enum(['ai_data_access', 'special_category', 'dissemination', 'marketing']);
export type OptionalConsentKind = z.infer<typeof optionalConsentKindSchema>;

export const immutableLegalDocumentRefSchema = z.strictObject({
    documentId: z.uuid(),
    documentVersion: z.number().int().positive(),
    bodyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    contentReleaseId: z.uuid(),
    publishEventId: z.uuid(),
});
export type ImmutableLegalDocumentRef = z.infer<typeof immutableLegalDocumentRefSchema>;

export const registrationLegalEvidenceSchema = z.strictObject({
    offerAcceptance: z.strictObject({
        accepted: z.literal(true),
        document: immutableLegalDocumentRefSchema,
    }),
    privacyAcknowledgement: z.strictObject({
        acknowledged: z.literal(true),
        document: immutableLegalDocumentRefSchema,
    }),
});

const publicDocumentSchema = z.strictObject({
    kind: legalDocumentKindSchema,
    required: z.boolean(),
    withdrawalSupported: z.boolean(),
    document: immutableLegalDocumentRefSchema,
    effectiveAt: z.iso.datetime(),
    publicUrl: z.url().nullable(),
    locale: z.string(),
    jurisdiction: z.string(),
    status: z.enum(['approved', 'demonstration']),
});
export const publicLegalManifestSchema = z.strictObject({
    contractVersion: z.literal(LEGAL_CONSENT_CONTRACT_VERSION),
    status: z.enum(['approved', 'demonstration', 'unavailable']),
    documents: z.array(publicDocumentSchema).max(6),
});
export type PublicLegalDocument = z.infer<typeof publicDocumentSchema>;

export const consentAcceptSchema = z.strictObject({
    accepted: z.literal(true),
    document: immutableLegalDocumentRefSchema,
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.uuid(),
});
export const consentRevokeSchema = z.strictObject({
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.uuid(),
});

const consentItemSchema = z.strictObject({
    kind: optionalConsentKindSchema,
    enabled: z.boolean(),
    revision: z.number().int().nonnegative(),
    changedAt: z.iso.datetime().nullable(),
    document: immutableLegalDocumentRefSchema.nullable(),
    blockedFeatures: z.array(z.string()),
    action: z.strictObject({ href: z.string(), label: z.string() }).nullable(),
});
export const consentStateSchema = z.strictObject({
    contractVersion: z.literal(LEGAL_CONSENT_CONTRACT_VERSION),
    manifestStatus: z.enum(['approved', 'demonstration', 'unavailable']),
    consents: z.array(consentItemSchema).length(4),
});
export const consentHistorySchema = z.strictObject({
    events: z
        .array(
            z.strictObject({
                id: z.uuid(),
                kind: optionalConsentKindSchema,
                action: z.enum(['accepted', 'revoked']),
                occurredAt: z.iso.datetime(),
                document: immutableLegalDocumentRefSchema.nullable(),
                evidenceMode: z.enum(['approved', 'demonstration']),
            }),
        )
        .max(100),
});

export const blockedFeatures: Readonly<Record<OptionalConsentKind, readonly string[]>> = {
    ai_data_access: ['ai.personal_data'],
    special_category: ['health.personalization'],
    dissemination: ['profile.publication'],
    marketing: ['marketing.delivery'],
};
