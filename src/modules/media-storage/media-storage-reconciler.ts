export type MediaObjectPresentProbe = Readonly<{
    outcome: 'present';
    contentLength: number;
    metadata: Readonly<{
        assetId: string;
        purpose: string;
        keyVersion: string;
    }>;
}>;

export type MediaObjectProbe = Readonly<{ outcome: 'missing' | 'unknown' }> | MediaObjectPresentProbe;

export type MediaReservationEvidence = Readonly<{
    assetId: string;
    purpose: string;
    expectedEncryptedBytes: number;
    state: 'uploading';
    failureCode: 'reconciliation_required';
}>;

export type MediaDatabaseEvidence = Readonly<{
    asset: null | Readonly<{
        status: 'quarantined';
        sizeBytes: number;
        checksum: string;
    }>;
    binding: null | Readonly<{
        purpose: string;
        keyVersion: number;
        nonce: string;
        authenticationTag: string;
    }>;
}>;

export type MediaReconciliationDecision = Readonly<{
    action: 'confirm_quarantined' | 'confirm_failed' | 'defer' | 'manual_review';
    reason:
        | 'durable_match'
        | 'confirmed_absent'
        | 'provider_unknown'
        | 'orphan_object'
        | 'database_partial'
        | 'evidence_mismatch';
}>;

function isPositiveSafeInteger(value: number) {
    return Number.isSafeInteger(value) && value > 0;
}

function isPresentProbe(probe: MediaObjectProbe): probe is MediaObjectPresentProbe {
    return probe.outcome === 'present';
}

export function reconcileMediaUpload(
    reservation: MediaReservationEvidence,
    database: MediaDatabaseEvidence,
    probe: MediaObjectProbe,
): MediaReconciliationDecision {
    if (!isPositiveSafeInteger(reservation.expectedEncryptedBytes))
        return { action: 'manual_review', reason: 'evidence_mismatch' };
    if (probe.outcome === 'unknown') return { action: 'defer', reason: 'provider_unknown' };

    const hasAsset = database.asset !== null;
    const hasBinding = database.binding !== null;
    if (hasAsset !== hasBinding) return { action: 'manual_review', reason: 'database_partial' };

    if (probe.outcome === 'missing') {
        if (!hasAsset) return { action: 'confirm_failed', reason: 'confirmed_absent' };
        return { action: 'manual_review', reason: 'evidence_mismatch' };
    }

    if (!hasAsset || !hasBinding) return { action: 'manual_review', reason: 'orphan_object' };
    if (!isPresentProbe(probe)) return { action: 'defer', reason: 'provider_unknown' };
    const metadata = probe.metadata;
    if (
        probe.contentLength !== reservation.expectedEncryptedBytes ||
        metadata.assetId !== reservation.assetId ||
        metadata.purpose !== reservation.purpose ||
        metadata.keyVersion !== String(database.binding.keyVersion) ||
        database.binding.purpose !== reservation.purpose ||
        database.asset.sizeBytes <= 0 ||
        !database.asset.checksum.startsWith('sha256:') ||
        !database.binding.nonce ||
        !database.binding.authenticationTag
    )
        return { action: 'manual_review', reason: 'evidence_mismatch' };

    return { action: 'confirm_quarantined', reason: 'durable_match' };
}
