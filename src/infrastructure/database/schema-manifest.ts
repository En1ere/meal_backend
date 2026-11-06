import { readFileSync } from 'node:fs';

interface DatabaseManifest {
    readonly postgresMajor: number;
    readonly totalTables: number;
    readonly foreignKeys: number;
    readonly migrations: ReadonlyArray<Readonly<{ version: number }>>;
}

function isMigrationSequence(value: unknown): value is DatabaseManifest['migrations'] {
    return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(
            (migration: unknown, index) =>
                !!migration &&
                typeof migration === 'object' &&
                'version' in migration &&
                migration.version === index + 1,
        )
    );
}

function loadDatabaseManifest(): DatabaseManifest {
    const path = new URL('../../../../database/manifest.json', import.meta.url);
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') throw new Error('Database manifest must be an object');
    const manifest = value as Partial<DatabaseManifest>;
    if (
        !Number.isSafeInteger(manifest.postgresMajor) ||
        !Number.isSafeInteger(manifest.totalTables) ||
        !Number.isSafeInteger(manifest.foreignKeys) ||
        !isMigrationSequence(manifest.migrations)
    )
        throw new Error('Database manifest invariants are invalid');
    return manifest as DatabaseManifest;
}

const manifest = loadDatabaseManifest();

export const DATABASE_SCHEMA_CONTRACT = Object.freeze({
    version: manifest.migrations.at(-1)!.version,
    migrationCount: manifest.migrations.length,
    versions: Object.freeze(manifest.migrations.map((migration) => migration.version)),
    postgresMajor: manifest.postgresMajor,
    totalTables: manifest.totalTables,
    foreignKeys: manifest.foreignKeys,
});
