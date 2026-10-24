import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { AiService } from '../ai/ai.service.js';
import { proOverviewSchema, type ProMissingField, type ProOverview } from './pro-overview.contracts.js';
import { ProAccessService } from './pro-access.service.js';

type JsonObject = Record<string, unknown>;
type OverviewRow = {
    profileData: unknown;
    targetStartsOn: string | null;
    targetEndsOn: string | null;
    targets: unknown;
    diaryCount: number;
    expenseCount: number;
};

const object = (value: unknown): JsonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};

const decimal = (value: unknown): string | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return value.trim();
    return null;
};

const goal = (value: unknown): ProOverview['goal'] =>
    value === 'maintain' || value === 'lose_weight' || value === 'gain_weight' || value === 'custom' ? value : null;

export function projectProOverview(
    row: OverviewRow,
    access: ProOverview['access'],
    ai: ProOverview['ai'],
): ProOverview {
    const profile = object(row.profileData);
    const targetValues = object(row.targets);
    const currentGoal = goal(profile.goal);
    const targets = row.targetStartsOn
        ? {
              effectiveFrom: row.targetStartsOn,
              effectiveTo: row.targetEndsOn,
              energyKcal: decimal(targetValues.energy_kcal ?? targetValues.energyKcal),
              proteinG: decimal(targetValues.protein_g ?? targetValues.proteinG),
              fatG: decimal(targetValues.fat_g ?? targetValues.fatG),
              carbohydrateG: decimal(targetValues.carbohydrate_g ?? targetValues.carbohydrateG),
              fiberG: decimal(targetValues.fiber_g ?? targetValues.fiberG),
          }
        : null;
    const missingFields: ProMissingField[] = [];
    if (row.profileData === null) missingFields.push('nutrition_profile');
    if (!currentGoal) missingFields.push('goal');
    if (!targets?.energyKcal) missingFields.push('energy_kcal');
    if (!targets?.proteinG) missingFields.push('protein_g');
    if (!targets?.fatG) missingFields.push('fat_g');
    if (!targets?.carbohydrateG) missingFields.push('carbohydrate_g');
    if (!targets?.fiberG) missingFields.push('fiber_g');
    return proOverviewSchema.parse({
        access,
        goal: currentGoal,
        targets,
        missingFields,
        diaryCount: Number(row.diaryCount),
        expenseCount: Number(row.expenseCount),
        ai,
    });
}

@Injectable()
export class ProOverviewService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: ProAccessService,
        private readonly ai: AiService,
    ) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    async get(userId: string) {
        const db = await this.db();
        const access = await this.access.resolve(userId, db);
        const result = await sql<OverviewRow>`
            select
                profile.profile_data as "profileData",
                target.starts_on::text as "targetStartsOn",
                target.ends_on::text as "targetEndsOn",
                target.targets,
                (select count(*)::integer from meal.diary_entries where owner_id=${userId}::uuid) as "diaryCount",
                (
                    select count(*)::integer
                    from meal.expenses expense
                    join meal.data_scopes scope on scope.id=expense.scope_id
                    where scope.kind='private' and scope.user_id=${userId}::uuid
                ) as "expenseCount"
            from (select 1) seed
            left join lateral (
                select nutrition.profile_data,nutrition.id
                from meal.nutrition_profiles nutrition
                where nutrition.user_id=${userId}::uuid
                order by nutrition.created_at desc,nutrition.id desc
                limit 1
            ) profile on true
            left join lateral (
                select history.starts_on,history.ends_on,history.targets
                from meal.nutrition_targets history
                where history.profile_id=profile.id
                order by history.starts_on desc,history.created_at desc,history.id desc
                limit 1
            ) target on true
        `.execute(db);
        const row = result.rows[0];
        if (!row) throw new ServiceUnavailableException();
        const balance = await this.ai.balance(userId);
        return projectProOverview(row, access, balance);
    }
}
