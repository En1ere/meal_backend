import fs from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('database/manifest.json', root), 'utf8'));
const args = process.argv.slice(2);
const host = process.env.PGHOST || '127.0.0.1';
const port = Number(process.env.PGPORT || '54329');
const database = process.env.PGDATABASE || 'meal_planner_postgres';
const user = process.env.PGUSER;
const environment = args.find((v) => v.startsWith('--environment='))?.split('=')[1] || 'development';
if (database !== 'meal_planner_postgres' || !['development', 'test', 'production'].includes(environment))
    throw Error('Unexpected target');
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !args.includes('--allow-remote'))
    throw Error('Remote target requires --allow-remote');
if (environment === 'production' && !args.includes('--allow-production'))
    throw Error('Production requires --allow-production');
if (process.env.PGHOSTADDR && process.env.PGHOSTADDR !== host) throw Error('Conflicting PGHOSTADDR');
const migrations = manifest.migrations.map((migration) => {
    const sql = fs.readFileSync(new URL(`database/migrations/${migration.file}`, root), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== migration.sha256)
        throw Error('Migration file checksum mismatch');
    return { ...migration, sql };
});
if (!args.includes('--apply')) {
    console.log(
        JSON.stringify(
            {
                willConnect: false,
                target: { host, port, database, user, environment },
                migrations: manifest.migrations,
            },
            null,
            2,
        ),
    );
} else {
    if (!user) throw Error('Set explicit PGUSER migration role');
    let stage = 'connection';
    const client = new pg.Client({
        host,
        port,
        database,
        user,
        connectionTimeoutMillis: 5000,
        application_name: 'meal-planner-migrator',
    });
    try {
        await client.connect();
        stage = 'preflight';
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await client.query(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'; SET LOCAL TIME ZONE 'UTC'",
        );
        await client.query('SELECT pg_advisory_xact_lock(73821641)');
        const version = await client.query("SELECT current_setting('server_version_num')::int / 10000 AS major");
        if (version.rows[0].major !== 18) throw Error('Expected PostgreSQL 18');
        const exists = await client.query("SELECT to_regclass('meal.schema_migrations') AS name");
        const history = exists.rows[0].name
            ? (await client.query('SELECT version, checksum FROM meal.schema_migrations ORDER BY version')).rows
            : [];
        for (const row of history)
            if (!migrations.some((m) => m.version === Number(row.version) && m.sha256 === row.checksum))
                throw Error('Unknown or modified migration history');
        if (exists.rows[0].name) {
            const marker = await client.query('SELECT name FROM meal.environment');
            if (marker.rows.length !== 1 || marker.rows[0].name !== environment)
                throw Error('Environment marker mismatch');
        }
        for (const migration of migrations) {
            if (history.some((row) => Number(row.version) === migration.version)) continue;
            stage = `migration ${migration.version} (${migration.file})`;
            await client.query(migration.sql);
            if (migration.version === 1)
                await client.query('INSERT INTO meal.environment(name) VALUES($1)', [environment]);
            await client.query('INSERT INTO meal.schema_migrations(version,checksum) VALUES($1,$2)', [
                migration.version,
                migration.sha256,
            ]);
        }
        stage = 'commit';
        await client.query('COMMIT');
        console.log('Migration transaction committed; schema version ' + manifest.migrations.at(-1).version);
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        // No SQL text, secrets or row values in output.
        console.error(
            `Migration failed during ${stage}; transaction rolled back.`,
            error instanceof Error && 'code' in error ? error.code : 'Inspect target/history/permissions',
        );
        process.exitCode = 1;
    } finally {
        await client.end();
    }
}
