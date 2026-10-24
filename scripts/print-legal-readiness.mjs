// Offline release planning command: no application context, database, network, provider or browser.
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { legalReleaseReadiness } from '../dist/src/modules/legal-runtime/legal-release.js';

const requiredEvidence = [
    'approved_requirement_matrix',
    'immutable_versioned_documents',
    'product_owner_and_legal_approvals',
    'public_non_placeholder_projections',
    'version_bound_consent_receipts',
    'operations_recovery_and_production_acceptance',
];
const externalBlockers = [
    'approved_legal_texts_and_effective_dates',
    'jurisdictions_audiences_and_consent_rules',
    'operator_merchant_and_public_requisites',
    'retention_refund_and_deletion_policies',
    'provider_region_and_transfer_disclosures',
    'legal_approval_evidence',
    'public_projection_and_live_consent_binding',
];
const offlineBoundary = {
    willConnectDatabase: false,
    willPublishDocuments: false,
    willCollectConsent: false,
    willStartBrowser: false,
};

async function json(url) {
    return JSON.parse(await readFile(url, 'utf8'));
}

async function currentRelease() {
    // Cross-repository release coordinates must be supplied explicitly by the operator.
    const releasePath = args[3];
    const release = JSON.parse(await readFile(resolve(process.cwd(), releasePath), 'utf8'));
    const [back, openapi] = await Promise.all([
        json(new URL('../package.json', import.meta.url)),
        json(new URL('../contracts/openapi.json', import.meta.url)),
    ]);
    if (!['root', 'front', 'admin'].every((key) => /^\d+\.\d+\.\d+$/.test(release[key] ?? '')))
        throw new Error('invalid_release_coordinates');
    return {
        root: release.root,
        back: back.version,
        front: release.front,
        admin: release.admin,
        openapi: openapi.info.version,
    };
}

function sameRelease(left, right) {
    return Object.keys(right).every((key) => left?.[key] === right[key]);
}

const args = process.argv.slice(2);
const evidenceIndex = args.indexOf('--evidence');
if (args.length === 0) {
    console.log(
        JSON.stringify(
            {
                status: 'blocked_external',
                contractVersion: 1,
                ...offlineBoundary,
                requiredEvidence,
                blockers: externalBlockers,
            },
            null,
            2,
        ),
    );
} else if (
    evidenceIndex === -1 ||
    evidenceIndex !== 0 ||
    args.length !== 4 ||
    !args[1] ||
    args[2] !== '--release' ||
    !args[3]
) {
    console.error(
        JSON.stringify({
            status: 'invalid_command',
            usage: 'npm run legal:readiness -- --evidence <json-file> --release <release-json-file>',
        }),
    );
    process.exitCode = 2;
} else {
    try {
        const path = resolve(process.cwd(), args[1]);
        const metadata = await stat(path);
        if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error('invalid_evidence_file');
        const raw = JSON.parse(await readFile(path, 'utf8'));
        const expectedRelease = await currentRelease();
        const result = legalReleaseReadiness(raw);
        const blockers = new Set(result.blockers);
        if (!sameRelease(raw?.target?.release, expectedRelease)) blockers.add('release_mismatch');
        console.log(
            JSON.stringify(
                {
                    status: blockers.size ? 'blocked_external' : 'technically_ready',
                    contractVersion: 1,
                    ...offlineBoundary,
                    release: expectedRelease,
                    blockers: [...blockers].sort(),
                },
                null,
                2,
            ),
        );
        if (blockers.size) process.exitCode = 1;
    } catch {
        console.error(
            JSON.stringify({
                status: 'blocked_external',
                contractVersion: 1,
                ...offlineBoundary,
                blockers: ['evidence_file_invalid'],
            }),
        );
        process.exitCode = 1;
    }
}
