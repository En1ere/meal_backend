// Read-only release planning command. It never creates an application context, opens a database or starts a browser.
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(new URL('../database/manifest.json', import.meta.url), 'utf8'));
const { workerTopology } = await import('../dist/src/modules/operational-runtime/worker-topology.js');
const { productionAcceptanceManifest } =
    await import('../dist/src/modules/operational-runtime/production-acceptance.js');
console.log(
    JSON.stringify(
        {
            status: 'blocked_external',
            willConnectDatabase: false,
            willRunWorkers: false,
            willRestore: false,
            willStartBrowser: false,
            repository: {
                database: manifest.database,
                postgresMajor: manifest.postgresMajor,
                schemaVersion: manifest.migrations.at(-1)?.version,
                totalTables: manifest.totalTables,
                foreignKeys: manifest.foreignKeys,
            },
            workers: workerTopology(),
            productionAcceptance: productionAcceptanceManifest,
            blockers: [
                'shared_lease_backend',
                'telemetry_and_alert_sink',
                'approved_rpo_rto',
                'backup_provider_and_key_custody',
                'isolated_restore_target',
                'production_https_origins',
            ],
        },
        null,
        2,
    ),
);
