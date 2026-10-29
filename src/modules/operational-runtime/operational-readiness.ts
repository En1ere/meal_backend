import { productionAcceptanceManifest } from './production-acceptance.js';
import { workerTopology } from './worker-topology.js';

export interface DatabaseManifestSummary {
    database: string;
    postgresMajor: number;
    schemaVersion: number;
    totalTables: number;
    foreignKeys: number;
}

export const operationalCapabilities = {
    sharedLeaseBackend: { status: 'ready', minimumSchemaVersion: 24 },
    telemetryAndAlertSink: { status: 'ready', sink: 'sanitized_json+admin_postgres' },
} as const;

export const operationalExternalBlockers = [
    'approved_rpo_rto',
    'backup_provider_and_key_custody',
    'isolated_restore_target',
    'production_https_origins',
] as const;

export function operationalReadiness(manifest: DatabaseManifestSummary) {
    if (manifest.schemaVersion < operationalCapabilities.sharedLeaseBackend.minimumSchemaVersion)
        throw new Error('Operational readiness requires the shared worker lease schema');
    return {
        status: 'blocked_external' as const,
        willConnectDatabase: false,
        willRunWorkers: false,
        willRestore: false,
        willStartBrowser: false,
        repository: manifest,
        capabilities: operationalCapabilities,
        workers: workerTopology(),
        productionAcceptance: productionAcceptanceManifest,
        blockers: operationalExternalBlockers,
    };
}
