import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { proAccessSchema, type ProAccess } from './pro-overview.contracts.js';

type Executor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

@Injectable()
export class ProAccessService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
    ) {}

    private async db(): Promise<Kysely<DatabaseSchema>> {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    async resolve(userId: string, executor?: Executor): Promise<ProAccess> {
        const db = executor ?? (await this.db());
        const entitlement = await this.entitlements.resolve(userId, db);
        if (entitlement.plan === 'pro') {
            return proAccessSchema.parse({
                mode: 'active',
                reason: null,
                source: entitlement.source,
                periodEndsAt: entitlement.periodEndsAt,
            });
        }
        const history = await sql<{ historical: boolean; endsAt: Date | null }>`
            select
                (
                    exists(select 1 from meal.nutrition_profiles where user_id=${userId}::uuid)
                    or exists(select 1 from meal.diary_entries where owner_id=${userId}::uuid)
                    or exists(
                        select 1 from meal.expenses expense
                        join meal.data_scopes scope on scope.id=expense.scope_id
                        where scope.kind='private' and scope.user_id=${userId}::uuid
                    )
                    or exists(
                        select 1 from meal.budgets budget
                        join meal.data_scopes scope on scope.id=budget.scope_id
                        where scope.kind='private' and scope.user_id=${userId}::uuid
                    )
                    or exists(
                        select 1 from meal.price_observations observation
                        join meal.data_scopes scope on scope.id=observation.scope_id
                        where scope.kind='private' and scope.user_id=${userId}::uuid
                    )
                    or exists(
                        select 1 from meal.subscriptions subscription
                        join meal.billing_products product on product.id=subscription.product_id and product.code='pro'
                        join meal.subscription_periods period on period.subscription_id=subscription.id
                        where subscription.owner_id=${userId}::uuid
                    )
                    or exists(
                        select 1 from meal.family_memberships membership
                        join meal.family_coverages coverage on coverage.family_id=membership.family_id
                        join meal.subscriptions subscription on subscription.id=coverage.subscription_id
                        join meal.billing_products product on product.id=subscription.product_id and product.code='pro'
                        join meal.subscription_periods period on period.subscription_id=subscription.id
                        where membership.user_id=${userId}::uuid
                          and membership.joined_at<coalesce(coverage.ends_at,period.ends_at)
                          and (membership.left_at is null or membership.left_at>coverage.starts_at)
                    )
                ) as historical,
                (
                    select max(history.ends_at)
                    from (
                        select period.ends_at
                        from meal.subscriptions subscription
                        join meal.billing_products product on product.id=subscription.product_id and product.code='pro'
                        join meal.subscription_periods period on period.subscription_id=subscription.id
                        where subscription.owner_id=${userId}::uuid
                        union all
                        select least(period.ends_at,coalesce(coverage.ends_at,period.ends_at))
                        from meal.family_memberships membership
                        join meal.family_coverages coverage on coverage.family_id=membership.family_id
                        join meal.subscriptions subscription on subscription.id=coverage.subscription_id
                        join meal.billing_products product on product.id=subscription.product_id and product.code='pro'
                        join meal.subscription_periods period on period.subscription_id=subscription.id
                        where membership.user_id=${userId}::uuid
                          and membership.joined_at<coalesce(coverage.ends_at,period.ends_at)
                          and (membership.left_at is null or membership.left_at>coverage.starts_at)
                    ) history
                ) as "endsAt"
        `.execute(db);
        if (!history.rows[0]?.historical) throw new HttpException('Pro access required', 403);
        return {
            mode: 'read_only',
            reason: 'pro_expired',
            source: 'history',
            periodEndsAt: history.rows[0].endsAt ? new Date(history.rows[0].endsAt).toISOString() : null,
        };
    }

    async requireActive(userId: string, executor?: Executor): Promise<ProAccess> {
        const access = await this.resolve(userId, executor);
        if (access.mode !== 'active') throw new HttpException('Pro access is read-only', 403);
        return access;
    }
}
