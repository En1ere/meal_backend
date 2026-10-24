import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import {
    PaymentApplicationService,
    type CheckoutCommand,
    type PaymentRepository,
    type ReconciliationCommand,
    type ReservedRefund,
} from '../src/modules/payments/payment-application.js';
import {
    DisabledPaymentProvider,
    type PaymentProvider,
    type PaymentSnapshot,
    type PaymentWebhookRequest,
    type VerifiedPaymentEvent,
} from '../src/modules/payments/payment-provider.js';
import {
    DisabledRefundProvider,
    MockRefundProvider,
    type ProviderOutcome,
    type RefundProvider,
    type RefundRequest,
    type RefundTransition,
} from '../src/modules/payments/refunds.js';

const orderId = 'c9cc69e6-430f-4ef8-b6fe-335647a248d0';
const payerId = 'e395ec19-501c-4c9c-a856-d63c7da36cd3';
const attemptId = 'c8ebc7c5-4ca5-4dc3-a626-7820fe2a527c';
const refundId = '4a38d898-d810-4ba3-b0ac-c8b598298af4';
const command: CheckoutCommand = {
    payerId,
    orderId,
    idempotencyKey: 'checkout-1',
    amountMinor: 59_900,
    currency: 'RUB',
    description: 'Pro на месяц',
    returnUrl: 'https://meal.example/settings/subscription',
};
const snapshot: PaymentSnapshot = {
    provider: 'mock',
    externalId: 'payment-1',
    orderId,
    state: 'requires_action',
    amountMinor: 59_900,
    currency: 'RUB',
    checkoutUrl: 'https://checkout.example/payment-1',
    occurredAt: '2026-10-13T10:00:00.000Z',
};

class FakePaymentProvider implements PaymentProvider {
    fail = false;
    createCalls = 0;
    status() {
        return { configured: true, provider: 'mock' } as const;
    }
    createPayment(): Promise<PaymentSnapshot> {
        this.createCalls++;
        return this.fail ? Promise.reject(new Error('timeout')) : Promise.resolve(snapshot);
    }
    lookupPayment(): Promise<PaymentSnapshot> {
        return Promise.resolve({ ...snapshot, state: 'succeeded' });
    }
    verifyWebhook(_request: PaymentWebhookRequest): Promise<VerifiedPaymentEvent> {
        void _request;
        return Promise.resolve({
            provider: 'mock',
            eventId: 'event-1',
            externalId: snapshot.externalId,
            orderId,
            state: 'succeeded',
            amountMinor: snapshot.amountMinor,
            currency: 'RUB',
            occurredAt: snapshot.occurredAt,
            metadata: {},
        });
    }
}

class FakeRepository implements PaymentRepository {
    unknown = 0;
    applied: string[] = [];
    refundSettlements: ProviderOutcome[] = [];
    checkoutReplayed = false;
    checkoutState: 'pending' | 'unknown' = 'pending';
    refundReplayed = false;
    refundStatus: ProviderOutcome = 'pending';
    reserveCheckout(value: CheckoutCommand, provider: string, requestHash: string) {
        assert.equal(value, command);
        assert.equal(provider, 'mock');
        assert.match(requestHash, /^sha256:[a-f0-9]{64}$/);
        return Promise.resolve({
            attemptId,
            request: command,
            state: this.checkoutState,
            snapshot: null,
            replayed: this.checkoutReplayed,
        });
    }
    markCheckoutUnknown() {
        this.unknown++;
        this.checkoutState = 'unknown';
        this.checkoutReplayed = true;
        return Promise.resolve();
    }
    applyPaymentSnapshot(_attemptId: string, value: PaymentSnapshot, source: 'checkout' | 'reconciliation') {
        this.applied.push(source);
        return Promise.resolve(value);
    }
    applyVerifiedEvent(event: VerifiedPaymentEvent) {
        this.applied.push('webhook');
        return Promise.resolve({ ...snapshot, state: event.state, checkoutUrl: null });
    }
    paymentLookup() {
        return Promise.resolve({ request: { provider: 'mock', externalId: snapshot.externalId, orderId } });
    }
    recordReconciliation(_command: ReconciliationCommand, value: PaymentSnapshot) {
        this.applied.push('reconciliation');
        return Promise.resolve(value);
    }
    reserveRefund(_requestedBy: string, request: RefundRequest, requestHash: string): Promise<ReservedRefund> {
        assert.match(requestHash, /^sha256:[a-f0-9]{64}$/);
        return Promise.resolve({
            refundId,
            request,
            status: this.refundStatus,
            replayed: this.refundReplayed,
        });
    }
    settleRefund(_refundId: string, outcome: ProviderOutcome): Promise<RefundTransition> {
        this.refundSettlements.push(outcome);
        this.refundStatus = outcome;
        this.refundReplayed = true;
        return Promise.resolve({
            record: { request: refundRequest, status: outcome },
            revoke: outcome === 'succeeded' ? refundRequest.access.target : null,
        });
    }
}

class CountingRefundProvider implements RefundProvider {
    calls = 0;
    status() {
        return { configured: true, provider: 'mock' } as const;
    }
    refund(): Promise<ProviderOutcome> {
        this.calls++;
        return Promise.resolve('unknown');
    }
    lookup(): Promise<ProviderOutcome> {
        return Promise.resolve('unknown');
    }
}

const refundRequest = {
    key: 'refund-1',
    paymentId: snapshot.externalId,
    amountMinor: 10_000,
    currency: 'RUB',
    reason: 'Возврат',
    access: { mode: 'revoke', target: { kind: 'subscription_period', id: attemptId } },
} as const satisfies RefundRequest;

void test('checkout reserves before provider call and persists a validated provider snapshot', async () => {
    const repository = new FakeRepository();
    const service = new PaymentApplicationService(repository, new FakePaymentProvider(), new MockRefundProvider());
    assert.deepEqual(await service.checkout(command), snapshot);
    assert.deepEqual(repository.applied, ['checkout']);
    assert.equal(repository.unknown, 0);
});

void test('uncertain checkout outcome is retained for reconciliation instead of being retried as a new payment', async () => {
    const repository = new FakeRepository();
    const provider = new FakePaymentProvider();
    provider.fail = true;
    const service = new PaymentApplicationService(repository, provider, new MockRefundProvider());
    await assert.rejects(service.checkout(command), /timeout/);
    assert.equal(repository.unknown, 1);
    await assert.rejects(
        service.checkout(command),
        (error: unknown) =>
            error instanceof ConflictException &&
            (error.getResponse() as { code?: string }).code === 'PAYMENT_RECONCILIATION_REQUIRED',
    );
    assert.equal(provider.createCalls, 1);
});

void test('pending or unknown refund replay never sends a second provider mutation', async () => {
    const repository = new FakeRepository();
    const provider = new CountingRefundProvider();
    const service = new PaymentApplicationService(repository, new FakePaymentProvider(), provider);
    assert.equal((await service.refund(payerId, refundRequest)).record.status, 'unknown');
    await assert.rejects(
        service.refund(payerId, refundRequest),
        (error: unknown) =>
            error instanceof ConflictException &&
            (error.getResponse() as { code?: string }).code === 'PAYMENT_RECONCILIATION_REQUIRED',
    );
    assert.equal(provider.calls, 1);
});

void test('verified webhooks and explicit reconciliation share the same atomic repository boundary', async () => {
    const repository = new FakeRepository();
    const service = new PaymentApplicationService(repository, new FakePaymentProvider(), new MockRefundProvider());
    assert.equal((await service.webhook({ headers: {}, rawBody: new Uint8Array() })).state, 'succeeded');
    assert.equal(
        (await service.reconcile({ attemptId, requestedBy: payerId, reason: 'unknown outcome' })).state,
        'succeeded',
    );
    assert.deepEqual(repository.applied, ['webhook', 'reconciliation']);
});

void test('refund reserves locally and applies access consequence only after a confirmed provider outcome', async () => {
    const repository = new FakeRepository();
    const service = new PaymentApplicationService(
        repository,
        new FakePaymentProvider(),
        new MockRefundProvider('succeeded'),
    );
    const result = await service.refund(payerId, refundRequest);
    assert.deepEqual(result.revoke, refundRequest.access.target);
    assert.deepEqual(repository.refundSettlements, ['succeeded']);
});

void test('disabled provider boundaries fail before any local financial reservation', async () => {
    const repository = new FakeRepository();
    const service = new PaymentApplicationService(
        repository,
        new DisabledPaymentProvider(),
        new DisabledRefundProvider(),
    );
    await assert.rejects(service.checkout(command), ServiceUnavailableException);
    await assert.rejects(service.refund(payerId, refundRequest), ServiceUnavailableException);
    assert.deepEqual(repository.applied, []);
    assert.deepEqual(repository.refundSettlements, []);
});

void test('prepared payment migration is manifest-bound and adds replay/consequence invariants', () => {
    const migration = readFileSync('database/migrations/026_payment_application.sql', 'utf8');
    const manifest = JSON.parse(readFileSync('database/manifest.json', 'utf8')) as {
        migrations: Array<{ version: number; file: string; sha256: string }>;
    };
    assert.deepEqual(
        manifest.migrations.find(({ version }) => version === 26),
        {
            version: 26,
            file: '026_payment_application.sql',
            sha256: createHash('sha256').update(migration).digest('hex'),
        },
    );
    assert.match(migration, /uq_payment_refunds_attempt_id_idempotency_key/);
    assert.match(migration, /consequence_applied_at/);
    assert.match(migration, /access_target_kind IN\('subscription_period','ai_package'\)/);
    assert.doesNotMatch(migration, /INSERT INTO meal\./i);
});

void test('payment repository reads are explicit and covered by least-privilege grants', () => {
    const repository = readFileSync('src/modules/payments/payment-postgres.repository.ts', 'utf8');
    const grants = readFileSync('database/application-grants.sql', 'utf8');
    assert.doesNotMatch(repository, /select\s+(?:[a-z]+\.)?\*/i);
    assert.match(
        grants,
        /GRANT SELECT\(id,provider,external_id,status,amount_minor,idempotency_key,order_id,created_at,/,
    );
    assert.match(grants, /GRANT SELECT\(provider,external_event_id,attempt_id\) ON meal\.payment_events/);
    assert.match(grants, /access_effect,access_target_kind,access_target_id,provider_event_id,consequence_applied_at/);
    assert.match(grants, /GRANT SELECT\(id,order_id,balance_projection,reserved_projection\) ON meal\.ai_buckets/);
});
