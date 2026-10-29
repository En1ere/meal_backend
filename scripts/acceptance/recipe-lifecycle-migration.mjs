import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

const manifest = JSON.parse(fs.readFileSync(new URL('../../database/manifest.json', import.meta.url), 'utf8'));
const migrationSql = new Map(
    manifest.migrations.map((migration) => [
        migration.version,
        fs.readFileSync(new URL(`../../database/migrations/${migration.file}`, import.meta.url), 'utf8'),
    ]),
);

async function applyThrough28(connectionString) {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
        for (const migration of manifest.migrations.filter(({ version }) => version <= 28)) {
            await client.query('begin isolation level serializable');
            await client.query(migrationSql.get(migration.version));
            if (migration.version === 1)
                await client.query(`insert into meal.environment(name) values('test') on conflict do nothing`);
            await client.query(`insert into meal.schema_migrations(version,checksum) values($1,$2)`, [
                migration.version,
                migration.sha256,
            ]);
            await client.query('commit');
        }
    } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
    } finally {
        await client.end();
    }
}

async function seedV28(connectionString, duplicateActive) {
    const client = new pg.Client({ connectionString });
    await client.connect();
    const ids = {
        user: randomUUID(),
        scope: randomUUID(),
        recipe: randomUUID(),
        revision: randomUUID(),
        moderationCase: randomUUID(),
        decisions: [randomUUID(), randomUUID()],
        publications: [randomUUID(), randomUUID()],
    };
    try {
        await client.query('begin isolation level serializable');
        await client.query(
            `insert into meal.users(id,login,display_name,email_normalized,status,email_verified_at,is_test_account)
             values($1,$2,'Migration fixture',$3,'active',now(),true)`,
            [ids.user, `migration_${ids.user}`, `${ids.user}@example.test`],
        );
        await client.query(`insert into meal.data_scopes(id,kind,user_id) values($1,'private',$2)`, [
            ids.scope,
            ids.user,
        ]);
        await client.query(
            `insert into meal.recipes(id,title,status,author_id,scope_id) values($1,'Migration fixture','published',$2,$3)`,
            [ids.recipe, ids.user, ids.scope],
        );
        await client.query(
            `insert into meal.recipe_revisions(id,revision,title,portions,method,recipe_id,created_by)
             values($1,1,'Migration fixture',2,'Acceptance',$2,$3)`,
            [ids.revision, ids.recipe, ids.user],
        );
        await client.query(
            `insert into meal.moderation_cases(
               id,kind,status,reason,submitted_at,queue_priority,evidence,recipe_revision_id,reporter_id
             ) values($1,'recipe','published','Migration fixture',now(),1,'{}'::jsonb,$2,$3)`,
            [ids.moderationCase, ids.revision, ids.user],
        );
        for (const decision of ids.decisions)
            await client.query(
                `insert into meal.moderation_decisions(
                   id,action,reason,decided_at,before_snapshot,after_snapshot,case_id,actor_id
                 ) values($1,'publish','Migration fixture',now(),'{}'::jsonb,'{}'::jsonb,$2,$3)`,
                [decision, ids.moderationCase, ids.user],
            );
        const count = duplicateActive ? 2 : 1;
        for (let index = 0; index < count; index += 1)
            await client.query(
                `insert into meal.recipe_publications(id,published_at,unpublished_at,revision_id,decision_id)
                 values($1,now() + ($2::text || ' seconds')::interval,null,$3,$4)`,
                [ids.publications[index], index, ids.revision, ids.decisions[index]],
            );
        await client.query('commit');
        return ids;
    } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
    } finally {
        await client.end();
    }
}

async function apply29(connectionString) {
    const migration = manifest.migrations.find(({ version }) => version === 29);
    assert.ok(migration);
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
        await client.query('begin isolation level serializable');
        await client.query(migrationSql.get(29));
        await client.query(`insert into meal.schema_migrations(version,checksum) values(29,$1)`, [migration.sha256]);
        await client.query('commit');
    } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
    } finally {
        await client.end();
    }
}

export async function runRecipeLifecycleMigrationAcceptance(ownerConnectionString) {
    const base = new URL(ownerConnectionString);
    const suffix = randomBytes(6).toString('hex');
    const databases = [`meal_recipe_upgrade_${suffix}`, `meal_recipe_preflight_${suffix}`];
    for (const database of databases) assert.match(database, /^meal_recipe_(?:upgrade|preflight)_[a-f0-9]{12}$/u);
    const adminUrl = new URL(base);
    adminUrl.pathname = '/postgres';
    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
        for (const database of databases)
            await admin.query(`create database "${database}" template template0 encoding 'UTF8'`);

        const upgradeUrl = new URL(base);
        upgradeUrl.pathname = `/${databases[0]}`;
        await applyThrough28(upgradeUrl.toString());
        const upgradedIds = await seedV28(upgradeUrl.toString(), false);
        await apply29(upgradeUrl.toString());
        const upgraded = new pg.Client({ connectionString: upgradeUrl.toString() });
        await upgraded.connect();
        try {
            const state = await upgraded.query(
                `select
                   (select recipe_id from meal.recipe_publications where id=$1) recipe_id,
                   (select checksum from meal.schema_migrations where version=29) checksum,
                   (select tgenabled from pg_trigger where tgrelid='meal.recipe_publications'::regclass and tgname='protect_identity') protect_identity,
                   (select tgenabled from pg_trigger where tgrelid='meal.recipe_publications'::regclass and tgname='sync_recipe_publication_recipe_id') compatibility_trigger`,
                [upgradedIds.publications[0]],
            );
            assert.deepEqual(state.rows[0], {
                recipe_id: upgradedIds.recipe,
                checksum: manifest.migrations.find(({ version }) => version === 29).sha256,
                protect_identity: 'O',
                compatibility_trigger: 'O',
            });
        } finally {
            await upgraded.end();
        }

        const preflightUrl = new URL(base);
        preflightUrl.pathname = `/${databases[1]}`;
        await applyThrough28(preflightUrl.toString());
        await seedV28(preflightUrl.toString(), true);
        await assert.rejects(apply29(preflightUrl.toString()), /multiple active publications/u);
        const preflight = new pg.Client({ connectionString: preflightUrl.toString() });
        await preflight.connect();
        try {
            const state = await preflight.query(
                `select
                   exists(select 1 from information_schema.columns where table_schema='meal' and table_name='recipe_publications' and column_name='recipe_id') recipe_id_exists,
                   exists(select 1 from meal.schema_migrations where version=29) history_exists`,
            );
            assert.deepEqual(state.rows[0], { recipe_id_exists: false, history_exists: false });
        } finally {
            await preflight.end();
        }
    } finally {
        for (const database of databases) {
            await admin.query(
                `select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`,
                [database],
            );
            await admin.query(`drop database if exists "${database}"`);
        }
        await admin.end();
    }
}
