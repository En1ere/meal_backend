import { createHash, randomUUID } from 'node:crypto';
import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { aggregateNutrition, completeness, unknownNutrition } from '../diary/diary.domain.js';
import type { DiaryEntry } from '../diary/diary.contracts.js';
import { ProAccessService } from '../pro-overview/pro-access.service.js';
import { LegalConsentService } from '../legal-consents/legal-consent.service.js';
import {
    nutritionAnalyticsSchema,
    nutritionProfileSchema,
    nutritionSettingsSchema,
    nutritionTargetSchema,
    type NutritionAnalytics,
    type NutritionProfileUpdate,
    type NutritionSettings,
    type NutritionTarget,
    type NutritionTargetCreate,
} from './nutrition.contracts.js';

type Tx = Transaction<DatabaseSchema>;
type ProfileRow = { id: string; profileData: unknown; version: number; createdAt: Date };
type TargetRow = {
    id: string;
    startsOn: string;
    endsOn: string | null;
    targets: unknown;
    source: string;
    version: number;
    createdAt: Date;
};
type EntryRow = { date: string; nutrition: unknown };

const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const decimalValue = (value: unknown): string | null => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const normalized = String(value);
    return /^\d+(\.\d{1,8})?$/.test(normalized) ? normalized : null;
};

export function projectNutritionTarget(row: TargetRow): NutritionTarget {
    const values = record(row.targets);
    return nutritionTargetSchema.parse({
        id: row.id,
        effectiveFrom: row.startsOn,
        effectiveTo: row.endsOn,
        values: {
            energyKcal: decimalValue(values.energyKcal ?? values.energy_kcal),
            proteinG: decimalValue(values.proteinG ?? values.protein_g),
            fatG: decimalValue(values.fatG ?? values.fat_g),
            carbohydrateG: decimalValue(values.carbohydrateG ?? values.carbohydrate_g),
            fiberG: decimalValue(values.fiberG ?? values.fiber_g),
        },
        source: row.source,
        version: Number(row.version),
        createdAt: new Date(row.createdAt).toISOString(),
    });
}

const snapshot = (value: unknown): DiaryEntry['nutrition'] => {
    const source = record(value);
    const nested = record(source.nutrition);
    const candidate = Object.keys(nested).length ? nested : source;
    return {
        energyKcal: decimalValue(candidate.energyKcal ?? candidate.energy_kcal ?? candidate.kcal),
        proteinG: decimalValue(candidate.proteinG ?? candidate.protein_g ?? candidate.protein),
        fatG: decimalValue(candidate.fatG ?? candidate.fat_g ?? candidate.fat),
        carbohydrateG: decimalValue(candidate.carbohydrateG ?? candidate.carbohydrate_g ?? candidate.carbs),
        fiberG: decimalValue(candidate.fiberG ?? candidate.fiber_g ?? candidate.fiber),
    };
};

const targetOn = (targets: NutritionTarget[], date: string) =>
    targets.find(
        (target) => target.effectiveFrom <= date && (target.effectiveTo === null || target.effectiveTo >= date),
    ) ?? null;

const progress = (actual: DiaryEntry['nutrition'], target: NutritionTarget | null) =>
    Object.fromEntries(
        Object.keys(unknownNutrition()).map((key) => {
            const nutrient = key as keyof DiaryEntry['nutrition'];
            const fact = actual[nutrient];
            const goal = target?.values[nutrient] ?? null;
            return [
                nutrient,
                fact === null || goal === null || Number(goal) <= 0 ? null : (Number(fact) / Number(goal)) * 100,
            ];
        }),
    );

export function projectNutritionAnalytics(
    rows: EntryRow[],
    targets: NutritionTarget[],
    access: NutritionAnalytics['access'],
    from: string,
    to: string,
): NutritionAnalytics {
    const dataThrough =
        access.mode === 'read_only' && access.periodEndsAt
            ? access.periodEndsAt.slice(0, 10) < to
                ? access.periodEndsAt.slice(0, 10)
                : to
            : to;
    const grouped = new Map<string, DiaryEntry['nutrition'][]>();
    for (const row of rows) {
        if (row.date < from || row.date > dataThrough) continue;
        grouped.set(row.date, [...(grouped.get(row.date) ?? []), snapshot(row.nutrition)]);
    }
    const days = [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, entries]) => {
            const nutrition = aggregateNutrition(entries.map((value) => ({ nutrition: value })));
            const target = targetOn(targets, date);
            return {
                date,
                entryCount: entries.length,
                nutrition,
                completeness: completeness(nutrition),
                target,
                progressPercent: progress(nutrition, target),
            };
        });
    return nutritionAnalyticsSchema.parse({
        access,
        period: { from, to, dataThrough },
        days,
        summary: {
            entryCount: days.reduce((sum, day) => sum + day.entryCount, 0),
            daysWithEntries: days.length,
            completeDays: days.filter((day) => day.completeness === 'complete').length,
            partialDays: days.filter((day) => day.completeness === 'partial').length,
            unknownDays: days.filter((day) => day.completeness === 'unknown').length,
        },
        disclaimer: 'informational_not_medical',
    });
}

@Injectable()
export class NutritionService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: ProAccessService,
        private readonly legalConsents: LegalConsentService,
    ) {}

    private async ready() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
    }

    private async profile(tx: Tx, userId: string): Promise<ProfileRow | null> {
        const result = await sql<ProfileRow>`
            select id,profile_data as "profileData",version::integer,created_at as "createdAt"
            from meal.nutrition_profiles where user_id=${userId}::uuid limit 1
        `.execute(tx);
        return result.rows[0] ?? null;
    }

    private async targets(tx: Tx, profileId: string): Promise<NutritionTarget[]> {
        const result = await sql<TargetRow>`
            select id,starts_on::text as "startsOn",ends_on::text as "endsOn",targets,source,
                   version::integer,created_at as "createdAt"
            from meal.nutrition_targets where profile_id=${profileId}::uuid
            order by starts_on desc,created_at desc,id desc
        `.execute(tx);
        return result.rows.map(projectNutritionTarget);
    }

    private projectSettings(
        access: NutritionSettings['access'],
        row: ProfileRow | null,
        targets: NutritionTarget[],
    ): NutritionSettings {
        const data = record(row?.profileData);
        const goal =
            data.goal === 'maintain' ||
            data.goal === 'lose_weight' ||
            data.goal === 'gain_weight' ||
            data.goal === 'custom'
                ? data.goal
                : null;
        return nutritionSettingsSchema.parse({
            access,
            profile: row
                ? nutritionProfileSchema.parse({
                      id: row.id,
                      goal,
                      version: row.version,
                      createdAt: new Date(row.createdAt).toISOString(),
                  })
                : null,
            currentTarget: targets[0] ?? null,
            targetHistory: targets,
            policy: { mode: 'manual_only', medicalAdvice: false, automaticTargetsAvailable: false },
        });
    }

    private async replay<T>(tx: Tx, userId: string, target: string, key: string, body: unknown, run: () => Promise<T>) {
        const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const prior = await tx
            .selectFrom('idempotency_records')
            .select(['request_hash', 'response_snapshot'])
            .where('actor_namespace', '=', `user:${userId}`)
            .where('operation', '=', 'nutrition')
            .where('target_binding', '=', target)
            .where('key', '=', key)
            .executeTakeFirst();
        if (prior) {
            if (prior.request_hash !== hash) throw new HttpException('Ключ уже использован с другими данными', 409);
            return prior.response_snapshot as T;
        }
        const result = await run();
        await tx
            .insertInto('idempotency_records')
            .values({
                id: randomUUID(),
                operation: 'nutrition',
                target_binding: target,
                key,
                request_hash: hash,
                status: 'completed',
                response_snapshot: JSON.stringify(result),
                expires_at: new Date('9999-12-31T00:00:00Z'),
                user_id: userId,
                scope_id: null,
                actor_namespace: `user:${userId}`,
            })
            .execute();
        return result;
    }

    async settings(userId: string) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            await this.legalConsents.assertFeatureAccess(userId, 'special_category', 'nutrition.analytics', tx);
            const access = await this.access.resolve(userId, tx);
            const profile = await this.profile(tx, userId);
            return this.projectSettings(access, profile, profile ? await this.targets(tx, profile.id) : []);
        });
    }

    async updateProfile(userId: string, input: NutritionProfileUpdate) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            await this.legalConsents.assertFeatureAccess(userId, 'special_category', 'nutrition.analytics', tx);
            const access = await this.access.requireActive(userId, tx);
            return this.replay(tx, userId, 'profile', input.idempotencyKey, input, async () => {
                const current = await this.profile(tx, userId);
                if (!current && input.expectedVersion !== null) throw new HttpException('Профиль ещё не создан', 412);
                if (current && input.expectedVersion !== current.version)
                    throw new HttpException('Профиль питания изменился', 412);
                if (!current) {
                    await tx
                        .insertInto('nutrition_profiles')
                        .values({
                            id: randomUUID(),
                            restrictions: null,
                            likes: null,
                            dislikes: null,
                            allergen_mode: 'warn',
                            profile_data: JSON.stringify({ goal: input.goal }),
                            user_id: userId,
                            created_at: new Date(),
                            version: 1,
                        })
                        .execute();
                } else {
                    const updated = await sql`
                        update meal.nutrition_profiles
                        set profile_data=coalesce(profile_data,'{}'::jsonb) || ${JSON.stringify({ goal: input.goal })}::jsonb,
                            version=version+1
                        where id=${current.id}::uuid and version=${current.version}
                    `.execute(tx);
                    if (Number(updated.numAffectedRows) !== 1)
                        throw new HttpException('Профиль питания изменился', 412);
                }
                const profile = await this.profile(tx, userId);
                if (!profile) throw new ServiceUnavailableException();
                const result = this.projectSettings(access, profile, await this.targets(tx, profile.id));
                await this.audit(
                    tx,
                    userId,
                    'nutrition.profile.updated',
                    'nutrition_profile',
                    profile.id,
                    input.idempotencyKey,
                    {
                        goal: input.goal,
                        version: profile.version,
                    },
                );
                return result;
            });
        });
    }

    async createTarget(userId: string, input: NutritionTargetCreate) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            await this.legalConsents.assertFeatureAccess(userId, 'special_category', 'nutrition.analytics', tx);
            const access = await this.access.requireActive(userId, tx);
            return this.replay(tx, userId, 'target', input.idempotencyKey, input, async () => {
                const profile = await this.profile(tx, userId);
                if (!profile) throw new HttpException('Сначала сохраните профиль питания', 409);
                if (profile.version !== input.expectedProfileVersion)
                    throw new HttpException('Профиль питания изменился', 412);
                const targets = await this.targets(tx, profile.id);
                const current = targets[0];
                if (current && input.effectiveFrom <= current.effectiveFrom)
                    throw new HttpException('Новая цель должна начинаться после текущей', 409);
                const changed = await sql`
                    update meal.nutrition_profiles set version=version+1
                    where id=${profile.id}::uuid and version=${profile.version}
                `.execute(tx);
                if (Number(changed.numAffectedRows) !== 1) throw new HttpException('Профиль питания изменился', 412);
                if (current)
                    await sql`
                        update meal.nutrition_targets
                        set ends_on=(${input.effectiveFrom}::date - interval '1 day')::date,version=version+1
                        where id=${current.id}::uuid and ends_on is null
                    `.execute(tx);
                const targetId = randomUUID();
                await tx
                    .insertInto('nutrition_targets')
                    .values({
                        id: targetId,
                        starts_on: input.effectiveFrom,
                        ends_on: null,
                        targets: JSON.stringify({
                            energy_kcal: input.energyKcal,
                            protein_g: input.proteinG,
                            fat_g: input.fatG,
                            carbohydrate_g: input.carbohydrateG,
                            fiber_g: input.fiberG,
                        }),
                        source: 'manual',
                        profile_id: profile.id,
                        created_at: new Date(),
                        version: 1,
                    })
                    .execute();
                const updatedProfile = await this.profile(tx, userId);
                if (!updatedProfile) throw new ServiceUnavailableException();
                const result = this.projectSettings(access, updatedProfile, await this.targets(tx, profile.id));
                await this.audit(
                    tx,
                    userId,
                    'nutrition.target.created',
                    'nutrition_target',
                    targetId,
                    input.idempotencyKey,
                    {
                        effectiveFrom: input.effectiveFrom,
                        fields: Object.values(result.currentTarget?.values ?? {}).filter((value) => value !== null)
                            .length,
                    },
                );
                return result;
            });
        });
    }

    private async audit(
        tx: Tx,
        userId: string,
        action: string,
        targetType: 'nutrition_profile' | 'nutrition_target',
        targetId: string,
        requestId: string,
        after: unknown,
    ) {
        await tx
            .insertInto('audit_events')
            .values({
                id: randomUUID(),
                action,
                target_type: targetType,
                target_id: targetId,
                effective_at: new Date(),
                recorded_at: new Date(),
                reason: null,
                before_redacted: null,
                after_redacted: JSON.stringify(after),
                request_id: requestId,
                actor_id: userId,
                scope_id: null,
            })
            .execute();
    }

    async analytics(userId: string, from: string, to: string) {
        await this.ready();
        if (from > to) throw new HttpException('Начало периода позже окончания', 400);
        const days = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
        if (days > 92) throw new HttpException('Период аналитики не может превышать 92 дня', 400);
        return this.database.transaction(async (tx) => {
            await this.legalConsents.assertFeatureAccess(userId, 'special_category', 'nutrition.analytics', tx);
            const access = await this.access.resolve(userId, tx);
            const profile = await this.profile(tx, userId);
            const targets = profile ? await this.targets(tx, profile.id) : [];
            const dataThrough =
                access.mode === 'read_only' && access.periodEndsAt && access.periodEndsAt.slice(0, 10) < to
                    ? access.periodEndsAt.slice(0, 10)
                    : to;
            const rows = await sql<EntryRow>`
                select (
                    entry.eaten_at at time zone coalesce(
                        (select settings.timezone from meal.user_settings settings where settings.user_id=${userId}::uuid),
                        'UTC'
                    )
                )::date::text as date,entry.nutrition_snapshot as nutrition
                from meal.diary_entries entry
                where entry.owner_id=${userId}::uuid and entry.state<>'archived'
                  and (
                    entry.eaten_at at time zone coalesce(
                        (select settings.timezone from meal.user_settings settings where settings.user_id=${userId}::uuid),
                        'UTC'
                    )
                  )::date between ${from}::date and ${dataThrough}::date
                order by entry.eaten_at,entry.id
            `.execute(tx);
            return projectNutritionAnalytics(rows.rows, targets, access, from, to);
        });
    }
}
