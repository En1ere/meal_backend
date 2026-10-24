import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import {
    paymentSnapshotSchema,
    paymentTransition,
    type PaymentSnapshot,
    type PaymentState,
    type VerifiedPaymentEvent,
} from './payment-provider.js';
import type {
    CheckoutCommand,
    PaymentRepository,
    ReconciliationCommand,
    ReservedCheckout,
    ReservedRefund,
} from './payment-application.js';
import { RefundError, type ProviderOutcome, type RefundRequest, type RefundTransition } from './refunds.js';

type Tx = Transaction<DatabaseSchema>;
type Attempt = {
    id: string;
    provider: string;
    external_id: string | null;
    status: string;
    amount_minor: string;
    order_id: string;
    checkout_url: string | null;
    provider_occurred_at: Date | null;
    created_at: Date;
};

const toSnapshot = (row: Attempt): PaymentSnapshot =>
    paymentSnapshotSchema.parse({
        provider: row.provider,
        externalId: row.external_id,
        orderId: row.order_id,
        state: row.status,
        amountMinor: Number(row.amount_minor),
        currency: 'RUB',
        checkoutUrl: row.checkout_url,
        occurredAt: (row.provider_occurred_at ?? row.created_at).toISOString(),
    });

@Injectable()
export class PostgresPaymentRepository implements PaymentRepository {
    constructor(private readonly database: DatabaseService) {}

    private transaction<T>(run: (tx: Tx) => Promise<T>) {
        return this.database.transaction(run);
    }

    async reserveCheckout(command: CheckoutCommand, provider: string, requestHash: string): Promise<ReservedCheckout> {
        return this.transaction(async (tx) => {
            const order = await sql<{
                id: string;
                payer_id: string;
                status: string;
                amount_minor: string;
                currency: string;
            }>`select id,payer_id,status,amount_minor,currency from meal.billing_orders where id=${command.orderId}::uuid for update`.execute(
                tx,
            );
            const value = order.rows[0];
            if (!value) throw new NotFoundException('Payment order not found');
            if (value.payer_id !== command.payerId) throw new NotFoundException('Payment order not found');
            if (value.currency !== command.currency || Number(value.amount_minor) !== command.amountMinor)
                throw new ConflictException('Checkout quote changed');
            if (!['pending', 'payment_pending'].includes(value.status))
                throw new ConflictException('Order is not payable');
            const existing = await sql<Attempt & { request_hash: string | null }>`select
                id,provider,external_id,status,amount_minor,order_id,checkout_url,provider_occurred_at,created_at,request_hash
                from meal.payment_attempts where order_id=${command.orderId}::uuid
                and idempotency_key=${command.idempotencyKey} for update`.execute(tx);
            const replay = existing.rows[0];
            if (replay) {
                if (replay.request_hash !== requestHash) throw new ConflictException('Idempotency key already used');
                return {
                    attemptId: replay.id,
                    request: command,
                    state: replay.status as PaymentState,
                    snapshot: replay.external_id ? toSnapshot(replay) : null,
                    replayed: true,
                };
            }
            const attemptId = randomUUID();
            await tx
                .insertInto('payment_attempts')
                .values({
                    id: attemptId,
                    provider,
                    external_id: null,
                    status: 'pending',
                    amount_minor: command.amountMinor,
                    idempotency_key: command.idempotencyKey,
                    order_id: command.orderId,
                    request_hash: requestHash,
                    checkout_url: null,
                    provider_occurred_at: null,
                })
                .execute();
            return { attemptId, request: command, state: 'pending', snapshot: null, replayed: false };
        });
    }

    markCheckoutUnknown(attemptId: string): Promise<void> {
        return this.transaction(async (tx) => {
            await tx
                .updateTable('payment_attempts')
                .set({ status: 'unknown', version: sql`version+1` })
                .where('id', '=', attemptId)
                .where('status', 'in', ['pending', 'processing'])
                .execute();
        });
    }

    private async lockedAttempt(tx: Tx, attemptId: string): Promise<Attempt> {
        const result = await sql<Attempt>`select
            id,provider,external_id,status,amount_minor,order_id,checkout_url,provider_occurred_at,created_at
            from meal.payment_attempts where id=${attemptId}::uuid for update`.execute(tx);
        if (!result.rows[0]) throw new NotFoundException('Payment attempt not found');
        return result.rows[0];
    }

    private async applySnapshot(tx: Tx, attempt: Attempt, snapshot: PaymentSnapshot, source: string) {
        if (
            attempt.order_id !== snapshot.orderId ||
            attempt.provider !== snapshot.provider ||
            Number(attempt.amount_minor) !== snapshot.amountMinor ||
            snapshot.currency !== 'RUB'
        )
            throw new ConflictException('Provider payment binding mismatch');
        if (attempt.external_id && attempt.external_id !== snapshot.externalId)
            throw new ConflictException('Provider payment identity changed');
        const next = paymentTransition(attempt.status as PaymentState, snapshot.state);
        const newlySucceeded = attempt.status !== 'succeeded' && next === 'succeeded';
        await tx
            .updateTable('payment_attempts')
            .set({
                external_id: snapshot.externalId,
                status: next,
                checkout_url: snapshot.checkoutUrl,
                provider_occurred_at: new Date(snapshot.occurredAt),
                version: sql`version+1`,
            })
            .where('id', '=', attempt.id)
            .execute();
        if (newlySucceeded) {
            await tx
                .updateTable('billing_orders')
                .set({ status: 'paid', accepted_at: new Date(snapshot.occurredAt), version: sql`version+1` })
                .where('id', '=', attempt.order_id)
                .execute();
            await tx
                .insertInto('outbox_events')
                .values({
                    id: randomUUID(),
                    type: 'payment.succeeded',
                    payload_minimized: { orderId: attempt.order_id, attemptId: attempt.id, source },
                    occurred_at: new Date(snapshot.occurredAt),
                    published_at: null,
                    attempts: 0,
                })
                .execute();
        }
        return snapshot;
    }

    applyPaymentSnapshot(attemptId: string, snapshot: PaymentSnapshot, source: 'checkout' | 'reconciliation') {
        return this.transaction(async (tx) =>
            this.applySnapshot(tx, await this.lockedAttempt(tx, attemptId), snapshot, source),
        );
    }

    applyVerifiedEvent(event: VerifiedPaymentEvent): Promise<PaymentSnapshot> {
        return this.transaction(async (tx) => {
            const duplicate = await sql<{ attempt_id: string | null }>`select attempt_id from meal.payment_events
                where provider=${event.provider} and external_event_id=${event.eventId}`.execute(tx);
            if (duplicate.rows[0]) {
                if (!duplicate.rows[0].attempt_id) throw new ConflictException('Webhook event awaits reconciliation');
                return toSnapshot(await this.lockedAttempt(tx, duplicate.rows[0].attempt_id));
            }
            const matched = await sql<Attempt>`select
                id,provider,external_id,status,amount_minor,order_id,checkout_url,provider_occurred_at,created_at
                from meal.payment_attempts
                where provider=${event.provider} and (external_id=${event.externalId} or order_id=${event.orderId}::uuid)
                order by created_at desc limit 1 for update`.execute(tx);
            const attempt = matched.rows[0];
            if (!attempt) throw new NotFoundException('Payment attempt not found');
            const snapshot = paymentSnapshotSchema.parse({
                provider: event.provider,
                externalId: event.externalId,
                orderId: event.orderId,
                state: event.state,
                amountMinor: event.amountMinor,
                currency: event.currency,
                checkoutUrl: null,
                occurredAt: event.occurredAt,
            });
            await tx
                .insertInto('payment_events')
                .values({
                    id: randomUUID(),
                    provider: event.provider,
                    external_event_id: event.eventId,
                    occurred_at: new Date(event.occurredAt),
                    received_at: new Date(),
                    processed_at: new Date(),
                    payload_redacted: {
                        state: event.state,
                        ...(event.metadata.code ? { code: event.metadata.code } : {}),
                        ...(event.metadata.liveMode === undefined ? {} : { liveMode: event.metadata.liveMode }),
                    },
                    attempt_id: attempt.id,
                })
                .execute();
            return this.applySnapshot(tx, attempt, snapshot, 'webhook');
        });
    }

    paymentLookup(attemptId: string) {
        return this.transaction(async (tx) => {
            const attempt = await this.lockedAttempt(tx, attemptId);
            if (!attempt.external_id) throw new ConflictException('Payment has no provider identity');
            return {
                request: { provider: attempt.provider, externalId: attempt.external_id, orderId: attempt.order_id },
            };
        });
    }

    recordReconciliation(command: ReconciliationCommand, snapshot: PaymentSnapshot): Promise<PaymentSnapshot> {
        return this.transaction(async (tx) => {
            const attempt = await this.lockedAttempt(tx, command.attemptId);
            const result = await this.applySnapshot(tx, attempt, snapshot, 'reconciliation');
            await tx
                .insertInto('payment_reconciliations')
                .values({
                    id: randomUUID(),
                    status: snapshot.state,
                    requested_at: new Date(),
                    result: { provider: snapshot.provider, externalId: snapshot.externalId, state: snapshot.state },
                    reason: command.reason,
                    attempt_id: attempt.id,
                    requested_by: command.requestedBy,
                })
                .execute();
            return result;
        });
    }

    reserveRefund(requestedBy: string, request: RefundRequest, requestHash: string): Promise<ReservedRefund> {
        return this.transaction(async (tx) => {
            if (
                !request.key.trim() ||
                request.key.length > 200 ||
                !request.reason.trim() ||
                request.reason.length > 2000
            )
                throw new RefundError('invalid_request');
            const payment = await sql<Attempt>`select
                id,provider,external_id,status,amount_minor,order_id,checkout_url,provider_occurred_at,created_at
                from meal.payment_attempts
                where external_id=${request.paymentId} and status='succeeded' for update`.execute(tx);
            const attempt = payment.rows[0];
            if (!attempt) throw new RefundError('not_found');
            const existing = await sql<{
                id: string;
                request_hash: string | null;
                status: ProviderOutcome;
            }>`select id,request_hash,status from meal.payment_refunds
                where attempt_id=${attempt.id}::uuid and idempotency_key=${request.key} for update`.execute(tx);
            if (existing.rows[0]) {
                if (existing.rows[0].request_hash !== requestHash) throw new RefundError('idempotency_conflict');
                return { refundId: existing.rows[0].id, request, status: existing.rows[0].status, replayed: true };
            }
            if (request.currency !== 'RUB' || !Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0)
                throw new RefundError('invalid_request');
            const totals = await sql<{ reserved: string }>`select coalesce(sum(amount_minor),0)::text reserved
                from meal.payment_refunds where attempt_id=${attempt.id}::uuid and status<>'failed'`.execute(tx);
            if (request.amountMinor > Number(attempt.amount_minor) - Number(totals.rows[0]?.reserved ?? 0))
                throw new RefundError('refund_limit');
            if (request.access.mode === 'revoke') {
                const target = request.access.target;
                const binding =
                    target.kind === 'subscription_period'
                        ? await sql<{
                              ok: boolean;
                          }>`select exists(select 1 from meal.subscription_periods where id=${target.id}::uuid and order_id=${attempt.order_id}::uuid) ok`.execute(
                              tx,
                          )
                        : await sql<{
                              ok: boolean;
                          }>`select exists(select 1 from meal.ai_buckets where id=${target.id}::uuid and order_id=${attempt.order_id}::uuid) ok`.execute(
                              tx,
                          );
                if (!binding.rows[0]?.ok) throw new RefundError('invalid_request');
            }
            const refundId = randomUUID();
            await tx
                .insertInto('payment_refunds')
                .values({
                    id: refundId,
                    amount_minor: request.amountMinor,
                    status: 'pending',
                    provider_ref: null,
                    reason: request.reason,
                    attempt_id: attempt.id,
                    requested_by: requestedBy,
                    idempotency_key: request.key,
                    request_hash: requestHash,
                    access_effect: request.access.mode === 'revoke' ? 'terminate' : 'preserve',
                    access_target_kind: request.access.mode === 'revoke' ? request.access.target.kind : null,
                    access_target_id: request.access.mode === 'revoke' ? request.access.target.id : null,
                    provider_event_id: null,
                    consequence_applied_at: null,
                })
                .execute();
            return { refundId, request, status: 'pending', replayed: false };
        });
    }

    settleRefund(refundId: string, outcome: ProviderOutcome, providerEventId?: string): Promise<RefundTransition> {
        return this.transaction(async (tx) => {
            const rows = await sql<{
                id: string;
                status: ProviderOutcome;
                access_effect: 'preserve' | 'terminate';
                access_target_kind: 'subscription_period' | 'ai_package' | null;
                access_target_id: string | null;
                consequence_applied_at: Date | null;
                requested_by: string;
                attempt_id: string;
                amount_minor: string;
                reason: string;
                idempotency_key: string | null;
                payment_id: string | null;
                provider_event_id: string | null;
            }>`select r.id,r.status,r.access_effect,r.access_target_kind,r.access_target_id,
                r.consequence_applied_at,r.requested_by,r.attempt_id,r.amount_minor,r.reason,
                r.idempotency_key,r.provider_event_id,a.external_id payment_id from meal.payment_refunds r
                join meal.payment_attempts a on a.id=r.attempt_id where r.id=${refundId}::uuid for update of r`.execute(
                tx,
            );
            const refund = rows.rows[0];
            if (!refund) throw new RefundError('not_found');
            if (['succeeded', 'failed'].includes(refund.status) && refund.status !== outcome)
                throw new RefundError('provider_conflict');
            const nextOutcome = refund.status === 'unknown' && outcome === 'pending' ? 'unknown' : outcome;
            const firstSuccess = nextOutcome === 'succeeded' && !refund.consequence_applied_at;
            const now = new Date();
            if (firstSuccess && refund.access_effect === 'terminate' && refund.access_target_id) {
                if (refund.access_target_kind === 'subscription_period') {
                    const period = await sql<{
                        subscription_id: string;
                    }>`select subscription_id from meal.subscription_periods
                        where id=${refund.access_target_id}::uuid for update`.execute(tx);
                    if (!period.rows[0]) throw new RefundError('not_found');
                    await sql`update meal.subscription_periods set ends_at=least(ends_at,${now}),version=version+1
                        where id=${refund.access_target_id}::uuid`.execute(tx);
                    await tx
                        .insertInto('subscription_changes')
                        .values({
                            id: randomUUID(),
                            kind: 'refund_termination',
                            status: 'applied',
                            preview: { refundId, targetId: refund.access_target_id },
                            scheduled_at: null,
                            applied_at: now,
                            reason: 'Подтверждённый возврат с прекращением доступа',
                            subscription_id: period.rows[0].subscription_id,
                            actor_id: refund.requested_by,
                        })
                        .execute();
                } else if (refund.access_target_kind === 'ai_package') {
                    const bucket = await sql<{
                        balance_projection: string;
                        reserved_projection: string;
                    }>`select balance_projection,reserved_projection
                        from meal.ai_buckets where id=${refund.access_target_id}::uuid for update`.execute(tx);
                    if (!bucket.rows[0]) throw new RefundError('not_found');
                    const delta =
                        Number(bucket.rows[0].reserved_projection) - Number(bucket.rows[0].balance_projection);
                    await sql`update meal.ai_buckets set balance_projection=reserved_projection,version=version+1
                        where id=${refund.access_target_id}::uuid`.execute(tx);
                    if (delta !== 0)
                        await tx
                            .insertInto('ai_ledger')
                            .values({
                                id: randomUUID(),
                                kind: 'refund',
                                delta,
                                reserved_delta: 0,
                                recorded_at: now,
                                idempotency_key: `payment-refund:${refundId}`,
                                bucket_id: refund.access_target_id,
                                operation_id: null,
                                compensates_id: null,
                            })
                            .execute();
                }
            }
            await tx
                .updateTable('payment_refunds')
                .set({
                    status: nextOutcome,
                    provider_event_id: providerEventId ?? refund.provider_event_id,
                    consequence_applied_at: firstSuccess ? now : refund.consequence_applied_at,
                    version: sql`version+1`,
                })
                .where('id', '=', refundId)
                .execute();
            if (firstSuccess)
                await tx
                    .insertInto('outbox_events')
                    .values({
                        id: randomUUID(),
                        type: 'payment.refund.succeeded',
                        payload_minimized: {
                            refundId,
                            attemptId: refund.attempt_id,
                            accessEffect: refund.access_effect,
                            targetKind: refund.access_target_kind,
                            targetId: refund.access_target_id,
                        },
                        occurred_at: now,
                        published_at: null,
                        attempts: 0,
                    })
                    .execute();
            return {
                record: {
                    request: {
                        key: refund.idempotency_key ?? refund.id,
                        paymentId: refund.payment_id ?? refund.attempt_id,
                        amountMinor: Number(refund.amount_minor),
                        currency: 'RUB',
                        reason: refund.reason,
                        access:
                            refund.access_effect === 'terminate' && refund.access_target_kind && refund.access_target_id
                                ? {
                                      mode: 'revoke',
                                      target: { kind: refund.access_target_kind, id: refund.access_target_id },
                                  }
                                : { mode: 'preserve' },
                    },
                    status: nextOutcome,
                },
                revoke:
                    firstSuccess &&
                    refund.access_effect === 'terminate' &&
                    refund.access_target_kind &&
                    refund.access_target_id
                        ? { kind: refund.access_target_kind, id: refund.access_target_id }
                        : null,
            };
        });
    }
}
