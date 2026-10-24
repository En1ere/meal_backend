import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { AdminAccessService } from '../admin-auth/admin-access.service.js';
import type { Principal } from '../auth/auth.service.js';
import { PaymentApplicationService } from '../payments/payment-application.js';
import { billingCommandSchema, billingResultSchema, billingViewSchema } from './admin-billing.contracts.js';

type Db = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;
type Section = 'users' | 'subscriptions' | 'payments';
type Target = {
    requestedId: string;
    ownerId: string;
    subscriptionId: string | null;
    subscriptionVersion: string | null;
    subscriptionStatus: string | null;
    productCode: string | null;
    payerId: string | null;
    orderId: string | null;
    orderStatus: string | null;
    attemptStatus: string | null;
    attemptId: string | null;
    paymentExternalId: string | null;
    amountMinor: string | null;
    currency: string | null;
};

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actorNamespace = (actor: Principal) => `admin:${actor.id}`;

@Injectable()
export class AdminBillingService {
    constructor(
        private readonly database: DatabaseService,
        private readonly adminAccess: AdminAccessService,
        private readonly payments: PaymentApplicationService,
    ) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    private async resolve(db: Db, section: Section, id: string, lock = false): Promise<Target> {
        if (section === 'users') {
            const user = await sql<{ id: string }>`select id from meal.users where id=${id}::uuid
                ${lock ? sql`for update` : sql``}`.execute(db);
            if (!user.rows[0]) throw new NotFoundException();
            const subscription = await sql<{
                id: string;
                version: string;
                status: string;
                code: string;
            }>`select s.id,s.version,s.status,p.code from meal.subscriptions s join meal.billing_products p on p.id=s.product_id
                where s.owner_id=${id}::uuid order by s.created_at desc,s.id desc limit 1
                ${lock ? sql`for update of s` : sql``}`.execute(db);
            const sub = subscription.rows[0];
            return {
                requestedId: id,
                ownerId: id,
                subscriptionId: sub?.id ?? null,
                subscriptionVersion: sub?.version ?? null,
                subscriptionStatus: sub?.status ?? null,
                productCode: sub?.code ?? null,
                payerId: null,
                orderId: null,
                orderStatus: null,
                attemptStatus: null,
                attemptId: null,
                paymentExternalId: null,
                amountMinor: null,
                currency: null,
            };
        }
        if (section === 'subscriptions') {
            const rows = await sql<{
                id: string;
                owner_id: string;
                version: string;
                status: string;
                code: string;
            }>`select s.id,s.owner_id,s.version,s.status,p.code from meal.subscriptions s join meal.billing_products p on p.id=s.product_id
                where s.id=${id}::uuid ${lock ? sql`for update of s` : sql``}`.execute(db);
            const row = rows.rows[0];
            if (!row) throw new NotFoundException();
            return {
                requestedId: id,
                ownerId: row.owner_id,
                subscriptionId: row.id,
                subscriptionVersion: row.version,
                subscriptionStatus: row.status,
                productCode: row.code,
                payerId: null,
                orderId: null,
                orderStatus: null,
                attemptStatus: null,
                attemptId: null,
                paymentExternalId: null,
                amountMinor: null,
                currency: null,
            };
        }
        const rows = await sql<{
            id: string;
            payer_id: string;
            recipient_id: string;
            status: string;
            amount_minor: string;
            currency: string;
            subscription_id: string | null;
            subscription_version: string | null;
            subscription_status: string | null;
            code: string | null;
            attempt_status: string | null;
            attempt_id: string | null;
            payment_external_id: string | null;
        }>`select o.id,o.payer_id,o.recipient_id,o.status,o.amount_minor,o.currency,
            s.id subscription_id,s.version subscription_version,s.status subscription_status,p.code,
            attempt.status attempt_status,attempt.id attempt_id,attempt.external_id payment_external_id
            from meal.billing_orders o
            left join meal.subscription_periods sp on sp.order_id=o.id
            left join meal.subscriptions s on s.id=sp.subscription_id
            left join meal.billing_products p on p.id=s.product_id
            left join lateral(select id,status,external_id from meal.payment_attempts pa where pa.order_id=o.id order by pa.created_at desc,pa.id desc limit 1) attempt on true
            where o.id=${id}::uuid order by sp.created_at desc nulls last limit 1
            ${lock ? sql`for update of o` : sql``}`.execute(db);
        const row = rows.rows[0];
        if (!row) throw new NotFoundException();
        return {
            requestedId: id,
            ownerId: row.recipient_id,
            subscriptionId: row.subscription_id,
            subscriptionVersion: row.subscription_version,
            subscriptionStatus: row.subscription_status,
            productCode: row.code,
            payerId: row.payer_id,
            orderId: row.id,
            orderStatus: row.status,
            attemptStatus: row.attempt_status,
            attemptId: row.attempt_id,
            paymentExternalId: row.payment_external_id,
            amountMinor: row.amount_minor,
            currency: row.currency,
        };
    }

    private async project(db: Db, target: Target) {
        const periods = target.subscriptionId
            ? await sql<{
                  id: string;
                  grant_kind: string;
                  starts_at: Date;
                  ends_at: Date;
                  revoked: boolean;
              }>`select sp.id,sp.grant_kind,sp.starts_at,sp.ends_at,
                exists(select 1 from meal.subscription_changes c where c.subscription_id=sp.subscription_id
                    and c.kind='revokeGift' and c.status='applied' and c.preview->>'targetId'=sp.id::text) revoked
                from meal.subscription_periods sp where sp.subscription_id=${target.subscriptionId}::uuid
                order by sp.starts_at,sp.id`.execute(db)
            : { rows: [] };
        const history = target.subscriptionId
            ? await sql<{
                  kind: string;
                  reason: string;
                  at: Date;
              }>`select kind,reason,coalesce(applied_at,created_at) at
                from meal.subscription_changes where subscription_id=${target.subscriptionId}::uuid
                order by created_at desc,id desc limit 50`.execute(db)
            : { rows: [] };
        const quota = await sql<{ balance: string; refresh_at: Date | null }>`select
            coalesce(sum(balance_projection-reserved_projection),0)::text balance,min(expires_at) refresh_at
            from meal.ai_buckets where user_id=${target.ownerId}::uuid and (expires_at is null or expires_at>now())`.execute(
            db,
        );
        const refund = target.orderId
            ? await sql<{ returned: string; reserved: string }>`select
                coalesce(sum(amount_minor) filter(where status='succeeded'),0)::text returned,
                coalesce(sum(amount_minor) filter(where status in('pending','unknown')),0)::text reserved
                from meal.payment_refunds where attempt_id in(select id from meal.payment_attempts where order_id=${target.orderId}::uuid)`.execute(
                  db,
              )
            : { rows: [] };
        const paymentPeriod = target.orderId
            ? (
                  await sql<{
                      id: string;
                  }>`select id from meal.subscription_periods where order_id=${target.orderId}::uuid order by created_at limit 1`.execute(
                      db,
                  )
              ).rows[0]
            : undefined;
        const now = Date.now();
        const active = periods.rows.some(
            (period) => !period.revoked && +period.starts_at <= now && +period.ends_at > now,
        );
        const frozen = target.subscriptionStatus === 'frozen';
        return billingViewSchema.parse({
            id: target.requestedId,
            version: target.subscriptionVersion ?? '1',
            ownerId: target.ownerId,
            payerId: target.payerId,
            plan: active || frozen ? (target.productCode ?? 'free') : 'free',
            status: frozen ? 'frozen' : active ? 'active' : 'inactive',
            frozen,
            quota: Math.max(0, Number(quota.rows[0]?.balance ?? 0)),
            refreshAt: quota.rows[0]?.refresh_at?.toISOString() ?? null,
            periods: periods.rows.map((period) => ({
                id: period.id,
                source: period.grant_kind === 'gift' || period.grant_kind === 'promotion' ? 'gift' : 'paid',
                startsAt: period.starts_at.toISOString(),
                endsAt: period.ends_at.toISOString(),
                revoked: period.revoked,
            })),
            payment: target.orderId
                ? {
                      paidMinor: target.amountMinor ?? '0',
                      returnedMinor: refund.rows[0]?.returned ?? '0',
                      reservedMinor: refund.rows[0]?.reserved ?? '0',
                      currency: 'RUB',
                      status: ['paid', 'succeeded'].includes(target.attemptStatus ?? target.orderStatus ?? '')
                          ? 'paid'
                          : (target.attemptStatus ?? target.orderStatus ?? 'unknown'),
                      targetId: paymentPeriod?.id ?? target.orderId,
                      targetKind: paymentPeriod ? 'period' : 'package',
                      packageRemaining: paymentPeriod ? null : 0,
                  }
                : null,
            history: history.rows.map((entry) => ({
                action: entry.kind,
                reason: entry.reason,
                at: entry.at.toISOString(),
            })),
            notice: 'Периоды и квота читаются из PostgreSQL. Реальный возврат денег и доставка семейных уведомлений недоступны до подключения провайдеров.',
        });
    }

    async view(section: Section, id: string, actor: Principal, requestId: string) {
        const db = await this.db();
        const result = await this.project(db, await this.resolve(db, section, id));
        await this.database.transaction(async (tx) => {
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: 'admin.billing.read',
                    target_type: section,
                    target_id: id,
                    effective_at: new Date(),
                    recorded_at: new Date(),
                    reason: null,
                    before_redacted: null,
                    after_redacted: null,
                    request_id: requestId,
                    actor_id: actor.id,
                    scope_id: null,
                })
                .execute();
        });
        return result;
    }

    async command(section: Section, id: string, raw: unknown, actor: Principal, requestId: string) {
        const input = billingCommandSchema.parse(raw);
        if (input.action === 'refund') {
            const prepared = await this.database.transaction(async (tx) => {
                await this.adminAccess.assertCritical(tx, actor);
                const target = await this.resolve(tx, section, id, true);
                if (section !== 'payments' || !target.orderId || !target.attemptId || !target.paymentExternalId)
                    throw new BadRequestException('Для возврата нужен подтверждённый платёж');
                if ((target.subscriptionVersion ?? '1') !== input.version)
                    throw new ConflictException('Подписка изменилась');
                if (!input.amountMinor) throw new BadRequestException('Сумма возврата обязательна');
                const amountMinor = Number(input.amountMinor);
                if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
                    throw new BadRequestException('Некорректная сумма');
                let access:
                    | { mode: 'preserve' }
                    | {
                          mode: 'revoke';
                          target: { kind: 'subscription_period' | 'ai_package'; id: string };
                      } = { mode: 'preserve' };
                if (input.effect === 'terminate') {
                    if (!input.accessConfirmed || !input.targetId)
                        throw new BadRequestException('Прекращение доступа требует отдельного подтверждения');
                    const binding = await sql<{ kind: 'subscription_period' | 'ai_package' }>`
                        select 'subscription_period'::text kind from meal.subscription_periods
                          where id=${input.targetId}::uuid and order_id=${target.orderId}::uuid
                        union all
                        select 'ai_package'::text kind from meal.ai_buckets
                          where id=${input.targetId}::uuid and order_id=${target.orderId}::uuid
                        limit 1`.execute(tx);
                    if (!binding.rows[0]) throw new BadRequestException('Объект доступа не принадлежит платежу');
                    access = { mode: 'revoke', target: { kind: binding.rows[0].kind, id: input.targetId } };
                }
                await tx
                    .insertInto('audit_events')
                    .values({
                        id: randomUUID(),
                        action: 'admin.billing.refund.requested',
                        target_type: 'payment',
                        target_id: id,
                        effective_at: new Date(),
                        recorded_at: new Date(),
                        reason: input.reason,
                        before_redacted: null,
                        after_redacted: { amountMinor: input.amountMinor, effect: input.effect },
                        request_id: requestId,
                        actor_id: actor.id,
                        scope_id: null,
                    })
                    .execute();
                return { target, paymentExternalId: target.paymentExternalId, amountMinor, access };
            });
            const transition = await this.payments.refund(actor.id, {
                key: input.idempotencyKey,
                paymentId: prepared.paymentExternalId,
                amountMinor: prepared.amountMinor,
                currency: prepared.target.currency ?? 'RUB',
                reason: input.reason,
                access: prepared.access,
            });
            const result = billingResultSchema.parse({
                id,
                version: prepared.target.subscriptionVersion ?? '1',
                status: transition.record.status,
            });
            await this.database.transaction(async (tx) => {
                await tx
                    .insertInto('audit_events')
                    .values({
                        id: randomUUID(),
                        action: 'admin.billing.refund',
                        target_type: 'payment',
                        target_id: id,
                        effective_at: new Date(),
                        recorded_at: new Date(),
                        reason: input.reason,
                        before_redacted: null,
                        after_redacted: {
                            amountMinor: input.amountMinor,
                            effect: input.effect,
                            status: transition.record.status,
                        },
                        request_id: requestId,
                        actor_id: actor.id,
                        scope_id: null,
                    })
                    .execute();
            });
            return result;
        }
        return this.database.transaction(async (tx) => {
            await this.adminAccess.assertCritical(tx, actor);
            const target = await this.resolve(tx, section, id, true);
            const operation = `admin.billing.${input.action}`;
            const requestHash = digest({ section, id, input });
            const replay = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', actorNamespace(actor))
                .where('operation', '=', operation)
                .where('target_binding', '=', id)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (replay) {
                if (replay.request_hash !== requestHash)
                    throw new ConflictException('Ключ идемпотентности уже использован');
                return billingResultSchema.parse(replay.response_snapshot);
            }
            if ((target.subscriptionVersion ?? '1') !== input.version)
                throw new ConflictException('Подписка изменилась');
            if (section === 'payments') throw new BadRequestException('Для платежа доступен только возврат');
            const now = new Date();
            let subscriptionId = target.subscriptionId;
            if (input.action === 'grant') {
                if (section !== 'users' || !input.until || input.until <= now.toISOString())
                    throw new BadRequestException();
                const hasActive = target.subscriptionId
                    ? await sql<{
                          active: boolean;
                      }>`select exists(select 1 from meal.subscription_periods sp where sp.subscription_id=${target.subscriptionId}::uuid
                        and sp.starts_at<=now() and sp.ends_at>now() and not exists(select 1 from meal.subscription_changes c where c.subscription_id=sp.subscription_id and c.kind='revokeGift' and c.status='applied' and c.preview->>'targetId'=sp.id::text)) active`.execute(
                          tx,
                      )
                    : { rows: [{ active: false }] };
                if (hasActive.rows[0]?.active) throw new ConflictException('У пользователя уже есть активный период');
                const product = await tx
                    .selectFrom('billing_products')
                    .select('id')
                    .where('kind', '=', 'subscription')
                    .where('code', '=', input.plan)
                    .executeTakeFirst();
                if (!product) throw new ServiceUnavailableException('Каталог тарифов не подготовлен');
                subscriptionId = randomUUID();
                await tx
                    .insertInto('subscriptions')
                    .values({
                        id: subscriptionId,
                        status: 'active',
                        auto_renew: false,
                        billing_anchor: now,
                        billing_timezone: 'Europe/Moscow',
                        owner_id: target.ownerId,
                        product_id: product.id,
                    })
                    .execute();
                await tx
                    .insertInto('subscription_periods')
                    .values({
                        id: randomUUID(),
                        starts_at: now,
                        ends_at: new Date(input.until),
                        grant_kind: 'gift',
                        price_snapshot: { amountMinor: 0, currency: 'RUB', source: 'admin_gift' },
                        subscription_id: subscriptionId,
                        order_id: null,
                    })
                    .execute();
            } else {
                if (!subscriptionId) throw new ConflictException('Подписка не найдена');
                if (input.action === 'extend') {
                    if (!input.until) throw new BadRequestException();
                    const end = await sql<{
                        value: Date | null;
                    }>`select max(sp.ends_at) value from meal.subscription_periods sp
                        where sp.subscription_id=${subscriptionId}::uuid and not exists(select 1 from meal.subscription_changes c where c.subscription_id=sp.subscription_id and c.kind='revokeGift' and c.status='applied' and c.preview->>'targetId'=sp.id::text)`.execute(
                        tx,
                    );
                    const startsAt = end.rows[0]?.value;
                    if (!startsAt || +startsAt <= +now || Date.parse(input.until) <= +startsAt)
                        throw new ConflictException('Новая дата должна продолжать действующий период');
                    await tx
                        .insertInto('subscription_periods')
                        .values({
                            id: randomUUID(),
                            starts_at: startsAt,
                            ends_at: new Date(input.until),
                            grant_kind: 'gift',
                            price_snapshot: { amountMinor: 0, currency: 'RUB', source: 'admin_extension' },
                            subscription_id: subscriptionId,
                            order_id: null,
                        })
                        .execute();
                } else if (input.action === 'revokeGift') {
                    if (!input.targetId) throw new BadRequestException();
                    const period = await sql<{
                        id: string;
                    }>`select sp.id from meal.subscription_periods sp where sp.id=${input.targetId}::uuid
                        and sp.subscription_id=${subscriptionId}::uuid and sp.grant_kind in('gift','promotion')
                        and not exists(select 1 from meal.subscription_changes c where c.subscription_id=sp.subscription_id and c.kind='revokeGift' and c.status='applied' and c.preview->>'targetId'=sp.id::text) for update`.execute(
                        tx,
                    );
                    if (!period.rows[0]) throw new ConflictException('Подарочный период уже недоступен');
                } else if (input.action === 'freeze') {
                    if (target.subscriptionStatus !== 'active')
                        throw new ConflictException('Подписку нельзя заморозить');
                    const active = await sql<{
                        value: boolean;
                    }>`select exists(select 1 from meal.subscription_periods sp
                        where sp.subscription_id=${subscriptionId}::uuid and sp.starts_at<=now() and sp.ends_at>now()
                        and not exists(select 1 from meal.subscription_changes c where c.subscription_id=sp.subscription_id and c.kind='revokeGift' and c.status='applied' and c.preview->>'targetId'=sp.id::text)) value`.execute(
                        tx,
                    );
                    if (!active.rows[0]?.value) throw new ConflictException('Нет активного периода для заморозки');
                    await tx
                        .updateTable('subscriptions')
                        .set({ status: 'frozen', version: sql`version+1` })
                        .where('id', '=', subscriptionId)
                        .execute();
                } else if (input.action === 'unfreeze') {
                    if (target.subscriptionStatus !== 'frozen') throw new ConflictException('Подписка не заморожена');
                    const frozen = await sql<{ at: Date }>`select applied_at at from meal.subscription_changes
                        where subscription_id=${subscriptionId}::uuid and kind='freeze' and status='applied'
                        order by applied_at desc,id desc limit 1`.execute(tx);
                    const frozenAt = frozen.rows[0]?.at;
                    if (!frozenAt) throw new ConflictException('Не найдена точка заморозки');
                    const deltaMs = Math.max(0, +now - +frozenAt);
                    await sql`update meal.subscription_periods set
                        starts_at=case when starts_at>${frozenAt} then starts_at+(${deltaMs}::bigint * interval '1 millisecond') else starts_at end,
                        ends_at=ends_at+(${deltaMs}::bigint * interval '1 millisecond'),version=version+1
                        where subscription_id=${subscriptionId}::uuid and ends_at>${frozenAt}
                        and not exists(select 1 from meal.subscription_changes c where c.subscription_id=subscription_periods.subscription_id and c.kind='revokeGift' and c.status='applied' and c.preview->>'targetId'=subscription_periods.id::text)`.execute(
                        tx,
                    );
                    await tx
                        .updateTable('subscriptions')
                        .set({ status: 'active', version: sql`version+1` })
                        .where('id', '=', subscriptionId)
                        .execute();
                }
            }
            const changeId = randomUUID();
            if (input.action === 'extend' || input.action === 'revokeGift')
                await tx
                    .updateTable('subscriptions')
                    .set({ version: sql`version+1` })
                    .where('id', '=', subscriptionId)
                    .execute();
            await tx
                .insertInto('subscription_changes')
                .values({
                    id: changeId,
                    kind: input.action,
                    status: 'applied',
                    preview: { targetId: input.targetId, until: input.until, plan: input.plan },
                    scheduled_at: null,
                    applied_at: now,
                    reason: input.reason,
                    subscription_id: subscriptionId,
                    actor_id: actor.id,
                })
                .execute();
            const current = await this.resolve(tx, 'subscriptions', subscriptionId, true);
            const result = billingResultSchema.parse({
                id,
                version: String(BigInt(current.subscriptionVersion ?? '1')),
                status: 'succeeded',
            });
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation,
                    target_binding: id,
                    key: input.idempotencyKey,
                    request_hash: requestHash,
                    status: 'completed',
                    response_snapshot: result,
                    expires_at: new Date('9999-12-31T23:59:59.999Z'),
                    user_id: actor.id,
                    scope_id: null,
                    actor_namespace: actorNamespace(actor),
                })
                .execute();
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: operation,
                    target_type: 'subscription',
                    target_id: subscriptionId,
                    effective_at: now,
                    recorded_at: now,
                    reason: input.reason,
                    before_redacted: null,
                    after_redacted: { changeId, ownerId: target.ownerId },
                    request_id: requestId,
                    actor_id: actor.id,
                    scope_id: null,
                })
                .execute();
            return result;
        });
    }
}
