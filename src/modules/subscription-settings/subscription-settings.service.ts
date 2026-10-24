import { ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { Principal } from '../auth/auth.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import {
    combinationConsentResultSchema,
    combinationConsentSchema,
    combinationPreviewRequestSchema,
    combinationPreviewSchema,
    downgradePreviewRequestSchema,
    downgradePreviewSchema,
    planChangePreviewSchema,
    planPreviewRequestSchema,
    plusPreviewRequestSchema,
    previewCommitSchema,
    renewalPreviewRequestSchema,
    renewalPreviewSchema,
    subscriptionPreviewSchema,
    subscriptionSettingsSchema,
    versionedCommandSchema,
} from './subscription-settings.contracts.js';
import {
    addMoscowMonths,
    combinedProEndsAt,
    quoteSubscriptionChange,
    SUBSCRIPTION_ALLOWANCE,
    SUBSCRIPTION_PRICES,
    type PaidPlan,
} from './subscription-lifecycle.policy.js';

type Db = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;
type Tx = Transaction<DatabaseSchema>;
type TrialReason = 'already_used' | 'family_history' | 'active_subscription' | 'account_inactive' | null;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const prices = SUBSCRIPTION_PRICES.plus;
const DURABLE_EXPIRY = new Date('9999-12-31T23:59:59.999Z');

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
@Injectable()
export class SubscriptionSettingsService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
    ) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    async get(userId: string) {
        return this.project(await this.db(), userId);
    }

    private async trialReason(db: Db, userId: string, activeSubscription: boolean, accountActive: boolean) {
        if (!accountActive) return 'account_inactive' satisfies TrialReason;
        const claimed = await db
            .selectFrom('trial_claims')
            .select('id')
            .where('user_id', '=', userId)
            .executeTakeFirst();
        if (claimed) return 'already_used' satisfies TrialReason;
        const familyHistory = await db
            .selectFrom('family_memberships')
            .select('id')
            .where('user_id', '=', userId)
            .executeTakeFirst();
        if (familyHistory) return 'family_history' satisfies TrialReason;
        if (activeSubscription) return 'active_subscription' satisfies TrialReason;
        return null;
    }

    private async project(db: Db, userId: string) {
        const user = await db
            .selectFrom('users')
            .select(['version', 'status', 'archived_at'])
            .where('id', '=', userId)
            .executeTakeFirstOrThrow();
        const entitlement = await this.entitlements.resolve(userId, db);
        const period = entitlement.subscriptionId
            ? await db
                  .selectFrom('subscription_periods as period')
                  .innerJoin('subscriptions as subscription', 'subscription.id', 'period.subscription_id')
                  .select([
                      'period.starts_at as startsAt',
                      'period.ends_at as endsAt',
                      'period.price_snapshot as priceSnapshot',
                      'subscription.auto_renew as autoRenew',
                  ])
                  .where('period.subscription_id', '=', entitlement.subscriptionId)
                  .where('period.starts_at', '<=', new Date())
                  .where('period.ends_at', '>', new Date())
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
                  .orderBy('period.starts_at', 'desc')
                  .executeTakeFirst()
            : undefined;
        const scheduled = entitlement.subscriptionId
            ? await db
                  .selectFrom('subscription_changes')
                  .select(['kind', 'scheduled_at as scheduledAt'])
                  .where('subscription_id', '=', entitlement.subscriptionId)
                  .where('kind', 'in', ['upgrade_to_pro', 'downgrade_to_plus', 'downgrade_to_free'])
                  .where('status', '=', 'scheduled')
                  .orderBy('created_at', 'desc')
                  .executeTakeFirst()
            : undefined;
        const promotion = await db
            .selectFrom('promotion_offers')
            .select(['id', 'code', 'expires_at as expiresAt'])
            .where('user_id', '=', userId)
            .where('code', '=', 'post_trial_pro_10')
            .where('starts_at', '<=', new Date())
            .where('expires_at', '>', new Date())
            .where('redeemed_at', 'is', null)
            .orderBy('expires_at', 'asc')
            .executeTakeFirst();
        const familyRows = (
            await sql<{
                familyId: string;
                userId: string;
                displayName: string;
                subscriptionId: string;
                endsAt: Date;
            }>`select m.family_id as "familyId",u.id as "userId",u.display_name as "displayName",s.id as "subscriptionId",max(p.ends_at) as "endsAt"
                from meal.family_memberships me
                join meal.family_memberships m on m.family_id=me.family_id and m.left_at is null
                join meal.users u on u.id=m.user_id
                join meal.subscriptions s on s.owner_id=u.id and s.status='active'
                join meal.billing_products bp on bp.id=s.product_id and bp.code='plus'
                join meal.subscription_periods p on p.subscription_id=s.id and p.starts_at<=now() and p.ends_at>now()
                where me.user_id=${userId}::uuid and me.left_at is null and u.status='active'
                group by m.family_id,u.id,u.display_name,s.id`.execute(db)
        ).rows;
        const ownPlus = familyRows.find((row) => row.userId === userId);
        const candidates = familyRows.filter((row) => row.userId !== userId);
        const pending = (
            await sql<{
                combinationId: string;
                recipientId: string;
                endsAt: Date;
                preview: unknown;
            }>`select c.id as "combinationId",c.recipient_id as "recipientId",greatest(c.source_end_1,c.source_end_2) as "endsAt",c.preview
                from meal.subscription_combinations c
                join meal.family_memberships m on m.family_id=c.family_id and m.user_id=${userId}::uuid and m.left_at is null
                where c.status='consent_pending'
                order by c.created_at desc limit 1`.execute(db)
        ).rows[0];
        const pendingPreview = pending?.preview as { requiredUserIds?: unknown } | undefined;
        const acceptedUserIds = pending
            ? (
                  await db
                      .selectFrom('combination_consents')
                      .select('user_id')
                      .where('combination_id', '=', pending.combinationId)
                      .where('revoked_at', 'is', null)
                      .execute()
              ).map((row) => row.user_id)
            : [];
        const buckets = (
            await sql<{
                id: string;
                kind: string;
                granted: number;
                balance: number;
                reserved: number;
                expiresAt: Date | null;
            }>`select b.id,b.kind,b.granted::integer,b.balance_projection::integer balance,b.reserved_projection::integer reserved,b.expires_at as "expiresAt" from meal.ai_buckets b where (b.user_id=${userId}::uuid or (b.kind='family_reserve' and exists(select 1 from meal.family_memberships m join meal.family_coverages c on c.family_id=m.family_id and c.selected_at is not null and (c.ends_at is null or c.ends_at>now()) where m.family_id=b.family_id and m.user_id=${userId}::uuid and m.left_at is null))) and (b.expires_at is null or b.expires_at>now()) and (b.kind<>'subscription' or exists(select 1 from meal.ai_quota_periods q left join meal.subscriptions s on s.id=q.subscription_id left join meal.family_coverages c on c.id=q.family_coverage_id where q.id=b.quota_period_id and ((q.subscription_id is not null and s.status='active') or (q.family_coverage_id is not null and c.selected_at is not null and (c.ends_at is null or c.ends_at>now()))))) order by b.expires_at nulls last,b.created_at,b.id`.execute(
                db,
            )
        ).rows.flatMap((row) =>
            ['subscription', 'transferred', 'family_reserve', 'purchased', 'trial'].includes(row.kind)
                ? [
                      {
                          ...row,
                          kind: row.kind as 'subscription' | 'transferred' | 'family_reserve' | 'purchased' | 'trial',
                          granted: Number(row.granted),
                          balance: Number(row.balance),
                          reserved: Number(row.reserved),
                          available: Math.max(0, Number(row.balance) - Number(row.reserved)),
                          expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
                      },
                  ]
                : [],
        );
        const total = buckets.reduce((sum, bucket) => sum + bucket.balance, 0);
        const reserved = buckets.reduce((sum, bucket) => sum + bucket.reserved, 0);
        const accountActive = user.status === 'active' && !user.archived_at;
        const reason = await this.trialReason(db, userId, entitlement.plan !== 'free', accountActive);
        const priceSnapshot = period?.priceSnapshot;
        const selectedPeriod =
            priceSnapshot &&
            typeof priceSnapshot === 'object' &&
            !Array.isArray(priceSnapshot) &&
            'period' in priceSnapshot
                ? priceSnapshot.period === 'month' || priceSnapshot.period === 'year'
                    ? priceSnapshot.period
                    : null
                : null;
        return subscriptionSettingsSchema.parse({
            version: Number(user.version),
            current: {
                plan: entitlement.plan,
                source: entitlement.source,
                subscriptionId: entitlement.subscriptionId,
                period: selectedPeriod,
                startsAt: period ? new Date(period.startsAt).toISOString() : null,
                endsAt: period ? new Date(period.endsAt).toISOString() : entitlement.periodEndsAt,
                autoRenew: period?.autoRenew ?? false,
                downgradeToFreeAt:
                    scheduled?.kind === 'downgrade_to_free' && scheduled.scheduledAt
                        ? new Date(scheduled.scheduledAt).toISOString()
                        : null,
                scheduledPlan:
                    scheduled?.kind === 'upgrade_to_pro'
                        ? 'pro'
                        : scheduled?.kind === 'downgrade_to_plus'
                          ? 'plus'
                          : scheduled?.kind === 'downgrade_to_free'
                            ? 'free'
                            : null,
            },
            ai: { buckets, total, reserved, available: Math.max(0, total - reserved) },
            trial: { eligible: reason === null, reason, durationDays: 7, aiActions: 10 },
            prices: {
                plus: {
                    month: { amountMinor: prices.month, currency: 'RUB' },
                    year: { amountMinor: prices.year, currency: 'RUB' },
                },
                pro: {
                    month: { amountMinor: SUBSCRIPTION_PRICES.pro.month, currency: 'RUB' },
                    year: { amountMinor: SUBSCRIPTION_PRICES.pro.year, currency: 'RUB' },
                },
            },
            promotion: promotion
                ? {
                      offerId: promotion.id,
                      code: 'post_trial_pro_10',
                      expiresAt: new Date(promotion.expiresAt).toISOString(),
                      monthAmountMinor: 53900,
                      yearAmountMinor: 530900,
                      nextMonthAmountMinor: SUBSCRIPTION_PRICES.pro.month,
                      nextYearAmountMinor: SUBSCRIPTION_PRICES.pro.year,
                  }
                : null,
            combination: {
                eligible: Boolean(ownPlus && candidates.length),
                reason:
                    familyRows.length === 0
                        ? 'not_in_family'
                        : !ownPlus
                          ? 'personal_plus_required'
                          : candidates.length === 0
                            ? 'second_plus_required'
                            : null,
                familyId: familyRows[0]?.familyId ?? null,
                candidates: candidates.map((row) => ({
                    userId: row.userId,
                    displayName: row.displayName,
                    subscriptionId: row.subscriptionId,
                    endsAt: new Date(row.endsAt).toISOString(),
                })),
                pending: pending
                    ? {
                          previewId:
                              pending.preview &&
                              typeof pending.preview === 'object' &&
                              !Array.isArray(pending.preview) &&
                              'previewId' in pending.preview &&
                              typeof pending.preview.previewId === 'string'
                                  ? pending.preview.previewId
                                  : pending.combinationId,
                          combinationId: pending.combinationId,
                          recipientId: pending.recipientId,
                          endsAt: new Date(pending.endsAt).toISOString(),
                          acceptedUserIds,
                          requiredUserIds: Array.isArray(pendingPreview?.requiredUserIds)
                              ? pendingPreview.requiredUserIds.filter(
                                    (value): value is string => typeof value === 'string',
                                )
                              : [],
                      }
                    : null,
            },
        });
    }

    private async lockedUser(tx: Tx, userId: string) {
        const user = await tx
            .selectFrom('users')
            .select(['id', 'version', 'status', 'archived_at'])
            .where('id', '=', userId)
            .forUpdate()
            .executeTakeFirstOrThrow();
        const banned =
            await sql`select id from meal.sanctions where user_id=${userId}::uuid and scope='account' and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                tx,
            );
        if (banned.rows.length) throw new HttpException('Доступен только просмотр', 403);
        return user;
    }

    private assertVersion(user: Awaited<ReturnType<SubscriptionSettingsService['lockedUser']>>, expected: number) {
        if (Number(user.version) !== expected) throw new ConflictException('Настройки подписки изменились');
        if (user.status !== 'active' || user.archived_at)
            throw new ConflictException('Аккаунт недоступен для изменений');
    }

    private async previous(tx: Tx, userId: string, operation: string, key: string, requestHash: string) {
        const row = await tx
            .selectFrom('idempotency_records')
            .select(['request_hash', 'response_snapshot'])
            .where('actor_namespace', '=', `user:${userId}`)
            .where('operation', '=', operation)
            .where('target_binding', '=', userId)
            .where('key', '=', key)
            .executeTakeFirst();
        if (!row) return undefined;
        if (row.request_hash !== requestHash) throw new ConflictException('Ключ идемпотентности уже использован');
        return row.response_snapshot;
    }

    private async remember(
        tx: Tx,
        userId: string,
        operation: string,
        key: string,
        requestHash: string,
        response: JsonValue,
        expiresAt: Date,
    ) {
        await tx
            .insertInto('idempotency_records')
            .values({
                id: randomUUID(),
                operation,
                target_binding: userId,
                key,
                request_hash: requestHash,
                status: 'completed',
                response_snapshot: response,
                expires_at: expiresAt,
                user_id: userId,
                scope_id: null,
                actor_namespace: `user:${userId}`,
            })
            .execute();
    }

    private async audit(tx: Tx, actorId: string, requestId: string, action: string, after: JsonValue) {
        await tx
            .insertInto('audit_events')
            .values({
                id: randomUUID(),
                action,
                target_type: 'subscription',
                target_id: actorId,
                effective_at: new Date(),
                recorded_at: new Date(),
                reason: 'user_request',
                before_redacted: null,
                after_redacted: after,
                request_id: requestId,
                actor_id: actorId,
                scope_id: null,
            })
            .execute();
    }

    async activateTrial(raw: unknown, actor: Principal, requestId: string) {
        const input = versionedCommandSchema.parse(raw);
        const requestHash = hash(input);
        return this.database.transaction(async (tx) => {
            const user = await this.lockedUser(tx, actor.id);
            const duplicate = await this.previous(
                tx,
                actor.id,
                'subscription.trial.activate',
                input.idempotencyKey,
                requestHash,
            );
            if (duplicate) return subscriptionSettingsSchema.parse(duplicate);
            this.assertVersion(user, input.expectedVersion);
            const entitlement = await this.entitlements.resolve(actor.id, tx);
            const reason = await this.trialReason(tx, actor.id, entitlement.plan !== 'free', true);
            if (reason) throw new ConflictException(`Trial недоступен: ${reason}`);
            const product = await tx
                .selectFrom('billing_products')
                .select('id')
                .where('code', '=', 'pro')
                .where('kind', '=', 'subscription')
                .executeTakeFirst();
            if (!product) throw new ServiceUnavailableException('Каталог тарифов не подготовлен');
            const startsAt = new Date();
            const endsAt = new Date(startsAt.getTime() + 7 * 24 * 60 * 60 * 1000);
            const subscriptionId = randomUUID();
            const periodId = randomUUID();
            const claimId = randomUUID();
            const quotaId = randomUUID();
            const bucketId = randomUUID();
            await tx
                .insertInto('subscriptions')
                .values({
                    id: subscriptionId,
                    status: 'active',
                    auto_renew: false,
                    billing_anchor: startsAt,
                    billing_timezone: 'Europe/Moscow',
                    owner_id: actor.id,
                    product_id: product.id,
                })
                .execute();
            await tx
                .insertInto('subscription_periods')
                .values({
                    id: periodId,
                    starts_at: startsAt,
                    ends_at: endsAt,
                    grant_kind: 'trial',
                    price_snapshot: { amountMinor: 0, currency: 'RUB', period: 'trial', paymentMode: 'none' },
                    subscription_id: subscriptionId,
                    order_id: null,
                })
                .execute();
            await tx
                .insertInto('trial_claims')
                .values({
                    id: claimId,
                    claimed_at: startsAt,
                    eligibility_evidence: {
                        priorTrial: false,
                        familyHistory: false,
                        checkedAt: startsAt.toISOString(),
                    },
                    user_id: actor.id,
                    period_id: periodId,
                })
                .execute();
            await tx
                .insertInto('ai_quota_periods')
                .values({
                    id: quotaId,
                    starts_at: startsAt,
                    ends_at: endsAt,
                    granted_actions: 10,
                    allocation_snapshot: { mode: 'trial', userId: actor.id, amount: 10 },
                    subscription_id: null,
                    family_coverage_id: null,
                    trial_claim_id: claimId,
                })
                .execute();
            await tx
                .insertInto('ai_buckets')
                .values({
                    id: bucketId,
                    kind: 'trial',
                    granted: 10,
                    balance_projection: 10,
                    reserved_projection: 0,
                    expires_at: endsAt,
                    user_id: actor.id,
                    family_id: null,
                    quota_period_id: quotaId,
                    order_id: null,
                })
                .execute();
            await tx
                .insertInto('ai_ledger')
                .values({
                    id: randomUUID(),
                    kind: 'grant',
                    delta: 10,
                    reserved_delta: 0,
                    recorded_at: startsAt,
                    idempotency_key: `trial:${claimId}`,
                    bucket_id: bucketId,
                    operation_id: null,
                    compensates_id: null,
                })
                .execute();
            await tx
                .updateTable('users')
                .set({ version: sql`version+1` })
                .where('id', '=', actor.id)
                .execute();
            const response = await this.project(tx, actor.id);
            await this.remember(
                tx,
                actor.id,
                'subscription.trial.activate',
                input.idempotencyKey,
                requestHash,
                response,
                DURABLE_EXPIRY,
            );
            await this.audit(tx, actor.id, requestId, 'subscription.trial.activated', {
                subscriptionId,
                periodId,
                claimId,
                endsAt: endsAt.toISOString(),
                aiActions: 10,
            });
            return response;
        });
    }

    async previewPlus(raw: unknown, actor: Principal) {
        const input = plusPreviewRequestSchema.parse(raw);
        const requestHash = hash(input);
        return this.database.transaction(async (tx) => {
            const user = await this.lockedUser(tx, actor.id);
            const duplicate = await this.previous(
                tx,
                actor.id,
                'subscription.plus.preview',
                input.idempotencyKey,
                requestHash,
            );
            if (duplicate) return subscriptionPreviewSchema.parse(duplicate);
            this.assertVersion(user, input.expectedVersion);
            const entitlement = await this.entitlements.resolve(actor.id, tx);
            if (entitlement.plan !== 'free') throw new ConflictException('Переход на Plus доступен только с Free');
            const startsAt = new Date();
            const endsAt = addMoscowMonths(startsAt, input.period === 'month' ? 1 : 12);
            const expiresAt = new Date(startsAt.getTime() + 15 * 60 * 1000);
            const response = subscriptionPreviewSchema.parse({
                previewId: randomUUID(),
                expectedVersion: input.expectedVersion,
                plan: 'plus',
                period: input.period,
                amountMinor: prices[input.period],
                currency: 'RUB',
                paymentMode: 'simulation',
                startsAt: startsAt.toISOString(),
                endsAt: endsAt.toISOString(),
                expiresAt: expiresAt.toISOString(),
            });
            await this.remember(
                tx,
                actor.id,
                'subscription.plus.preview',
                input.idempotencyKey,
                requestHash,
                response,
                expiresAt,
            );
            return response;
        });
    }

    private async loadPreview<T>(
        tx: Tx,
        userId: string,
        operation: string,
        previewId: string,
        parse: (raw: unknown) => T,
    ) {
        const row = (
            await sql<{
                response: unknown;
            }>`select response_snapshot as response from meal.idempotency_records where actor_namespace=${`user:${userId}`} and operation=${operation} and target_binding=${userId} and response_snapshot->>'previewId'=${previewId} and expires_at>now() order by created_at desc limit 1 for update`.execute(
                tx,
            )
        ).rows[0];
        if (!row) throw new ConflictException('Предпросмотр истёк или недоступен');
        return parse(row.response);
    }

    private async grantPlusQuota(tx: Tx, userId: string, subscriptionId: string, startsAt: Date, periodEndsAt: Date) {
        const quotaEndsAt = addMoscowMonths(startsAt, 1);
        const endsAt = quotaEndsAt < periodEndsAt ? quotaEndsAt : periodEndsAt;
        const quotaId = randomUUID();
        const bucketId = randomUUID();
        await tx
            .insertInto('ai_quota_periods')
            .values({
                id: quotaId,
                starts_at: startsAt,
                ends_at: endsAt,
                granted_actions: 40,
                allocation_snapshot: { mode: 'personal', userId, amount: 40 },
                subscription_id: subscriptionId,
                family_coverage_id: null,
                trial_claim_id: null,
            })
            .execute();
        await tx
            .insertInto('ai_buckets')
            .values({
                id: bucketId,
                kind: 'subscription',
                granted: 40,
                balance_projection: 40,
                reserved_projection: 0,
                expires_at: endsAt,
                user_id: userId,
                family_id: null,
                quota_period_id: quotaId,
                order_id: null,
            })
            .execute();
        await tx
            .insertInto('ai_ledger')
            .values({
                id: randomUUID(),
                kind: 'grant',
                delta: 40,
                reserved_delta: 0,
                recorded_at: startsAt,
                idempotency_key: `quota:${quotaId}:${userId}`,
                bucket_id: bucketId,
                operation_id: null,
                compensates_id: null,
            })
            .execute();
    }

    async commitPlus(raw: unknown, actor: Principal, requestId: string) {
        const input = previewCommitSchema.parse(raw);
        const requestHash = hash(input);
        return this.database.transaction(async (tx) => {
            const user = await this.lockedUser(tx, actor.id);
            const duplicate = await this.previous(
                tx,
                actor.id,
                'subscription.plus.commit',
                input.idempotencyKey,
                requestHash,
            );
            if (duplicate) return subscriptionSettingsSchema.parse(duplicate);
            this.assertVersion(user, input.expectedVersion);
            const preview = await this.loadPreview(
                tx,
                actor.id,
                'subscription.plus.preview',
                input.previewId,
                (value) => subscriptionPreviewSchema.parse(value),
            );
            if (preview.expectedVersion !== input.expectedVersion)
                throw new ConflictException('Состояние изменилось после предпросмотра');
            const entitlement = await this.entitlements.resolve(actor.id, tx);
            if (entitlement.plan !== 'free') throw new ConflictException('Переход на Plus доступен только с Free');
            const product = await tx
                .selectFrom('billing_products')
                .select('id')
                .where('code', '=', 'plus')
                .where('kind', '=', 'subscription')
                .executeTakeFirst();
            if (!product) throw new ServiceUnavailableException('Каталог тарифов не подготовлен');
            const startsAt = new Date(preview.startsAt);
            const endsAt = new Date(preview.endsAt);
            const subscriptionId = randomUUID();
            const periodId = randomUUID();
            await tx
                .insertInto('subscriptions')
                .values({
                    id: subscriptionId,
                    status: 'active',
                    auto_renew: false,
                    billing_anchor: startsAt,
                    billing_timezone: 'Europe/Moscow',
                    owner_id: actor.id,
                    product_id: product.id,
                })
                .execute();
            await tx
                .insertInto('subscription_periods')
                .values({
                    id: periodId,
                    starts_at: startsAt,
                    ends_at: endsAt,
                    grant_kind: 'simulation',
                    price_snapshot: {
                        amountMinor: preview.amountMinor,
                        currency: preview.currency,
                        period: preview.period,
                        paymentMode: preview.paymentMode,
                        previewId: preview.previewId,
                    },
                    subscription_id: subscriptionId,
                    order_id: null,
                })
                .execute();
            await tx
                .insertInto('subscription_changes')
                .values({
                    id: randomUUID(),
                    kind: 'upgrade_to_plus',
                    status: 'applied',
                    preview,
                    scheduled_at: startsAt,
                    applied_at: new Date(),
                    reason: 'simulation_payment',
                    subscription_id: subscriptionId,
                    actor_id: actor.id,
                })
                .execute();
            await this.grantPlusQuota(tx, actor.id, subscriptionId, startsAt, endsAt);
            await tx
                .updateTable('users')
                .set({ version: sql`version+1` })
                .where('id', '=', actor.id)
                .execute();
            const response = await this.project(tx, actor.id);
            await this.remember(
                tx,
                actor.id,
                'subscription.plus.commit',
                input.idempotencyKey,
                requestHash,
                response,
                DURABLE_EXPIRY,
            );
            await this.audit(tx, actor.id, requestId, 'subscription.plus.simulated', {
                subscriptionId,
                periodId,
                previewId: preview.previewId,
                amountMinor: preview.amountMinor,
                currency: preview.currency,
                period: preview.period,
                endsAt: preview.endsAt,
            });
            return response;
        });
    }

    private async personalPeriod(tx: Tx, userId: string) {
        return tx
            .selectFrom('subscriptions as subscription')
            .innerJoin('billing_products as product', 'product.id', 'subscription.product_id')
            .innerJoin('subscription_periods as period', 'period.subscription_id', 'subscription.id')
            .select([
                'subscription.id as subscriptionId',
                'subscription.version as subscriptionVersion',
                'subscription.auto_renew as autoRenew',
                'product.code as plan',
                'period.starts_at as startsAt',
                'period.ends_at as endsAt',
                'period.price_snapshot as priceSnapshot',
            ])
            .where('subscription.owner_id', '=', userId)
            .where('subscription.status', '=', 'active')
            .where('period.starts_at', '<=', new Date())
            .where('period.ends_at', '>', new Date())
            .orderBy('period.starts_at', 'desc')
            .forUpdate('subscription')
            .executeTakeFirst();
    }

    private priceSnapshot(value: unknown) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return { amount: null, period: null };
        const record = value as Record<string, unknown>;
        return {
            amount: typeof record.amountMinor === 'number' ? record.amountMinor : null,
            period: record.period === 'month' || record.period === 'year' ? record.period : null,
        } as const;
    }

    async previewPlan(raw: unknown, actor: Principal) {
        const input = planPreviewRequestSchema.parse(raw);
        const requestHash = hash(input);
        return this.database.transaction(async (tx) => {
            const user = await this.lockedUser(tx, actor.id);
            const duplicate = await this.previous(
                tx,
                actor.id,
                'subscription.plan.preview',
                input.idempotencyKey,
                requestHash,
            );
            if (duplicate) return planChangePreviewSchema.parse(duplicate);
            this.assertVersion(user, input.expectedVersion);
            const entitlement = await this.entitlements.resolvePersonal(actor.id, tx);
            const currentPlan = entitlement.plan;
            if (!(
                (currentPlan === 'free' && ['plus', 'pro'].includes(input.targetPlan)) ||
                (currentPlan === 'plus' && input.targetPlan === 'pro')
            ))
                throw new ConflictException('Выбранный переход тарифа недоступен');
            if (currentPlan === 'free' && input.timing !== 'now')
                throw new ConflictException('Новую подписку можно начать только сейчас');
            const current = currentPlan === 'plus' ? await this.personalPeriod(tx, actor.id) : undefined;
            if (currentPlan === 'plus' && (!current || current.plan !== 'plus'))
                throw new ConflictException('Личная подписка Plus не найдена');
            let promotionAmountMinor: number | null = null;
            if (input.promotionOfferId) {
                if (currentPlan !== 'free' || input.targetPlan !== 'pro' || input.timing !== 'now')
                    throw new ConflictException('Акция применима только к первой покупке Pro');
                const offer = await tx
                    .selectFrom('promotion_offers')
                    .select('id')
                    .where('id', '=', input.promotionOfferId)
                    .where('user_id', '=', actor.id)
                    .where('code', '=', 'post_trial_pro_10')
                    .where('starts_at', '<=', new Date())
                    .where('expires_at', '>', new Date())
                    .where('redeemed_at', 'is', null)
                    .forUpdate()
                    .executeTakeFirst();
                if (!offer) throw new ConflictException('Промопредложение истекло или уже использовано');
                promotionAmountMinor = input.period === 'month' ? 53900 : 530900;
            }
            const snapshot = this.priceSnapshot(current?.priceSnapshot);
            const now = new Date();
            const quote = quoteSubscriptionChange({
                currentPlan: currentPlan === 'plus' ? 'plus' : 'free',
                currentAmountMinor: snapshot.amount,
                currentStartsAt: current ? new Date(current.startsAt) : null,
                currentEndsAt: current ? new Date(current.endsAt) : null,
                targetPlan: input.targetPlan,
                period: input.period,
                timing: input.timing,
                now,
                promotionAmountMinor,
            });
            const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
            const response = planChangePreviewSchema.parse({
                previewId: randomUUID(),
                expectedVersion: input.expectedVersion,
                operation:
                    currentPlan === 'free' ? 'purchase' : input.timing === 'now' ? 'upgrade' : 'scheduled_upgrade',
                currentPlan,
                targetPlan: input.targetPlan,
                period: input.period,
                timing: input.timing,
                ...quote,
                currency: 'RUB',
                paymentMode: 'simulation',
                promotionOfferId: input.promotionOfferId,
                startsAt: quote.startsAt.toISOString(),
                endsAt: quote.endsAt.toISOString(),
                nextChargeAt: quote.nextChargeAt.toISOString(),
                expiresAt: expiresAt.toISOString(),
            });
            await this.remember(
                tx,
                actor.id,
                'subscription.plan.preview',
                input.idempotencyKey,
                requestHash,
                response,
                expiresAt,
            );
            return response;
        });
    }

    private async grantQuota(
        tx: Tx,
        userId: string,
        subscriptionId: string,
        startsAt: Date,
        periodEndsAt: Date,
        plan: PaidPlan,
    ) {
        const quotaEndsAt = addMoscowMonths(startsAt, 1);
        const endsAt = quotaEndsAt < periodEndsAt ? quotaEndsAt : periodEndsAt;
        const quotaId = randomUUID();
        const bucketId = randomUUID();
        const amount = SUBSCRIPTION_ALLOWANCE[plan];
        await tx
            .insertInto('ai_quota_periods')
            .values({
                id: quotaId,
                starts_at: startsAt,
                ends_at: endsAt,
                granted_actions: amount,
                allocation_snapshot: { mode: 'personal', plan, userId, amount },
                subscription_id: subscriptionId,
                family_coverage_id: null,
                trial_claim_id: null,
            })
            .execute();
        await tx
            .insertInto('ai_buckets')
            .values({
                id: bucketId,
                kind: 'subscription',
                granted: amount,
                balance_projection: amount,
                reserved_projection: 0,
                expires_at: endsAt,
                user_id: userId,
                family_id: null,
                quota_period_id: quotaId,
                order_id: null,
            })
            .execute();
        await tx
            .insertInto('ai_ledger')
            .values({
                id: randomUUID(),
                kind: 'grant',
                delta: amount,
                reserved_delta: 0,
                recorded_at: startsAt,
                idempotency_key: `quota:${quotaId}:${userId}`,
                bucket_id: bucketId,
                operation_id: null,
                compensates_id: null,
            })
            .execute();
    }

    async commitPlan(raw: unknown, actor: Principal, requestId: string) {
        const input = previewCommitSchema.parse(raw);
        const requestHash = hash(input);
        return this.database.transaction(async (tx) => {
            const user = await this.lockedUser(tx, actor.id);
            const duplicate = await this.previous(
                tx,
                actor.id,
                'subscription.plan.commit',
                input.idempotencyKey,
                requestHash,
            );
            if (duplicate) return subscriptionSettingsSchema.parse(duplicate);
            this.assertVersion(user, input.expectedVersion);
            const preview = await this.loadPreview(
                tx,
                actor.id,
                'subscription.plan.preview',
                input.previewId,
                (value) => planChangePreviewSchema.parse(value),
            );
            if (preview.expectedVersion !== input.expectedVersion)
                throw new ConflictException('Состояние изменилось после предпросмотра');
            const current = await this.entitlements.resolvePersonal(actor.id, tx);
            if (current.plan !== preview.currentPlan)
                throw new ConflictException('Тариф изменился после предпросмотра');
            const active = current.plan === 'plus' ? await this.personalPeriod(tx, actor.id) : undefined;
            if (preview.operation === 'scheduled_upgrade') {
                if (
                    !active ||
                    active.subscriptionId !== current.subscriptionId ||
                    preview.startsAt !== current.periodEndsAt
                )
                    throw new ConflictException('Подписка изменилась после предпросмотра');
                await tx
                    .updateTable('subscriptions')
                    .set({ auto_renew: false, version: sql`version+1` })
                    .where('id', '=', active.subscriptionId)
                    .execute();
                const product = await tx
                    .selectFrom('billing_products')
                    .select('id')
                    .where('code', '=', 'pro')
                    .where('kind', '=', 'subscription')
                    .executeTakeFirst();
                if (!product) throw new ServiceUnavailableException('Каталог тарифов не подготовлен');
                const futureSubscriptionId = randomUUID();
                await tx
                    .insertInto('subscriptions')
                    .values({
                        id: futureSubscriptionId,
                        status: 'active',
                        auto_renew: true,
                        billing_anchor: new Date(preview.startsAt),
                        billing_timezone: 'Europe/Moscow',
                        owner_id: actor.id,
                        product_id: product.id,
                    })
                    .execute();
                await tx
                    .insertInto('subscription_periods')
                    .values({
                        id: randomUUID(),
                        starts_at: new Date(preview.startsAt),
                        ends_at: new Date(preview.endsAt),
                        grant_kind: 'simulation',
                        price_snapshot: {
                            amountMinor: preview.amountMinor,
                            currency: 'RUB',
                            period: preview.period,
                            paymentMode: 'simulation',
                            previewId: preview.previewId,
                        },
                        subscription_id: futureSubscriptionId,
                        order_id: null,
                    })
                    .execute();
                const coverage = await tx
                    .selectFrom('family_coverages')
                    .select('family_id as familyId')
                    .where('subscription_id', '=', active.subscriptionId)
                    .where('selected_at', 'is not', null)
                    .where('ends_at', 'is', null)
                    .executeTakeFirst();
                if (coverage) {
                    await tx
                        .updateTable('family_coverages')
                        .set({ ends_at: new Date(preview.startsAt), version: sql`version+1` })
                        .where('family_id', '=', coverage.familyId)
                        .where('selected_at', 'is not', null)
                        .where('ends_at', 'is', null)
                        .execute();
                    await tx
                        .insertInto('family_coverages')
                        .values({
                            id: randomUUID(),
                            reason: 'owner_subscription',
                            starts_at: new Date(preview.startsAt),
                            ends_at: null,
                            selected_at: new Date(),
                            family_id: coverage.familyId,
                            subscription_id: futureSubscriptionId,
                            combination_id: null,
                        })
                        .execute();
                }
                await tx
                    .insertInto('subscription_changes')
                    .values({
                        id: randomUUID(),
                        kind: 'upgrade_to_pro',
                        status: 'scheduled',
                        preview,
                        scheduled_at: new Date(preview.startsAt),
                        applied_at: null,
                        reason: 'user_request',
                        subscription_id: active.subscriptionId,
                        actor_id: actor.id,
                    })
                    .execute();
            } else {
                const product = await tx
                    .selectFrom('billing_products')
                    .select('id')
                    .where('code', '=', preview.targetPlan)
                    .where('kind', '=', 'subscription')
                    .executeTakeFirst();
                if (!product) throw new ServiceUnavailableException('Каталог тарифов не подготовлен');
                const replacedCoverage = active
                    ? await tx
                          .selectFrom('family_coverages')
                          .select('family_id as familyId')
                          .where('subscription_id', '=', active.subscriptionId)
                          .where('selected_at', 'is not', null)
                          .where('ends_at', 'is', null)
                          .executeTakeFirst()
                    : undefined;
                if (active)
                    await tx
                        .updateTable('subscriptions')
                        .set({ status: 'replaced', auto_renew: false, version: sql`version+1` })
                        .where('id', '=', active.subscriptionId)
                        .execute();
                const subscriptionId = randomUUID();
                const startsAt = new Date(preview.startsAt);
                const endsAt = new Date(preview.endsAt);
                await tx
                    .insertInto('subscriptions')
                    .values({
                        id: subscriptionId,
                        status: 'active',
                        auto_renew: true,
                        billing_anchor: startsAt,
                        billing_timezone: 'Europe/Moscow',
                        owner_id: actor.id,
                        product_id: product.id,
                    })
                    .execute();
                await tx
                    .insertInto('subscription_periods')
                    .values({
                        id: randomUUID(),
                        starts_at: startsAt,
                        ends_at: endsAt,
                        grant_kind: 'simulation',
                        price_snapshot: {
                            amountMinor: preview.amountMinor,
                            fullAmountMinor: preview.fullAmountMinor,
                            creditMinor: preview.creditMinor,
                            currency: 'RUB',
                            period: preview.period,
                            paymentMode: 'simulation',
                            previewId: preview.previewId,
                        },
                        subscription_id: subscriptionId,
                        order_id: null,
                    })
                    .execute();
                if (replacedCoverage) {
                    await tx
                        .updateTable('family_coverages')
                        .set({ ends_at: startsAt, version: sql`version+1` })
                        .where('family_id', '=', replacedCoverage.familyId)
                        .where('selected_at', 'is not', null)
                        .where('ends_at', 'is', null)
                        .execute();
                    await tx
                        .insertInto('family_coverages')
                        .values({
                            id: randomUUID(),
                            reason: 'owner_subscription',
                            starts_at: startsAt,
                            ends_at: null,
                            selected_at: startsAt,
                            family_id: replacedCoverage.familyId,
                            subscription_id: subscriptionId,
                            combination_id: null,
                        })
                        .execute();
                }
                await tx
                    .insertInto('subscription_changes')
                    .values({
                        id: randomUUID(),
                        kind: preview.targetPlan === 'pro' ? 'upgrade_to_pro' : 'upgrade_to_plus',
                        status: 'applied',
                        preview,
                        scheduled_at: startsAt,
                        applied_at: new Date(),
                        reason: 'simulation_payment',
                        subscription_id: subscriptionId,
                        actor_id: actor.id,
                    })
                    .execute();
                await this.grantQuota(tx, actor.id, subscriptionId, startsAt, endsAt, preview.targetPlan);
                if (preview.promotionOfferId)
                    await tx
                        .updateTable('promotion_offers')
                        .set({ redeemed_at: new Date(), version: sql`version+1` })
                        .where('id', '=', preview.promotionOfferId)
                        .where('redeemed_at', 'is', null)
                        .executeTakeFirstOrThrow();
            }
            await tx
                .updateTable('users')
                .set({ version: sql`version+1` })
                .where('id', '=', actor.id)
                .execute();
            const response = await this.project(tx, actor.id);
            await this.remember(
                tx,
                actor.id,
                'subscription.plan.commit',
                input.idempotencyKey,
                requestHash,
                response,
                DURABLE_EXPIRY,
            );
            await this.audit(tx, actor.id, requestId, 'subscription.plan.changed', preview);
            return response;
        });
    }

    async previewRenewal(raw: unknown, actor: Principal) {
        const input = renewalPreviewRequestSchema.parse(raw);
        const requestHash = hash(input);
        return this.database.transaction(async (tx) => {
            const user = await this.lockedUser(tx, actor.id);
            const duplicate = await this.previous(
                tx,
                actor.id,
                'subscription.renewal.preview',
                input.idempotencyKey,
                requestHash,
            );
            if (duplicate) return renewalPreviewSchema.parse(duplicate);
            this.assertVersion(user, input.expectedVersion);
            const current = await this.personalPeriod(tx, actor.id);
            if (!current || (current.plan !== 'plus' && current.plan !== 'pro'))
                throw new ConflictException('Активная личная подписка не найдена');
            const snapshot = this.priceSnapshot(current.priceSnapshot);
            if (!snapshot.period) throw new ConflictException('Период подписки не определён');
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
            const response = renewalPreviewSchema.parse({
                previewId: randomUUID(),
                expectedVersion: input.expectedVersion,
                subscriptionId: current.subscriptionId,
                plan: current.plan,
                enabled: input.enabled,
                nextChargeAt: new Date(current.endsAt).toISOString(),
                nextAmountMinor: SUBSCRIPTION_PRICES[current.plan][snapshot.period],
                currency: 'RUB',
                paymentMode: 'simulation',
                expiresAt: expiresAt.toISOString(),
            });
            await this.remember(
                tx,
                actor.id,
                'subscription.renewal.preview',
                input.idempotencyKey,
                requestHash,
                response,
                expiresAt,
            );
            return response;
        });
    }

    async commitRenewal(raw: unknown, actor: Principal, requestId: string) {
        const input = previewCommitSchema.parse(raw);
        const requestHash = hash(input);
        return this.database.transaction(async (tx) => {
            const user = await this.lockedUser(tx, actor.id);
            const duplicate = await this.previous(
                tx,
                actor.id,
                'subscription.renewal.commit',
                input.idempotencyKey,
                requestHash,
            );
            if (duplicate) return subscriptionSettingsSchema.parse(duplicate);
            this.assertVersion(user, input.expectedVersion);
            const preview = await this.loadPreview(
                tx,
                actor.id,
                'subscription.renewal.preview',
                input.previewId,
                (value) => renewalPreviewSchema.parse(value),
            );
            const current = await this.personalPeriod(tx, actor.id);
            if (
                !current ||
                current.subscriptionId !== preview.subscriptionId ||
                current.plan !== preview.plan ||
                new Date(current.endsAt).toISOString() !== preview.nextChargeAt
            )
                throw new ConflictException('Подписка изменилась после предпросмотра');
            await tx
                .updateTable('subscriptions')
                .set({ auto_renew: preview.enabled, version: sql`version+1` })
                .where('id', '=', current.subscriptionId)
                .execute();
            await tx
                .insertInto('subscription_changes')
                .values({
                    id: randomUUID(),
                    kind: preview.enabled ? 'renewal_enabled' : 'renewal_disabled',
                    status: 'applied',
                    preview,
                    scheduled_at: new Date(preview.nextChargeAt),
                    applied_at: new Date(),
                    reason: 'user_request',
                    subscription_id: current.subscriptionId,
                    actor_id: actor.id,
                })
                .execute();
            await tx
                .updateTable('users')
                .set({ version: sql`version+1` })
                .where('id', '=', actor.id)
                .execute();
            const response = await this.project(tx, actor.id);
            await this.remember(
                tx,
                actor.id,
                'subscription.renewal.commit',
                input.idempotencyKey,
                requestHash,
                response,
                DURABLE_EXPIRY,
            );
            await this.audit(tx, actor.id, requestId, 'subscription.renewal.changed', preview);
            return response;
        });
    }

    private async combinationSource(tx: Tx, userId: string, familyId?: string) {
        return (
            await sql<{
                familyId: string;
                userId: string;
                subscriptionId: string;
                endsAt: Date;
            }>`select m.family_id as "familyId",m.user_id as "userId",s.id as "subscriptionId",max(p.ends_at) as "endsAt"
                from meal.family_memberships m
                join meal.subscriptions s on s.owner_id=m.user_id and s.status='active'
                join meal.billing_products bp on bp.id=s.product_id and bp.code='plus'
                join meal.subscription_periods p on p.subscription_id=s.id and p.starts_at<=now() and p.ends_at>now()
                where m.user_id=${userId}::uuid and m.left_at is null
                ${familyId ? sql`and m.family_id=${familyId}::uuid` : sql``}
                group by m.family_id,m.user_id,s.id
                order by max(p.ends_at) desc limit 1`.execute(tx)
        ).rows[0];
    }

    async previewCombination(raw: unknown, actor: Principal) {
        const input = combinationPreviewRequestSchema.parse(raw);
        const requestHash = hash(input);
        return this.database.transaction(async (tx) => {
            const user = await this.lockedUser(tx, actor.id);
            const duplicate = await this.previous(
                tx,
                actor.id,
                'subscription.combination.preview',
                input.idempotencyKey,
                requestHash,
            );
            if (duplicate) return combinationPreviewSchema.parse(duplicate);
            this.assertVersion(user, input.expectedVersion);
            if (input.peerUserId === actor.id || ![actor.id, input.peerUserId].includes(input.recipientId))
                throw new ConflictException('Участники или получатель объединения выбраны неверно');
            const first = await this.combinationSource(tx, actor.id);
            const second = first ? await this.combinationSource(tx, input.peerUserId, first.familyId) : undefined;
            if (!first || !second) throw new ConflictException('Нужны две личные Plus в одной семье');
            const consumed = await tx
                .selectFrom('subscription_combinations')
                .select('id')
                .where((expression) =>
                    expression.or([
                        expression('first_subscription_id', 'in', [first.subscriptionId, second.subscriptionId]),
                        expression('second_subscription_id', 'in', [first.subscriptionId, second.subscriptionId]),
                    ]),
                )
                .where('status', 'in', ['consent_pending', 'applied'])
                .executeTakeFirst();
            if (consumed) throw new ConflictException('Одна из подписок уже участвует в объединении');
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            const combinationId = randomUUID();
            const previewId = randomUUID();
            const resultEndsAt = combinedProEndsAt(new Date(first.endsAt), new Date(second.endsAt));
            const requiredUserIds = [actor.id, input.peerUserId].sort();
            const response = combinationPreviewSchema.parse({
                previewId,
                combinationId,
                expectedVersion: input.expectedVersion,
                familyId: first.familyId,
                firstUserId: actor.id,
                secondUserId: input.peerUserId,
                recipientId: input.recipientId,
                firstSubscriptionId: first.subscriptionId,
                secondSubscriptionId: second.subscriptionId,
                firstEndsAt: new Date(first.endsAt).toISOString(),
                secondEndsAt: new Date(second.endsAt).toISOString(),
                resultEndsAt: resultEndsAt.toISOString(),
                amountMinor: 0,
                currency: 'RUB',
                requiredUserIds,
                expiresAt: expiresAt.toISOString(),
            });
            await tx
                .insertInto('subscription_combinations')
                .values({
                    id: combinationId,
                    status: 'consent_pending',
                    preview: response,
                    applied_at: null,
                    source_end_1: new Date(first.endsAt),
                    source_end_2: new Date(second.endsAt),
                    family_id: first.familyId,
                    first_subscription_id: first.subscriptionId,
                    second_subscription_id: second.subscriptionId,
                    result_subscription_id: null,
                    recipient_id: input.recipientId,
                })
                .execute();
            await this.remember(
                tx,
                actor.id,
                'subscription.combination.preview',
                input.idempotencyKey,
                requestHash,
                response,
                expiresAt,
            );
            return response;
        });
    }

    async consentCombination(raw: unknown, actor: Principal, requestId: string) {
        const input = combinationConsentSchema.parse(raw);
        const requestHash = hash(input);
        return this.database.transaction(async (tx) => {
            const user = await this.lockedUser(tx, actor.id);
            const duplicate = await this.previous(
                tx,
                actor.id,
                'subscription.combination.consent',
                input.idempotencyKey,
                requestHash,
            );
            if (duplicate) return combinationConsentResultSchema.parse(duplicate);
            this.assertVersion(user, input.expectedVersion);
            const combination = await tx
                .selectFrom('subscription_combinations')
                .selectAll()
                .where('id', '=', input.combinationId)
                .forUpdate()
                .executeTakeFirst();
            if (!combination || (combination.status !== 'consent_pending' && combination.status !== 'applied'))
                throw new ConflictException('Объединение недоступно');
            const preview = combinationPreviewSchema.parse(combination.preview);
            if (preview.previewId !== input.previewId || new Date(preview.expiresAt) <= new Date())
                throw new ConflictException('Предпросмотр объединения истёк');
            if (!preview.requiredUserIds.includes(actor.id))
                throw new ConflictException('Согласие этого пользователя не требуется');
            const activeMember = await tx
                .selectFrom('family_memberships')
                .select('id')
                .where('family_id', '=', preview.familyId)
                .where('user_id', '=', actor.id)
                .where('left_at', 'is', null)
                .executeTakeFirst();
            if (!activeMember) throw new ConflictException('Пользователь больше не состоит в семье');
            const previewHash = hash(preview);
            const priorConsent = await tx
                .selectFrom('combination_consents')
                .select('id')
                .where('combination_id', '=', combination.id)
                .where('user_id', '=', actor.id)
                .where('revoked_at', 'is', null)
                .executeTakeFirst();
            if (!priorConsent)
                await tx
                    .insertInto('combination_consents')
                    .values({
                        id: randomUUID(),
                        role: actor.id === preview.recipientId ? 'recipient_owner' : 'source_owner',
                        accepted_at: new Date(),
                        preview_hash: previewHash,
                        revoked_at: null,
                        combination_id: combination.id,
                        user_id: actor.id,
                    })
                    .execute();
            const acceptedUserIds = (
                await tx
                    .selectFrom('combination_consents')
                    .select('user_id')
                    .where('combination_id', '=', combination.id)
                    .where('revoked_at', 'is', null)
                    .where('preview_hash', '=', previewHash)
                    .execute()
            ).map((row) => row.user_id);
            let status: 'consent_pending' | 'applied' =
                combination.status === 'applied' ? 'applied' : 'consent_pending';
            if (status !== 'applied' && preview.requiredUserIds.every((id) => acceptedUserIds.includes(id))) {
                const first = await this.combinationSource(tx, preview.firstUserId, preview.familyId);
                const second = await this.combinationSource(tx, preview.secondUserId, preview.familyId);
                if (
                    !first ||
                    !second ||
                    first.subscriptionId !== preview.firstSubscriptionId ||
                    second.subscriptionId !== preview.secondSubscriptionId
                )
                    throw new ConflictException('Исходные Plus изменились после предпросмотра');
                const product = await tx
                    .selectFrom('billing_products')
                    .select('id')
                    .where('code', '=', 'pro')
                    .where('kind', '=', 'subscription')
                    .executeTakeFirst();
                if (!product) throw new ServiceUnavailableException('Каталог тарифов не подготовлен');
                const now = new Date();
                const resultSubscriptionId = randomUUID();
                await tx
                    .updateTable('subscriptions')
                    .set({ status: 'combined', auto_renew: false, version: sql`version+1` })
                    .where('id', 'in', [preview.firstSubscriptionId, preview.secondSubscriptionId])
                    .execute();
                await tx
                    .insertInto('subscriptions')
                    .values({
                        id: resultSubscriptionId,
                        status: 'active',
                        auto_renew: false,
                        billing_anchor: now,
                        billing_timezone: 'Europe/Moscow',
                        owner_id: preview.recipientId,
                        product_id: product.id,
                    })
                    .execute();
                await tx
                    .insertInto('subscription_periods')
                    .values({
                        id: randomUUID(),
                        starts_at: now,
                        ends_at: new Date(preview.resultEndsAt),
                        grant_kind: 'combination',
                        price_snapshot: {
                            amountMinor: 0,
                            currency: 'RUB',
                            period: 'combined',
                            paymentMode: 'none',
                            previewId: preview.previewId,
                        },
                        subscription_id: resultSubscriptionId,
                        order_id: null,
                    })
                    .execute();
                await tx
                    .updateTable('family_coverages')
                    .set({ ends_at: now, version: sql`version+1` })
                    .where('family_id', '=', preview.familyId)
                    .where('selected_at', 'is not', null)
                    .where('ends_at', 'is', null)
                    .execute();
                await tx
                    .insertInto('family_coverages')
                    .values({
                        id: randomUUID(),
                        reason: 'combined_pro',
                        starts_at: now,
                        ends_at: null,
                        selected_at: now,
                        family_id: preview.familyId,
                        subscription_id: resultSubscriptionId,
                        combination_id: combination.id,
                    })
                    .execute();
                await tx
                    .updateTable('subscription_combinations')
                    .set({
                        status: 'applied',
                        applied_at: now,
                        result_subscription_id: resultSubscriptionId,
                        version: sql`version+1`,
                    })
                    .where('id', '=', combination.id)
                    .execute();
                status = 'applied';
            }
            await tx
                .updateTable('users')
                .set({ version: sql`version+1` })
                .where('id', 'in', preview.requiredUserIds)
                .execute();
            const settings = await this.project(tx, actor.id);
            const response = combinationConsentResultSchema.parse({
                status,
                combinationId: combination.id,
                acceptedUserIds,
                requiredUserIds: preview.requiredUserIds,
                resultEndsAt: preview.resultEndsAt,
                settings,
            });
            await this.remember(
                tx,
                actor.id,
                'subscription.combination.consent',
                input.idempotencyKey,
                requestHash,
                response,
                DURABLE_EXPIRY,
            );
            await this.audit(
                tx,
                actor.id,
                requestId,
                status === 'applied' ? 'subscription.combination.applied' : 'subscription.combination.consent.accepted',
                { combinationId: combination.id, previewId: preview.previewId },
            );
            return response;
        });
    }

    async previewDowngrade(raw: unknown, actor: Principal) {
        const input = downgradePreviewRequestSchema.parse(raw);
        const requestHash = hash(input);
        return this.database.transaction(async (tx) => {
            const user = await this.lockedUser(tx, actor.id);
            const duplicate = await this.previous(
                tx,
                actor.id,
                'subscription.downgrade.preview',
                input.idempotencyKey,
                requestHash,
            );
            if (duplicate) return downgradePreviewSchema.parse(duplicate);
            this.assertVersion(user, input.expectedVersion);
            const entitlement = await this.entitlements.resolvePersonal(actor.id, tx);
            if (
                (entitlement.plan !== 'plus' && entitlement.plan !== 'pro') ||
                !entitlement.subscriptionId ||
                !entitlement.periodEndsAt
            )
                throw new ConflictException('Активная личная подписка не найдена');
            if (entitlement.plan === 'plus' && input.targetPlan !== 'free')
                throw new ConflictException('Plus можно понизить только до Free');
            const active = await this.personalPeriod(tx, actor.id);
            if (!active || active.subscriptionId !== entitlement.subscriptionId)
                throw new ConflictException('Активный период подписки не найден');
            const snapshot = this.priceSnapshot(active.priceSnapshot);
            if (!snapshot.period) throw new ConflictException('Период подписки не определён');
            const targetEndsAt =
                input.targetPlan === 'plus'
                    ? addMoscowMonths(new Date(entitlement.periodEndsAt), snapshot.period === 'month' ? 1 : 12)
                    : null;
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
            const response = downgradePreviewSchema.parse({
                previewId: randomUUID(),
                expectedVersion: input.expectedVersion,
                subscriptionId: entitlement.subscriptionId,
                currentPlan: entitlement.plan,
                targetPlan: input.targetPlan,
                effectiveAt: entitlement.periodEndsAt,
                period: input.targetPlan === 'plus' ? snapshot.period : null,
                amountMinor: input.targetPlan === 'plus' ? SUBSCRIPTION_PRICES.plus[snapshot.period] : 0,
                currency: 'RUB',
                paymentMode: 'simulation',
                endsAt: targetEndsAt?.toISOString() ?? null,
                expiresAt: expiresAt.toISOString(),
            });
            await this.remember(
                tx,
                actor.id,
                'subscription.downgrade.preview',
                input.idempotencyKey,
                requestHash,
                response,
                expiresAt,
            );
            return response;
        });
    }

    async commitDowngrade(raw: unknown, actor: Principal, requestId: string) {
        const input = previewCommitSchema.parse(raw);
        const requestHash = hash(input);
        return this.database.transaction(async (tx) => {
            const user = await this.lockedUser(tx, actor.id);
            const duplicate = await this.previous(
                tx,
                actor.id,
                'subscription.downgrade.commit',
                input.idempotencyKey,
                requestHash,
            );
            if (duplicate) return subscriptionSettingsSchema.parse(duplicate);
            this.assertVersion(user, input.expectedVersion);
            const preview = await this.loadPreview(
                tx,
                actor.id,
                'subscription.downgrade.preview',
                input.previewId,
                (value) => downgradePreviewSchema.parse(value),
            );
            if (preview.expectedVersion !== input.expectedVersion)
                throw new ConflictException('Состояние изменилось после предпросмотра');
            const current = await this.entitlements.resolvePersonal(actor.id, tx);
            if (
                current.plan !== preview.currentPlan ||
                current.subscriptionId !== preview.subscriptionId ||
                current.periodEndsAt !== preview.effectiveAt
            )
                throw new ConflictException('Подписка изменилась после предпросмотра');
            const subscription = await tx
                .selectFrom('subscriptions as subscription')
                .innerJoin('billing_products as product', 'product.id', 'subscription.product_id')
                .select(['subscription.id', 'subscription.version'])
                .where('subscription.id', '=', preview.subscriptionId)
                .where('subscription.owner_id', '=', actor.id)
                .where('subscription.status', '=', 'active')
                .where('product.code', '=', preview.currentPlan)
                .forUpdate('subscription')
                .executeTakeFirst();
            if (!subscription) throw new ConflictException('Подписка изменилась');
            const existing = await tx
                .selectFrom('subscription_changes')
                .select('id')
                .where('subscription_id', '=', subscription.id)
                .where('kind', '=', `downgrade_to_${preview.targetPlan}`)
                .where('status', '=', 'scheduled')
                .executeTakeFirst();
            if (existing) throw new ConflictException('Понижение уже запланировано');
            if (preview.targetPlan === 'plus') {
                if (!preview.period || !preview.endsAt) throw new ConflictException('Расчёт Plus неполон');
                const product = await tx
                    .selectFrom('billing_products')
                    .select('id')
                    .where('code', '=', 'plus')
                    .where('kind', '=', 'subscription')
                    .executeTakeFirst();
                if (!product) throw new ServiceUnavailableException('Каталог тарифов не подготовлен');
                const futureSubscriptionId = randomUUID();
                await tx
                    .insertInto('subscriptions')
                    .values({
                        id: futureSubscriptionId,
                        status: 'active',
                        auto_renew: true,
                        billing_anchor: new Date(preview.effectiveAt),
                        billing_timezone: 'Europe/Moscow',
                        owner_id: actor.id,
                        product_id: product.id,
                    })
                    .execute();
                await tx
                    .insertInto('subscription_periods')
                    .values({
                        id: randomUUID(),
                        starts_at: new Date(preview.effectiveAt),
                        ends_at: new Date(preview.endsAt),
                        grant_kind: 'simulation',
                        price_snapshot: {
                            amountMinor: preview.amountMinor,
                            currency: 'RUB',
                            period: preview.period,
                            paymentMode: 'simulation',
                            previewId: preview.previewId,
                        },
                        subscription_id: futureSubscriptionId,
                        order_id: null,
                    })
                    .execute();
                const coverage = await tx
                    .selectFrom('family_coverages')
                    .select('family_id as familyId')
                    .where('subscription_id', '=', subscription.id)
                    .where('selected_at', 'is not', null)
                    .where('ends_at', 'is', null)
                    .executeTakeFirst();
                if (coverage) {
                    await tx
                        .updateTable('family_coverages')
                        .set({ ends_at: new Date(preview.effectiveAt), version: sql`version+1` })
                        .where('family_id', '=', coverage.familyId)
                        .where('selected_at', 'is not', null)
                        .where('ends_at', 'is', null)
                        .execute();
                    await tx
                        .insertInto('family_coverages')
                        .values({
                            id: randomUUID(),
                            reason: 'owner_subscription',
                            starts_at: new Date(preview.effectiveAt),
                            ends_at: null,
                            selected_at: new Date(),
                            family_id: coverage.familyId,
                            subscription_id: futureSubscriptionId,
                            combination_id: null,
                        })
                        .execute();
                }
            }
            await tx
                .updateTable('subscriptions')
                .set({ auto_renew: false, version: sql`version+1` })
                .where('id', '=', subscription.id)
                .where('version', '=', subscription.version)
                .executeTakeFirstOrThrow();
            await tx
                .insertInto('subscription_changes')
                .values({
                    id: randomUUID(),
                    kind: `downgrade_to_${preview.targetPlan}`,
                    status: 'scheduled',
                    preview,
                    scheduled_at: new Date(preview.effectiveAt),
                    applied_at: null,
                    reason: 'user_request',
                    subscription_id: subscription.id,
                    actor_id: actor.id,
                })
                .execute();
            await tx
                .updateTable('users')
                .set({ version: sql`version+1` })
                .where('id', '=', actor.id)
                .execute();
            const response = await this.project(tx, actor.id);
            await this.remember(
                tx,
                actor.id,
                'subscription.downgrade.commit',
                input.idempotencyKey,
                requestHash,
                response,
                DURABLE_EXPIRY,
            );
            await this.audit(tx, actor.id, requestId, 'subscription.downgrade.scheduled', {
                subscriptionId: subscription.id,
                effectiveAt: preview.effectiveAt,
                targetPlan: preview.targetPlan,
            });
            return response;
        });
    }
}
