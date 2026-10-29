// Read-only release planning command. It never creates an application context, opens a database or starts a browser.
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(new URL('../database/manifest.json', import.meta.url), 'utf8'));
const { operationalReadiness } = await import('../dist/src/modules/operational-runtime/operational-readiness.js');
console.log(
    JSON.stringify(
        operationalReadiness({
            database: manifest.database,
            postgresMajor: manifest.postgresMajor,
            schemaVersion: manifest.migrations.at(-1)?.version,
            totalTables: manifest.totalTables,
            foreignKeys: manifest.foreignKeys,
        }),
        null,
        2,
    ),
);
