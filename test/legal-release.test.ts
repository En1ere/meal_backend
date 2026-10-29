import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import {
    DisabledLegalEvidenceProvider,
    LEGAL_RELEASE_GATE_VERSION,
    legalReleaseEvidenceSchema,
    legalReleaseReadiness,
    legalRequirementMatrixSchema,
} from '../src/modules/legal-runtime/legal-release.js';

const now = '2026-10-09T12:00:00.000Z';
const release = { root: '0.0.151', back: '0.0.77', front: '0.0.69', admin: '0.0.74', openapi: '0.0.58' };
const binding = {
    requirementKey: 'registration.terms',
    documentId: '00000000-0000-4000-8000-000000000001',
    documentVersion: 1,
    bodyHash: `sha256:${'a'.repeat(64)}`,
    contentReleaseId: '00000000-0000-4000-8000-000000000002',
    publishEventId: '00000000-0000-4000-8000-000000000003',
};
const matrix = {
    contractVersion: LEGAL_RELEASE_GATE_VERSION,
    matrixVersion: 1,
    status: 'approved',
    approvedAt: now,
    approvalReference: 'legal-matrix-1',
    requirements: [
        {
            key: binding.requirementKey,
            documentKind: 'terms_of_use',
            jurisdiction: 'approved-jurisdiction',
            audience: 'registered-users',
            surface: 'registration-terms',
            consent: 'mandatory',
            withdrawalRequired: false,
        },
    ],
} as const;
const document = {
    ...binding,
    kind: 'terms_of_use',
    locale: 'ru-RU',
    jurisdiction: 'approved-jurisdiction',
    audience: 'registered-users',
    effectiveAt: '2026-10-09T11:00:00.000Z',
    publicUrl: 'https://legal.example/terms',
    published: true,
    immutable: true,
    retired: false,
    placeholder: false,
} as const;
const target = {
    contractVersion: LEGAL_RELEASE_GATE_VERSION,
    release,
    targetFingerprint: `sha256:${'b'.repeat(64)}`,
    evaluatedAt: now,
};
const evidence = {
    contractVersion: LEGAL_RELEASE_GATE_VERSION,
    target,
    matrix,
    documents: [document],
    approvals: [
        {
            ...binding,
            decisions: [
                { role: 'product_owner', approvalReference: 'owner-approval-1', approvedAt: now },
                { role: 'legal_reviewer', approvalReference: 'legal-review-1', approvedAt: now },
            ],
        },
    ],
    consents: [
        {
            ...binding,
            flow: 'registration',
            explicitAcceptance: true,
            persistsDocumentId: true,
            persistsDocumentVersion: true,
            persistsBodyHash: true,
            withdrawalSupported: false,
            evidenceSchemaVersion: 1,
        },
    ],
    surfaces: [
        {
            ...binding,
            surface: 'registration-terms',
            publicUrl: document.publicUrl,
            renderedEffectiveAt: document.effectiveAt,
            placeholder: false,
            verifiedAt: now,
        },
    ],
    prerequisites: ['operations', 'recovery', 'production_acceptance'].map((gate, index) => ({
        gate,
        status: 'passed',
        release,
        targetFingerprint: target.targetFingerprint,
        evidenceDigest: `sha256:${String(index + 1).repeat(64)}`,
        verifiedAt: now,
    })),
};

void test('legal requirement matrix must be approved, nonempty and unique', () => {
    assert.equal(legalRequirementMatrixSchema.safeParse(matrix).success, true);
    assert.equal(legalRequirementMatrixSchema.safeParse({ ...matrix, requirements: [] }).success, false);
    assert.equal(
        legalRequirementMatrixSchema.safeParse({
            ...matrix,
            requirements: [...matrix.requirements, ...matrix.requirements],
        }).success,
        false,
    );
});

void test('legal release evidence is strict and excludes document content and approver identity', () => {
    assert.equal(legalReleaseEvidenceSchema.safeParse(evidence).success, true);
    assert.equal(legalReleaseEvidenceSchema.safeParse({ ...evidence, content: 'forbidden' }).success, false);
    assert.equal(
        legalReleaseEvidenceSchema.safeParse({
            ...evidence,
            approvals: [{ ...evidence.approvals[0], approverEmail: 'forbidden@example.test' }],
        }).success,
        false,
    );
    assert.equal(
        legalReleaseEvidenceSchema.safeParse({
            ...evidence,
            approvals: [
                {
                    ...evidence.approvals[0],
                    decisions: evidence.approvals[0]!.decisions.map((decision) => ({
                        ...decision,
                        approvalReference: 'shared-approval',
                    })),
                },
            ],
        }).success,
        false,
    );
    assert.equal(
        legalReleaseEvidenceSchema.safeParse({
            ...evidence,
            approvals: [
                {
                    ...evidence.approvals[0],
                    decisions: [evidence.approvals[0]!.decisions[0], evidence.approvals[0]!.decisions[0]],
                },
            ],
        }).success,
        false,
    );
    assert.equal(
        legalReleaseEvidenceSchema.safeParse({
            ...evidence,
            documents: [{ ...document, requirementKey: 'unapproved.requirement' }],
        }).success,
        false,
    );
});

void test('legal release needs current immutable documents and matching approvals', () => {
    assert.equal(legalReleaseReadiness(evidence, new Date(now)).status, 'technically_ready');
    assert.deepEqual(
        legalReleaseReadiness(
            { ...evidence, approvals: [{ ...evidence.approvals[0], bodyHash: `sha256:${'c'.repeat(64)}` }] },
            new Date(now),
        ),
        { status: 'blocked_external', blockers: ['approval_missing_or_stale'] },
    );
    assert.deepEqual(
        legalReleaseReadiness(
            { ...evidence, documents: [{ ...document, effectiveAt: '2026-10-10T00:00:00.000Z' }] },
            new Date(now),
        ),
        { status: 'blocked_external', blockers: ['document_not_effective', 'projection_unverified'] },
    );
});

void test('legal release requires exact public projection and version-bound consent', () => {
    assert.deepEqual(legalReleaseReadiness({ ...evidence, surfaces: [] }, new Date(now)), {
        status: 'blocked_external',
        blockers: ['projection_unverified'],
    });
    assert.deepEqual(legalReleaseReadiness({ ...evidence, consents: [] }, new Date(now)), {
        status: 'blocked_external',
        blockers: ['consent_unbound'],
    });
});

void test('legal release requires stage 14 evidence for the exact target and release', () => {
    assert.deepEqual(
        legalReleaseReadiness({ ...evidence, prerequisites: evidence.prerequisites.slice(1) }, new Date(now)),
        {
            status: 'blocked_external',
            blockers: ['operational_evidence_missing'],
        },
    );
    assert.deepEqual(
        legalReleaseReadiness(
            {
                ...evidence,
                prerequisites: evidence.prerequisites.map((item, index) =>
                    index === 0 ? { ...item, release: { ...release, back: '0.0.76' } } : item,
                ),
            },
            new Date(now),
        ),
        { status: 'blocked_external', blockers: ['release_mismatch'] },
    );
});

void test('invalid or absent external input fails closed with bounded blockers', async () => {
    assert.deepEqual(legalReleaseReadiness(null), {
        status: 'blocked_external',
        blockers: ['target_unapproved', 'requirements_unapproved'],
    });
    await assert.rejects(
        new DisabledLegalEvidenceProvider().load(target.targetFingerprint),
        ServiceUnavailableException,
    );
});

void test('user-facing legal drafts use only the agreed placeholder and remain publication-blocked', () => {
    const root = path.resolve(process.cwd(), 'docs', 'legal');
    const manifest = JSON.parse(readFileSync(path.join(root, 'package-manifest.json'), 'utf8')) as {
        packageStatus: string;
        publicationEligible: boolean;
        documents: Array<{ file: string; status: string; publicationEligible: boolean }>;
    };
    assert.equal(manifest.documents.length, 11);
    assert.equal(manifest.packageStatus, 'draft_blocked');
    assert.equal(manifest.publicationEligible, false);
    for (const document of manifest.documents) {
        assert.equal(document.status, 'draft_blocked');
        assert.equal(document.publicationEligible, false);
        const source = readFileSync(path.join(root, document.file), 'utf8');
        const markers = source.match(/\[[^\]]+\]/g) ?? [];
        assert.ok(source.includes('[Тут будут данные]'));
        assert.ok(markers.every((marker) => marker === '[Тут будут данные]' || marker === '[ ]'));
    }
});
