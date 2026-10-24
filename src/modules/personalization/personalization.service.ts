import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { RecommendationsService } from '../recommendations/recommendations.service.js';
import { LegalConsentService } from '../legal-consents/legal-consent.service.js';
import {
    homeSchema,
    onboardingSchema,
    onboardingUpdateSchema,
    personalizationSchema,
    preferenceCatalog,
    preferencesSchema,
    preferencesUpdateSchema,
} from './personalization.contracts.js';

const defaultOnboarding = () => ({ flow: null, status: 'not_started' as const, step: 0, totalSteps: 0, version: 1 });
const defaultPreferences = () => ({
    diets: [],
    allergens: [],
    dislikes: [],
    allergenMode: 'warn' as const,
    equipment: {},
    goals: [],
    version: 1,
});
const totalSteps = (flow: string | null) => (flow === 'quick' ? 3 : flow === 'detailed' ? 5 : flow === 'demo' ? 7 : 0);
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const jsonObject = (value: unknown): { [key: string]: JsonValue } => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return JSON.parse(JSON.stringify(value)) as { [key: string]: JsonValue };
};
export const allergenPreferencesChanged = (before: { [key: string]: JsonValue }, next: { [key: string]: JsonValue }) =>
    JSON.stringify(before.allergens ?? []) !== JSON.stringify(next.allergens ?? []) ||
    (before.allergenMode ?? 'warn') !== (next.allergenMode ?? 'warn');
const localDate = (date: Date, timeZone: string) => {
    const parts = new Intl.DateTimeFormat('en', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
};

@Injectable()
export class PersonalizationService {
    constructor(
        private readonly database: DatabaseService,
        private readonly recommendations: RecommendationsService,
        private readonly legalConsents: LegalConsentService,
    ) {}
    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    async detail(userId: string) {
        const db = await this.db();
        const row = await db
            .selectFrom('user_settings')
            .select(['onboarding_state', 'preferences', 'version'])
            .where('user_id', '=', userId)
            .executeTakeFirst();
        const version = Number(row?.version ?? 1);
        const onboarding = onboardingSchema.safeParse({ ...jsonObject(row?.onboarding_state), version });
        const preferences = preferencesSchema.safeParse({ ...jsonObject(row?.preferences), version });
        return personalizationSchema.parse({
            onboarding: onboarding.success ? onboarding.data : { ...defaultOnboarding(), version },
            preferences: preferences.success ? preferences.data : { ...defaultPreferences(), version },
            catalog: preferenceCatalog,
        });
    }
    private update(
        userId: string,
        operation: string,
        input: Record<string, unknown>,
        field: 'onboarding_state' | 'preferences',
        value: Record<string, unknown>,
    ) {
        return this.database.transaction(async (tx) => {
            const user = await tx
                .selectFrom('users')
                .select('id')
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
            const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            const prior = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', operation)
                .where('target_binding', '=', userId)
                .where('key', '=', String(input.idempotencyKey))
                .executeTakeFirst();
            if (prior) {
                if (prior.request_hash !== hash) throw new HttpException('Ключ использован для другого запроса', 409);
                return prior.response_snapshot;
            }
            const current = await tx
                .selectFrom('user_settings')
                .select(['version', 'preferences'])
                .where('user_id', '=', userId)
                .executeTakeFirst();
            if (Number(current?.version ?? 1) !== input.expectedVersion)
                throw new HttpException('Настройки изменились', 412);
            if (field === 'preferences') {
                const before = jsonObject(current?.preferences);
                const allergenFieldsChanged = allergenPreferencesChanged(before, jsonObject(value));
                if (allergenFieldsChanged)
                    await this.legalConsents.assertFeatureAccess(
                        userId,
                        'special_category',
                        'preferences.allergens',
                        tx,
                    );
            }
            const nextVersion = Number(input.expectedVersion) + 1;
            if (current)
                await tx
                    .updateTable('user_settings')
                    .set({ [field]: jsonObject(value), version: nextVersion })
                    .where('user_id', '=', userId)
                    .execute();
            else
                await tx
                    .insertInto('user_settings')
                    .values({
                        id: randomUUID(),
                        user_id: userId,
                        timezone: 'Europe/Moscow',
                        locale: 'ru',
                        theme: null,
                        onboarding_state: field === 'onboarding_state' ? jsonObject(value) : null,
                        preferences: field === 'preferences' ? jsonObject(value) : null,
                        expiry_control: null,
                        inventory_reminders: null,
                        version: nextVersion,
                    })
                    .execute();
            const result =
                field === 'onboarding_state'
                    ? onboardingSchema.parse({ ...value, version: nextVersion })
                    : preferencesSchema.parse({ ...value, version: nextVersion });
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation,
                    target_binding: userId,
                    key: String(input.idempotencyKey),
                    request_hash: hash,
                    status: 'completed',
                    response_snapshot: jsonObject(result),
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: userId,
                    scope_id: null,
                    actor_namespace: `user:${userId}`,
                })
                .execute();
            return result;
        });
    }
    updateOnboarding(userId: string, raw: unknown) {
        const input = onboardingUpdateSchema.parse(raw);
        return this.update(userId, 'settings.onboarding', input, 'onboarding_state', {
            flow: input.flow,
            status: input.status,
            step: input.step,
            totalSteps: totalSteps(input.flow),
        });
    }
    updatePreferences(userId: string, raw: unknown) {
        const input = preferencesUpdateSchema.parse(raw);
        const { expectedVersion, idempotencyKey, ...value } = input;
        return this.update(
            userId,
            'settings.preferences',
            { ...value, expectedVersion, idempotencyKey },
            'preferences',
            value,
        );
    }
    async home(userId: string) {
        const db = await this.db();
        const setting = await db
            .selectFrom('user_settings')
            .select('timezone')
            .where('user_id', '=', userId)
            .executeTakeFirst();
        const today = localDate(new Date(), setting?.timezone ?? 'Europe/Moscow');
        const [personalization, recommendations, counts, expiring, plan] = await Promise.all([
            this.detail(userId),
            this.recommendations.recipes(userId, 'private', 3, 'home'),
            sql<{
                inventoryCount: number;
                activeShoppingLists: number;
            }>`select (select count(*)::integer from meal.inventory_batches b join meal.data_scopes s on s.id=b.scope_id where s.kind='private' and s.user_id=${userId}::uuid and b.archived_at is null) as "inventoryCount", (select count(*)::integer from meal.shopping_lists l join meal.data_scopes s on s.id=l.scope_id where s.kind='private' and s.user_id=${userId}::uuid and l.status='active') as "activeShoppingLists"`.execute(
                db,
            ),
            sql<
                Record<string, unknown>
            >`select b.id,b.name,b.expiry_on::text as "expiryOn",(b.expiry_on-${today}::date)::integer as "daysLeft" from meal.inventory_batches b join meal.data_scopes s on s.id=b.scope_id where s.kind='private' and s.user_id=${userId}::uuid and b.archived_at is null and b.expiry_on is not null order by b.expiry_on,b.id limit 3`.execute(
                db,
            ),
            sql<
                Record<string, unknown>
            >`select e.id,e.date::text as date,e.meal,rr.title from meal.plan_entries e join meal.plan_revisions pr on pr.id=e.revision_id join meal.meal_plans p on p.id=pr.plan_id join meal.data_scopes s on s.id=p.scope_id left join meal.recipe_revisions rr on rr.id=e.recipe_revision_id where s.kind='private' and s.user_id=${userId}::uuid and e.date between ${today}::date and ${today}::date+1 order by e.date,e.meal,e.id limit 6`.execute(
                db,
            ),
        ]);
        return homeSchema.parse({
            recommendations,
            expiring: expiring.rows,
            plan: plan.rows,
            inventoryCount: counts.rows[0]?.inventoryCount ?? 0,
            activeShoppingLists: counts.rows[0]?.activeShoppingLists ?? 0,
            onboarding: personalization.onboarding,
        });
    }
}
