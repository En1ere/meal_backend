import { HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { ownProfileSchema, publicProfileSchema, publicProjection, updateOwnProfileSchema } from './profiles.schemas.js';
import { LegalConsentService } from '../legal-consents/legal-consent.service.js';

@Injectable()
export class ProfilesService {
    constructor(
        private readonly database: DatabaseService,
        private readonly legalConsents: LegalConsentService,
    ) {}
    private async connection() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    async own(userId: string) {
        const db = await this.connection();
        const row = await db
            .selectFrom('users')
            .leftJoin('user_settings', 'user_settings.user_id', 'users.id')
            .select([
                'users.id',
                'users.login',
                'users.display_name',
                'users.email_normalized',
                'users.email_verified_at',
                'users.version',
                'user_settings.timezone',
                'user_settings.locale',
                'user_settings.theme',
            ])
            .where('users.id', '=', userId)
            .where('users.status', '=', 'active')
            .where('users.archived_at', 'is', null)
            .executeTakeFirst();
        if (!row) throw new NotFoundException();
        const count = await sql<{
            count: number;
        }>`select count(distinct r.id)::integer count from meal.recipes r join meal.recipe_revisions rr on rr.recipe_id=r.id join meal.recipe_publications p on p.revision_id=rr.id where r.author_id=${row.id}::uuid and r.archived_at is null and r.status not in('hidden','unpublished','deleted','archived') and p.unpublished_at is null and p.published_at<=now()`.execute(
            db,
        );
        return {
            profile: ownProfileSchema.parse({
                id: row.id,
                username: row.login,
                displayName: row.display_name,
                email: row.email_normalized,
                emailVerified: row.email_verified_at !== null,
                timezone: row.timezone,
                locale: row.locale,
                theme: row.theme,
                version: Number(row.version),
                public: publicProjection(row.login, count.rows[0]?.count ?? 0),
            }),
        };
    }
    async update(userId: string, raw: unknown) {
        const input = updateOwnProfileSchema.parse(raw);
        try {
            new Intl.DateTimeFormat('ru', { timeZone: input.timezone });
        } catch {
            throw new HttpException('Неизвестный часовой пояс', 400);
        }
        const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        await this.database.transaction(async (tx) => {
            const prior = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', 'profile.update')
                .where('target_binding', '=', userId)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (prior) {
                if (prior.request_hash !== hash) throw new HttpException('Ключ использован для другого запроса', 409);
                return;
            }
            const user = await tx
                .selectFrom('users')
                .select(['id', 'version'])
                .where('id', '=', userId)
                .where('status', '=', 'active')
                .forUpdate()
                .executeTakeFirst();
            if (!user) throw new HttpException('Аккаунт недоступен', 403);
            const banned =
                await sql`select id from meal.sanctions where user_id=${userId}::uuid and scope='account' and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                    tx,
                );
            if (banned.rows.length) throw new HttpException('Доступен только просмотр', 403);
            if (Number(user.version) !== input.expectedVersion) throw new HttpException('Профиль изменился', 412);
            await tx
                .updateTable('users')
                .set({ display_name: input.displayName, version: input.expectedVersion + 1 })
                .where('id', '=', userId)
                .execute();
            const settings = await tx
                .selectFrom('user_settings')
                .select('version')
                .where('user_id', '=', userId)
                .executeTakeFirst();
            if (settings)
                await tx
                    .updateTable('user_settings')
                    .set({
                        timezone: input.timezone,
                        locale: input.locale,
                        theme: input.theme,
                        version: Number(settings.version) + 1,
                    })
                    .where('user_id', '=', userId)
                    .execute();
            else
                await tx
                    .insertInto('user_settings')
                    .values({
                        id: randomUUID(),
                        user_id: userId,
                        timezone: input.timezone,
                        locale: input.locale,
                        theme: input.theme,
                        onboarding_state: null,
                        preferences: null,
                        expiry_control: null,
                        inventory_reminders: null,
                        version: 1,
                    })
                    .execute();
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'profile.update',
                    target_binding: userId,
                    key: input.idempotencyKey,
                    request_hash: hash,
                    status: 'completed',
                    response_snapshot: { version: input.expectedVersion + 1 },
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: userId,
                    scope_id: null,
                    actor_namespace: `user:${userId}`,
                })
                .execute();
        });
        return this.own(userId);
    }
    async public(username: string) {
        const db = await this.connection();
        // Deliberately select only the public identity; never serialize a complete users row.
        const row = await sql<{ id: string; login: string; recipeCount: number }>`
          select u.id,u.login,(select count(distinct r.id)::integer from meal.recipes r join meal.recipe_revisions rr on rr.recipe_id=r.id join meal.recipe_publications p on p.revision_id=rr.id where r.author_id=u.id and r.archived_at is null and r.status not in('hidden','unpublished','deleted','archived') and p.unpublished_at is null and p.published_at<=now()) as "recipeCount"
          from meal.users u where lower(u.login)=lower(${username}) and u.status='active' and u.archived_at is null and u.email_verified_at is not null
            and not exists(select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now())) limit 1`.execute(
            db,
        );
        if (!row.rows[0]) throw new NotFoundException();
        if (!(await this.legalConsents.allowsFeatureAccess(row.rows[0].id, 'dissemination', db)))
            throw new NotFoundException();
        return {
            profile: publicProfileSchema.parse(publicProjection(row.rows[0].login, row.rows[0].recipeCount)),
        };
    }
}
