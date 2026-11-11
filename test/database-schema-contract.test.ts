import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DATABASE_SCHEMA_CONTRACT } from '../src/infrastructure/database/schema-manifest.js';

interface Manifest {
    readonly postgresMajor: number;
    readonly totalTables: number;
    readonly foreignKeys: number;
    readonly migrations: ReadonlyArray<Readonly<{ version: number }>>;
}

const text = (path: string) => readFile(path, 'utf8');

void test('runtime schema contract is derived from the checked migration manifest', async () => {
    const manifest = JSON.parse(await text('database/manifest.json')) as Manifest;
    assert.deepEqual(DATABASE_SCHEMA_CONTRACT, {
        version: manifest.migrations.at(-1)?.version,
        migrationCount: manifest.migrations.length,
        versions: manifest.migrations.map((migration) => migration.version),
        postgresMajor: manifest.postgresMajor,
        totalTables: manifest.totalTables,
        foreignKeys: manifest.foreignKeys,
    });
    assert.deepEqual(DATABASE_SCHEMA_CONTRACT, {
        version: 41,
        migrationCount: 41,
        versions: Array.from({ length: 41 }, (_, index) => index + 1),
        postgresMajor: 18,
        totalTables: 229,
        foreignKeys: 523,
    });
});

void test('readiness and deployment gates use manifest-bound schema facts', async () => {
    const [database, bootstrap, restoreDrill, deploy, grants] = await Promise.all([
        text('src/infrastructure/database/database.service.ts'),
        text('deploy/bootstrap-restore.sh'),
        text('deploy/local-backup-restore-drill.sh'),
        text('deploy/deploy.sh'),
        text('database/application-grants.sql'),
    ]);
    assert.match(database, /array_agg\(version order by version\)/);
    assert.match(database, /DATABASE_SCHEMA_CONTRACT\.versions/);
    assert.doesNotMatch(database, /version\s*=\s*3[234]/);
    assert.match(bootstrap, /database\/manifest\.json/);
    assert.match(bootstrap, /generate_series\(1,\$expected_migration_count\)/);
    assert.match(bootstrap, /\[ "\$facts" = "\$expected_facts\/t" \]/);
    assert.match(restoreDrill, /migration-manifest\.json/);
    assert.match(restoreDrill, /generate_series\(1,\$expected_migration_count\)/);
    assert.match(restoreDrill, /\[ "\$facts" = "\$expected_facts\/t" \]/);
    assert.match(deploy, /schema_version=\$candidate_schema_version/);
    assert.doesNotMatch(deploy, /schema_version=3[234]/);
    assert.match(grants, /every migration listed in database\/manifest\.json/);
});

void test('operator documentation identifies the current v41 recovery contract', async () => {
    const [recovery, databaseTesting, deployment] = await Promise.all([
        text('docs/backup-recovery.md'),
        text('docs/DATABASE_TESTING.md'),
        text('docs/DEPLOYMENT.md'),
    ]);
    assert.match(recovery, /Recovery set v16 для schema v41/);
    assert.match(recovery, /41 migration rows/);
    assert.match(recovery, /229 таблиц, 523 FK/);
    assert.match(databaseTesting, /schema v41, 41 миграция, 229 таблиц/);
    assert.match(deployment, /gate читает значения из candidate manifest/);
});
