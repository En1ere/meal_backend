import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../../app/config.js';
import type { DatabaseSchema } from './schema.generated.js';

export function databasePoolConfig(connectionString: string) {
    const url = new URL(connectionString);
    const configuredOptions = url.searchParams.get('options')?.trim();
    url.searchParams.delete('options');
    return {
        connectionString: url.toString(),
        options: [configuredOptions, '-c timezone=UTC', '-c search_path=meal,public'].filter(Boolean).join(' '),
    };
}

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
    readonly db: Kysely<DatabaseSchema> | undefined;
    private readonly pool: pg.Pool | undefined;
    private readonly poolMax: number;
    constructor(@Inject(APP_CONFIG) config: AppConfig) {
        this.poolMax = config.DATABASE_POOL_SIZE;
        if (config.DATABASE_URL) {
            const connection = databasePoolConfig(config.DATABASE_URL);
            const pool = new pg.Pool({
                ...connection,
                max: config.DATABASE_POOL_SIZE,
                connectionTimeoutMillis: 3000,
                idleTimeoutMillis: 30000,
                statement_timeout: 10000,
                application_name: 'meal-planner-back',
            });
            // Never print raw PostgreSQL errors: they may contain SQL values.
            pool.on('error', () => console.error('PostgreSQL idle connection failed'));
            this.pool = pool;
            this.db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
        }
    }
    poolSnapshot() {
        if (!this.pool) return null;
        return {
            max: this.poolMax,
            total: this.pool.totalCount,
            idle: this.pool.idleCount,
            waiting: this.pool.waitingCount,
        };
    }
    async ready(): Promise<boolean> {
        if (!this.db) return false;
        try {
            const result = await sql<{ database: string; role_safe: boolean; migrated: boolean }>`
                select current_database() as database,
                  not (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolinherit or rolreplication)
                    as role_safe,
                  exists(select 1 from meal.schema_migrations where version=29) as migrated
                from pg_roles where rolname = current_user
            `.execute(this.db);
            return (
                result.rows[0]?.database === 'meal_planner_postgres' &&
                result.rows[0].role_safe &&
                result.rows[0].migrated
            );
        } catch {
            return false;
        }
    }
    async transaction<T>(run: (tx: Transaction<DatabaseSchema>) => Promise<T>): Promise<T> {
        if (!this.db) throw new Error('Database not configured');
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.db
                    .transaction()
                    .setIsolationLevel('serializable')
                    .execute(async (tx) => {
                        await sql`set local lock_timeout = '3s'`.execute(tx);
                        return run(tx);
                    });
            } catch (error) {
                const code = error instanceof Error && 'code' in error ? error.code : undefined;
                const constraint = error instanceof Error && 'constraint' in error ? error.constraint : undefined;
                // A waiting SERIALIZABLE transaction can retain the pre-insert snapshot.
                // Retry only coordination uniqueness races, never arbitrary business uniqueness.
                const coordinationRace =
                    code === '23505' &&
                    (constraint === 'uq_data_scopes_user_id' ||
                        constraint === 'uq_family_memberships_user_id' ||
                        constraint === 'uq_recipe_bookmarks_recipe_id_user_id' ||
                        constraint === 'uq_idempotency_records_actor_namespace_operatio_9fed2ea62318');
                if (attempt >= 2 || (code !== '40001' && code !== '40P01' && !coordinationRace)) throw error;
                await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt + Math.random() * 20));
            }
        }
    }
    async onApplicationShutdown(): Promise<void> {
        await this.db?.destroy();
    }
}
