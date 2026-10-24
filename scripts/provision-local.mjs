// Explicit local development provisioning. Default is a plan, never a connection.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = path.join(root, '.local');
const envFile = path.join(local, 'backend.env');
const role = 'meal_app';
const target = { host: '127.0.0.1', port: 54329, database: 'meal_planner_postgres' };
function protectDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
        const acl = spawnSync(
            'icacls.exe',
            [directory, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(OI)(CI)F`],
            { encoding: 'utf8', shell: false },
        );
        if (acl.status !== 0 || acl.error) throw Error('Cannot protect private directory');
    } else {
        fs.chmodSync(directory, 0o700);
    }
}
if (!process.argv.includes('--apply')) {
    console.log(
        JSON.stringify(
            {
                willConnect: false,
                target,
                role,
                steps: [
                    'Verify development marker, PostgreSQL 18, migration history, absent meal_app and absent backend.env',
                    'Create a new custom-format backup, never overwrite',
                    'Apply reviewed migration 002 in transaction',
                    'Create meal_app LOGIN NOSUPERUSER NOBYPASSRLS and limited auth table grants',
                    'Save random database password and independent authentication keys in protected .local/backend.env',
                ],
            },
            null,
            2,
        ),
    );
    process.exit(0);
}
if (
    process.env.PGHOST !== target.host ||
    process.env.PGPORT !== String(target.port) ||
    process.env.PGDATABASE !== target.database ||
    !process.env.PGUSER ||
    !process.env.MEAL_PG_DUMP
)
    throw Error('Dot-source approved local environment first');
if (process.env.PGHOSTADDR && process.env.PGHOSTADDR !== target.host) throw Error('Unexpected address');
if (fs.existsSync(envFile)) throw Error('backend.env exists; never overwrite credentials');
const client = new pg.Client({ ...target, user: process.env.PGUSER, connectionTimeoutMillis: 5000 });
await client.connect();
try {
    const check = await client.query('SELECT name FROM meal.environment');
    if (check.rows.length !== 1 || check.rows[0].name !== 'development') throw Error('Expected development database');
    const roles = await client.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [role]);
    if (roles.rowCount) throw Error('meal_app already exists; no automatic role change');
    const version = await client.query("SELECT current_setting('server_version_num')::int AS version");
    if (Math.floor(version.rows[0].version / 10000) !== 18) throw Error('Expected PostgreSQL 18');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'database/manifest.json'), 'utf8'));
    const history = await client.query('SELECT version,checksum FROM meal.schema_migrations ORDER BY version');
    if (
        history.rows.length !== 1 ||
        Number(history.rows[0].version) !== 1 ||
        history.rows[0].checksum !== manifest.migrations[0].sha256
    )
        throw Error('Expected reviewed v1 baseline; inspect state before retry');
    const activity = await client.query(`SELECT
        (SELECT count(*) FROM meal.sessions) AS sessions,
        (SELECT count(*) FROM meal.auth_challenges) AS challenges,
        (SELECT count(*) FROM meal.mfa_factors) AS factors`);
    if (Object.values(activity.rows[0]).some((count) => Number(count) !== 0))
        throw Error('Authentication data exists; review affected objects before applying');
    const backupDir = path.join(root, 'backups');
    protectDirectory(backupDir);
    const backup = path.join(backupDir, `before-auth-v2-${Date.now()}.dump`);
    const dump = spawnSync(
        process.env.MEAL_PG_DUMP,
        ['-w', '--format=custom', '--no-owner', '--no-privileges', '--file', backup],
        { encoding: 'utf8', shell: false },
    );
    if (dump.status !== 0 || dump.error) throw Error('Backup failed; no migration applied');
    const hash = createHash('sha256').update(fs.readFileSync(backup)).digest('hex');
    fs.writeFileSync(backup + '.sha256', hash + '\n');
    protectDirectory(local);
    const migrate = spawnSync(process.execPath, [path.join(root, 'scripts/migrate.mjs'), '--apply'], {
        encoding: 'utf8',
        shell: false,
        env: process.env,
    });
    if (migrate.status !== 0 || migrate.error)
        throw Error('Migration failed; inspect migration runner without printing credentials');
    const password = randomBytes(32).toString('hex');
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
        await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
        // role is fixed and password contains only generated hex; never interpolate user input.
        await client.query(
            `CREATE ROLE meal_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${password}'`,
        );
        await client.query('GRANT CONNECT ON DATABASE meal_planner_postgres TO meal_app');
        await client.query('GRANT USAGE ON SCHEMA meal TO meal_app');
        // Same reviewed grants as the Linux handoff; omit transaction wrappers inside this transaction.
        const grants = fs.readFileSync(path.join(root, 'database/application-grants.sql'), 'utf8');
        await client.query(grants.replace(/^BEGIN ISOLATION LEVEL SERIALIZABLE;$/m, '').replace(/^COMMIT;$/m, '')); // Persist privately before commit; retain on an uncertain outcome for diagnosis.
        fs.writeFileSync(
            envFile,
            [
                'NODE_ENV=development',
                'HOST=127.0.0.1',
                'PORT=3001',
                'FRONTEND_ORIGIN=http://localhost:3000',
                `DATABASE_URL=postgresql://meal_app:${password}@127.0.0.1:54329/meal_planner_postgres`,
                `SECURITY_KEY=${randomBytes(32).toString('base64')}`,
                `MFA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
                'LOG_LEVEL=info',
                'AUTH_RATE_LIMIT=10',
                'TRUSTED_PROXY_CIDRS=',
                '',
            ].join('\n'),
            { mode: 0o600, flag: 'wx' },
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        // Retain credentials on uncertain commit for diagnosis; no destructive cleanup.
        throw error;
    }
    console.log(
        'Local migration and application role provisioned; private config saved. Backup: ' + path.basename(backup),
    );
} catch {
    console.error(
        'Provisioning stopped. No existing cluster or credentials were overwritten; inspect target/history before retry.',
    );
    process.exitCode = 1;
} finally {
    await client.end();
}
