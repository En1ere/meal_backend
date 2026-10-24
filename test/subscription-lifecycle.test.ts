import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    addMoscowMonths,
    combinedProEndsAt,
    quoteSubscriptionChange,
} from '../src/modules/subscription-settings/subscription-lifecycle.policy.js';

void test('subscription dates keep Moscow wall time and clamp short months', () => {
    assert.equal(addMoscowMonths(new Date('2026-01-31T18:30:00.000Z'), 1).toISOString(), '2026-02-28T18:30:00.000Z');
    assert.equal(addMoscowMonths(new Date('2026-03-31T18:30:00.000Z'), 1).toISOString(), '2026-04-30T18:30:00.000Z');
});

void test('immediate Plus to Pro upgrade credits the unused paid time', () => {
    const quote = quoteSubscriptionChange({
        currentPlan: 'plus',
        currentAmountMinor: 39_900,
        currentStartsAt: new Date('2026-10-01T00:00:00.000Z'),
        currentEndsAt: new Date('2026-11-01T00:00:00.000Z'),
        targetPlan: 'pro',
        period: 'month',
        timing: 'now',
        now: new Date('2026-10-16T12:00:00.000Z'),
    });
    assert.equal(quote.fullAmountMinor, 29_950);
    assert.equal(quote.creditMinor, 19_950);
    assert.equal(quote.amountMinor, 10_000);
    assert.equal(quote.endsAt.toISOString(), '2026-11-01T00:00:00.000Z');
    assert.equal(quote.nextAmountMinor, 59_900);
});

void test('scheduled upgrade starts after the current period without a credit', () => {
    const quote = quoteSubscriptionChange({
        currentPlan: 'plus',
        currentAmountMinor: 39_900,
        currentStartsAt: new Date('2026-10-01T00:00:00.000Z'),
        currentEndsAt: new Date('2026-11-01T00:00:00.000Z'),
        targetPlan: 'pro',
        period: 'year',
        timing: 'period_end',
        now: new Date('2026-10-16T12:00:00.000Z'),
    });
    assert.equal(quote.creditMinor, 0);
    assert.equal(quote.amountMinor, 589_900);
    assert.equal(quote.startsAt.toISOString(), '2026-11-01T00:00:00.000Z');
});

void test('post-trial promo changes only the first Pro period', () => {
    const quote = quoteSubscriptionChange({
        currentPlan: 'free',
        currentAmountMinor: null,
        currentStartsAt: null,
        currentEndsAt: null,
        targetPlan: 'pro',
        period: 'month',
        timing: 'now',
        now: new Date('2026-10-09T09:00:00.000Z'),
        promotionAmountMinor: 53_900,
    });
    assert.equal(quote.amountMinor, 53_900);
    assert.equal(quote.nextAmountMinor, 59_900);
});

void test('combined Pro keeps the later Plus end date without summing periods', () => {
    assert.equal(
        combinedProEndsAt(new Date('2026-11-01T00:00:00.000Z'), new Date('2027-03-15T00:00:00.000Z')).toISOString(),
        '2027-03-15T00:00:00.000Z',
    );
});
