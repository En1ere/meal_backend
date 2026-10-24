import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    MockRefundLedger,
    MockRefundProvider,
    RefundError,
    type RefundRequest,
} from '../src/modules/payments/refunds.js';

const target = { kind: 'subscription_period', id: 'period-1' } as const;
function request(overrides: Partial<RefundRequest> = {}): RefundRequest {
    return {
        key: 'refund-1',
        paymentId: 'paid-1',
        amountMinor: 400,
        currency: 'RUB',
        reason: 'Компенсация',
        access: { mode: 'preserve' },
        ...overrides,
    };
}
function ledger(): MockRefundLedger {
    const value = new MockRefundLedger();
    value.addPaidPayment('paid-1', 1000, 'RUB', [target]);
    return value;
}
function code(expected: RefundError['code']): (error: unknown) => boolean {
    return (error) => error instanceof RefundError && error.code === expected;
}

await test('pending and unknown refunds reserve money; only confirmed failure releases reservation', () => {
    const value = ledger();
    value.reserve(request({ amountMinor: 700 }));
    assert.throws(() => value.reserve(request({ key: 'second', amountMinor: 301 })), code('refund_limit'));
    value.settle('paid-1', 'refund-1', 'unknown');
    assert.throws(() => value.reserve(request({ key: 'second', amountMinor: 301 })), code('refund_limit'));
    value.reserve(request({ key: 'second', amountMinor: 300 }));
    value.settle('paid-1', 'refund-1', 'failed');
    value.reserve(request({ key: 'third', amountMinor: 700 }));
    assert.throws(() => value.reserve(request({ key: 'fourth', amountMinor: 1 })), code('refund_limit'));
});

await test('safe integer money, exact currency, required reason and paid target ownership', () => {
    const value = ledger();
    for (const amountMinor of [0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => value.reserve(request({ amountMinor })), code('invalid_request'));
    }
    assert.throws(() => value.reserve(request({ currency: 'USD' })), code('invalid_request'));
    assert.throws(() => value.reserve(request({ reason: '  ' })), code('invalid_request'));
    assert.throws(
        () => value.reserve(request({ access: { mode: 'revoke', target: { ...target, id: 'another-period' } } })),
        code('invalid_request'),
    );
});

await test('idempotency binds complete payload and defensive copies prevent reservation mutation', () => {
    const value = ledger();
    const first = value.reserve(request());
    assert.deepEqual(value.reserve(request()), first);
    for (const change of [{ amountMinor: 401 }, { reason: 'Другая причина' }, { access: { mode: 'revoke', target } }]) {
        assert.throws(() => value.reserve(request(change as Partial<RefundRequest>)), code('idempotency_conflict'));
    }
    const mutable = request();
    Object.assign(first.request, { amountMinor: 1 });
    assert.equal(value.reserve(mutable).request.amountMinor, 400);
    value.reserve(request({ key: 'other', amountMinor: 600 }));
    assert.throws(() => value.reserve(request({ key: 'over', amountMinor: 1 })), code('refund_limit'));
});

await test('access revocation is emitted only once after success; compensation preserves access', () => {
    const value = ledger();
    value.reserve(request({ access: { mode: 'revoke', target } }));
    assert.equal(value.settle('paid-1', 'refund-1', 'unknown').revoke, null);
    assert.deepEqual(value.settle('paid-1', 'refund-1', 'succeeded').revoke, target);
    assert.equal(value.settle('paid-1', 'refund-1', 'succeeded').revoke, null);
    assert.throws(() => value.settle('paid-1', 'refund-1', 'failed'), code('provider_conflict'));
    value.reserve(request({ key: 'compensation' }));
    assert.equal(value.settle('paid-1', 'compensation', 'succeeded').revoke, null);
});

await test('mock provider retains unknown state and resolves deterministically without duplicate refunds', async () => {
    const provider = new MockRefundProvider('unknown');
    assert.deepEqual(provider.status(), { configured: true, provider: 'mock' });
    assert.equal(await provider.lookup('missing', 'missing'), 'unknown');
    assert.equal(await provider.refund(request()), 'unknown');
    assert.equal(await provider.refund(request()), 'unknown');
    await assert.rejects(provider.refund(request({ amountMinor: 500 })), code('idempotency_conflict'));
    provider.resolve('paid-1', 'refund-1', 'succeeded');
    assert.equal(await provider.lookup('paid-1', 'refund-1'), 'succeeded');
    assert.equal(await provider.refund(request()), 'succeeded');
    assert.throws(() => provider.resolve('paid-1', 'refund-1', 'failed'), code('provider_conflict'));
});
