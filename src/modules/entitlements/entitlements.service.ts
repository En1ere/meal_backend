import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { entitlementSchema, type Entitlement, type PlanCode } from './entitlements.contracts.js';

type Db = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

const rank: Record<PlanCode, number> = { free: 0, plus: 1, pro: 2 };
const allowance: Record<PlanCode, number> = { free: 0, plus: 40, pro: 120 };

export const entitlementCapabilities = (plan: PlanCode) => ({
    family: rank[plan] >= rank.plus,
    qr: rank[plan] >= rank.plus,
    planningRange: rank[plan] >= rank.plus,
    smartShopping: rank[plan] >= rank.plus,
    familyChat: rank[plan] >= rank.plus,
    familyNotes: rank[plan] >= rank.plus,
    calendar: plan === 'pro',
    finance: plan === 'pro',
    diary: plan === 'pro',
    aiMonthlyAllowance: allowance[plan],
});

type Candidate = {
    plan: PlanCode;
    source: Entitlement['source'];
    subscriptionId: string;
    familyId: string | null;
    periodEndsAt: Date;
    graceEndsAt: Date | null;
};

@Injectable()
export class EntitlementsService {
    constructor(private readonly database: DatabaseService) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    private result(candidate?: Candidate | null): Entitlement {
        const plan = candidate?.plan ?? 'free';
        return entitlementSchema.parse({
            plan,
            source: candidate?.source ?? 'none',
            subscriptionId: candidate?.subscriptionId ?? null,
            familyId: candidate?.familyId ?? null,
            periodEndsAt: candidate ? candidate.periodEndsAt.toISOString() : null,
            graceEndsAt: candidate?.graceEndsAt?.toISOString() ?? null,
            capabilities: entitlementCapabilities(plan),
        });
    }

    private async candidates(db: Db, userId: string): Promise<Candidate[]> {
        const personal = await db
            .selectFrom('subscriptions as subscription')
            .innerJoin('billing_products as product', 'product.id', 'subscription.product_id')
            .innerJoin('subscription_periods as period', 'period.subscription_id', 'subscription.id')
            .leftJoin('grace_incidents as grace', (join) =>
                join.onRef('grace.subscription_id', '=', 'subscription.id').on('grace.ends_at', '>', new Date()),
            )
            .select([
                'subscription.id as subscriptionId',
                'product.code as plan',
                'period.ends_at as periodEndsAt',
                'period.grant_kind as grantKind',
                'grace.ends_at as graceEndsAt',
            ])
            .where('subscription.owner_id', '=', userId)
            .where('subscription.status', '=', 'active')
            .where('period.starts_at', '<=', new Date())
            .where((expression) =>
                expression.not(
                    expression.exists(
                        expression
                            .selectFrom('subscription_changes as revocation')
                            .select('revocation.id')
                            .whereRef('revocation.subscription_id', '=', 'subscription.id')
                            .where('revocation.kind', '=', 'revokeGift')
                            .where('revocation.status', '=', 'applied')
                            .where(sql<boolean>`revocation.preview->>'targetId'=period.id::text`),
                    ),
                ),
            )
            .where((expression) =>
                expression.or([
                    expression('period.ends_at', '>', new Date()),
                    expression('grace.ends_at', '>', new Date()),
                ]),
            )
            .execute();
        const family = await db
            .selectFrom('family_memberships as membership')
            .innerJoin('family_coverages as coverage', 'coverage.family_id', 'membership.family_id')
            .innerJoin('subscriptions as subscription', 'subscription.id', 'coverage.subscription_id')
            .innerJoin('billing_products as product', 'product.id', 'subscription.product_id')
            .innerJoin('subscription_periods as period', 'period.subscription_id', 'subscription.id')
            .leftJoin('grace_incidents as grace', (join) =>
                join.onRef('grace.subscription_id', '=', 'subscription.id').on('grace.ends_at', '>', new Date()),
            )
            .select([
                'subscription.id as subscriptionId',
                'product.code as plan',
                'period.ends_at as periodEndsAt',
                'membership.family_id as familyId',
                'grace.ends_at as graceEndsAt',
            ])
            .where('membership.user_id', '=', userId)
            .where('membership.left_at', 'is', null)
            .where('coverage.selected_at', 'is not', null)
            .where('coverage.starts_at', '<=', new Date())
            .where((expression) =>
                expression.or([
                    expression('coverage.ends_at', 'is', null),
                    expression('coverage.ends_at', '>', new Date()),
                ]),
            )
            .where('subscription.status', '=', 'active')
            .where('period.starts_at', '<=', new Date())
            .where((expression) =>
                expression.not(
                    expression.exists(
                        expression
                            .selectFrom('subscription_changes as revocation')
                            .select('revocation.id')
                            .whereRef('revocation.subscription_id', '=', 'subscription.id')
                            .where('revocation.kind', '=', 'revokeGift')
                            .where('revocation.status', '=', 'applied')
                            .where(sql<boolean>`revocation.preview->>'targetId'=period.id::text`),
                    ),
                ),
            )
            .where((expression) =>
                expression.or([
                    expression('period.ends_at', '>', new Date()),
                    expression('grace.ends_at', '>', new Date()),
                ]),
            )
            .execute();
        const normalize = (value: string): PlanCode | null =>
            value === 'plus' || value === 'pro' ? value : value === 'free' ? 'free' : null;
        return [
            ...personal.flatMap((row): Candidate[] => {
                const plan = normalize(row.plan);
                if (!plan) return [];
                return [
                    {
                        plan,
                        source: row.grantKind === 'trial' ? 'trial' : row.grantKind === 'gift' ? 'gift' : 'personal',
                        subscriptionId: row.subscriptionId,
                        familyId: null,
                        periodEndsAt: new Date(row.periodEndsAt),
                        graceEndsAt: row.graceEndsAt ? new Date(row.graceEndsAt) : null,
                    },
                ];
            }),
            ...family.flatMap((row): Candidate[] => {
                const plan = normalize(row.plan);
                return plan
                    ? [
                          {
                              plan,
                              source: 'family',
                              subscriptionId: row.subscriptionId,
                              familyId: row.familyId,
                              periodEndsAt: new Date(row.periodEndsAt),
                              graceEndsAt: row.graceEndsAt ? new Date(row.graceEndsAt) : null,
                          },
                      ]
                    : [];
            }),
        ];
    }

    async resolve(userId: string, db?: Db) {
        const rows = await this.candidates(db ?? (await this.db()), userId);
        rows.sort((left, right) => rank[right.plan] - rank[left.plan] || +right.periodEndsAt - +left.periodEndsAt);
        return this.result(rows[0]);
    }

    async resolvePersonal(userId: string, db: Db) {
        const rows = (await this.candidates(db, userId)).filter((candidate) => candidate.source !== 'family');
        rows.sort((left, right) => rank[right.plan] - rank[left.plan] || +right.periodEndsAt - +left.periodEndsAt);
        return this.result(rows[0]);
    }

    async resolveFamily(userId: string, familyId: string, db: Db) {
        const rows = (await this.candidates(db, userId)).filter(
            (candidate) => candidate.source === 'family' && candidate.familyId === familyId,
        );
        rows.sort((left, right) => rank[right.plan] - rank[left.plan] || +right.periodEndsAt - +left.periodEndsAt);
        return this.result(rows[0]);
    }
}
