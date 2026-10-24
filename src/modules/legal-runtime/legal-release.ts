import { ServiceUnavailableException } from '@nestjs/common';
import { isIP } from 'node:net';
import { z } from 'zod';

export const LEGAL_RELEASE_GATE_VERSION = 1 as const;
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const keySchema = z.string().regex(/^[a-z][a-z0-9._-]{2,79}$/);
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const releaseSchema = z.strictObject({
    root: semverSchema,
    back: semverSchema,
    front: semverSchema,
    admin: semverSchema,
    openapi: semverSchema,
});
const publicDocumentUrlSchema = z.url().superRefine((value, context) => {
    const url = new URL(value);
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        isIP(url.hostname) !== 0 ||
        url.hostname === 'localhost'
    )
        context.addIssue({ code: 'custom', message: 'Expected a public HTTPS document URL' });
});

export const legalReleaseTargetSchema = z.strictObject({
    contractVersion: z.literal(LEGAL_RELEASE_GATE_VERSION),
    release: releaseSchema,
    targetFingerprint: sha256Schema,
    evaluatedAt: z.iso.datetime(),
});

export const legalRequirementMatrixSchema = z
    .strictObject({
        contractVersion: z.literal(LEGAL_RELEASE_GATE_VERSION),
        matrixVersion: z.number().int().positive(),
        status: z.literal('approved'),
        approvedAt: z.iso.datetime(),
        approvalReference: keySchema,
        requirements: z
            .array(
                z.strictObject({
                    key: keySchema,
                    documentKind: keySchema,
                    jurisdiction: keySchema,
                    audience: keySchema,
                    surface: keySchema,
                    consent: z.enum(['none', 'mandatory', 'optional']),
                    withdrawalRequired: z.boolean(),
                }),
            )
            .min(1)
            .max(50),
    })
    .superRefine((value, context) => {
        const keys = value.requirements.map((item) => item.key);
        if (new Set(keys).size !== keys.length)
            context.addIssue({ code: 'custom', path: ['requirements'], message: 'Requirement keys must be unique' });
    });

const documentBinding = {
    requirementKey: keySchema,
    documentId: z.uuid(),
    documentVersion: z.number().int().positive(),
    bodyHash: sha256Schema,
    contentReleaseId: z.uuid(),
    publishEventId: z.uuid(),
};
export const legalDocumentEvidenceSchema = z.strictObject({
    ...documentBinding,
    kind: keySchema,
    locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
    jurisdiction: keySchema,
    audience: keySchema,
    effectiveAt: z.iso.datetime(),
    publicUrl: publicDocumentUrlSchema,
    published: z.literal(true),
    immutable: z.literal(true),
    retired: z.literal(false),
    placeholder: z.literal(false),
});
export const legalApprovalEvidenceSchema = z.strictObject({
    ...documentBinding,
    decisions: z
        .array(
            z.strictObject({
                role: z.enum(['product_owner', 'legal_reviewer']),
                approvalReference: keySchema,
                approvedAt: z.iso.datetime(),
            }),
        )
        .length(2)
        .refine(
            (decisions) => new Set(decisions.map((item) => item.role)).size === 2,
            'Both approval roles are required',
        )
        .refine(
            (decisions) => new Set(decisions.map((item) => item.approvalReference)).size === 2,
            'Approval references must be independent',
        ),
});
export const legalConsentBindingSchema = z.strictObject({
    ...documentBinding,
    flow: keySchema,
    explicitAcceptance: z.literal(true),
    persistsDocumentId: z.literal(true),
    persistsDocumentVersion: z.literal(true),
    persistsBodyHash: z.literal(true),
    withdrawalSupported: z.boolean(),
    evidenceSchemaVersion: z.number().int().positive(),
});
export const legalSurfaceEvidenceSchema = z.strictObject({
    ...documentBinding,
    surface: keySchema,
    publicUrl: publicDocumentUrlSchema,
    renderedEffectiveAt: z.iso.datetime(),
    placeholder: z.literal(false),
    verifiedAt: z.iso.datetime(),
});
export const legalPrerequisiteEvidenceSchema = z.strictObject({
    gate: z.enum(['operations', 'recovery', 'production_acceptance']),
    status: z.literal('passed'),
    release: releaseSchema,
    targetFingerprint: sha256Schema,
    evidenceDigest: sha256Schema,
    verifiedAt: z.iso.datetime(),
});

export const legalReleaseEvidenceSchema = z
    .strictObject({
        contractVersion: z.literal(LEGAL_RELEASE_GATE_VERSION),
        target: legalReleaseTargetSchema,
        matrix: legalRequirementMatrixSchema,
        documents: z.array(legalDocumentEvidenceSchema).max(50),
        approvals: z.array(legalApprovalEvidenceSchema).max(50),
        consents: z.array(legalConsentBindingSchema).max(50),
        surfaces: z.array(legalSurfaceEvidenceSchema).max(50),
        prerequisites: z.array(legalPrerequisiteEvidenceSchema).max(3),
    })
    .superRefine((value, context) => {
        const approvedKeys = new Set(value.matrix.requirements.map((item) => item.key));
        const documentIds = value.documents.map((item) => item.documentId);
        if (new Set(documentIds).size !== documentIds.length)
            context.addIssue({ code: 'custom', path: ['documents'], message: 'Document IDs must be unique' });
        for (const collection of ['documents', 'approvals', 'consents', 'surfaces'] as const)
            for (const [index, item] of value[collection].entries())
                if (!approvedKeys.has(item.requirementKey))
                    context.addIssue({
                        code: 'custom',
                        path: [collection, index, 'requirementKey'],
                        message: 'Evidence is not present in the approved matrix',
                    });
    });
export type LegalReleaseEvidence = z.infer<typeof legalReleaseEvidenceSchema>;

type LegalBlocker =
    | 'target_unapproved'
    | 'requirements_unapproved'
    | 'documents_missing_or_invalid'
    | 'approval_missing_or_stale'
    | 'document_not_effective'
    | 'projection_unverified'
    | 'consent_unbound'
    | 'release_mismatch'
    | 'operational_evidence_missing';

function sameRelease(left: z.infer<typeof releaseSchema>, right: z.infer<typeof releaseSchema>) {
    return Object.keys(left).every((key) => left[key as keyof typeof left] === right[key as keyof typeof right]);
}

function sameDocument(
    left: Pick<z.infer<typeof legalDocumentEvidenceSchema>, keyof typeof documentBinding>,
    right: Pick<z.infer<typeof legalDocumentEvidenceSchema>, keyof typeof documentBinding>,
) {
    return Object.keys(documentBinding).every(
        (key) => left[key as keyof typeof documentBinding] === right[key as keyof typeof documentBinding],
    );
}

export function legalReleaseReadiness(raw: unknown, clock = new Date()) {
    const parsed = legalReleaseEvidenceSchema.safeParse(raw);
    if (!parsed.success) {
        const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
        const blockers: LegalBlocker[] = [];
        if (!legalReleaseTargetSchema.safeParse(value.target).success) blockers.push('target_unapproved');
        if (!legalRequirementMatrixSchema.safeParse(value.matrix).success) blockers.push('requirements_unapproved');
        if (blockers.length === 0) blockers.push('documents_missing_or_invalid');
        return { status: 'blocked_external', blockers } as const;
    }
    const evidence = parsed.data;
    const blockers = new Set<LegalBlocker>();
    if (Date.parse(evidence.target.evaluatedAt) > clock.getTime()) blockers.add('target_unapproved');
    if (Date.parse(evidence.matrix.approvedAt) > clock.getTime()) blockers.add('requirements_unapproved');
    const countByRequirement = (items: ReadonlyArray<{ requirementKey: string }>, key: string) =>
        items.filter((item) => item.requirementKey === key).length;

    for (const requirement of evidence.matrix.requirements) {
        const document = evidence.documents.find((item) => item.requirementKey === requirement.key);
        if (
            countByRequirement(evidence.documents, requirement.key) !== 1 ||
            !document ||
            document.kind !== requirement.documentKind ||
            document.jurisdiction !== requirement.jurisdiction ||
            document.audience !== requirement.audience
        ) {
            blockers.add('documents_missing_or_invalid');
            continue;
        }
        if (Date.parse(document.effectiveAt) > clock.getTime()) blockers.add('document_not_effective');
        const approval = evidence.approvals.find((item) => item.requirementKey === requirement.key);
        if (
            countByRequirement(evidence.approvals, requirement.key) !== 1 ||
            !approval ||
            !sameDocument(document, approval) ||
            approval.decisions.some((decision) => Date.parse(decision.approvedAt) > clock.getTime())
        )
            blockers.add('approval_missing_or_stale');
        const surface = evidence.surfaces.find((item) => item.requirementKey === requirement.key);
        if (
            countByRequirement(evidence.surfaces, requirement.key) !== 1 ||
            !surface ||
            !sameDocument(document, surface) ||
            surface.surface !== requirement.surface ||
            surface.publicUrl !== document.publicUrl ||
            surface.renderedEffectiveAt !== document.effectiveAt ||
            Date.parse(surface.verifiedAt) > clock.getTime()
        )
            blockers.add('projection_unverified');
        const consent = evidence.consents.find((item) => item.requirementKey === requirement.key);
        if (
            requirement.consent !== 'none' &&
            (countByRequirement(evidence.consents, requirement.key) !== 1 ||
                !consent ||
                !sameDocument(document, consent) ||
                (requirement.withdrawalRequired && !consent.withdrawalSupported))
        )
            blockers.add('consent_unbound');
        if (requirement.consent === 'none' && countByRequirement(evidence.consents, requirement.key) !== 0)
            blockers.add('consent_unbound');
    }
    const gates = ['operations', 'recovery', 'production_acceptance'] as const;
    for (const gate of gates) {
        const matches = evidence.prerequisites.filter((item) => item.gate === gate);
        if (matches.length !== 1 || Date.parse(matches[0]!.verifiedAt) > clock.getTime())
            blockers.add('operational_evidence_missing');
        else if (
            !sameRelease(matches[0]!.release, evidence.target.release) ||
            matches[0]!.targetFingerprint !== evidence.target.targetFingerprint
        )
            blockers.add('release_mismatch');
    }
    return blockers.size
        ? ({ status: 'blocked_external', blockers: [...blockers].sort() } as const)
        : ({ status: 'technically_ready', blockers: [] } as const);
}

export interface LegalEvidenceProvider {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    load(targetFingerprint: string): Promise<LegalReleaseEvidence>;
}
export class DisabledLegalEvidenceProvider implements LegalEvidenceProvider {
    status() {
        return { configured: false, provider: null } as const;
    }
    load(targetFingerprint: string): Promise<LegalReleaseEvidence> {
        void targetFingerprint;
        return Promise.reject(new ServiceUnavailableException('Legal evidence provider is not configured'));
    }
}
