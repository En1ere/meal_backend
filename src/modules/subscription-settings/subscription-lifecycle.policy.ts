export type PaidPlan = 'plus' | 'pro';
export type BillingPeriod = 'month' | 'year';
export type ChangeTiming = 'now' | 'period_end';

export const SUBSCRIPTION_PRICES = {
    plus: { month: 39_900, year: 389_900 },
    pro: { month: 59_900, year: 589_900 },
} as const satisfies Record<PaidPlan, Record<BillingPeriod, number>>;

export const SUBSCRIPTION_ALLOWANCE = { plus: 40, pro: 120 } as const satisfies Record<PaidPlan, number>;

const MOSCOW_OFFSET = 3 * 60 * 60 * 1000;

export function addMoscowMonths(source: Date, months: number) {
    const local = new Date(source.getTime() + MOSCOW_OFFSET);
    const targetMonth = local.getUTCMonth() + months;
    const year = local.getUTCFullYear() + Math.floor(targetMonth / 12);
    const month = ((targetMonth % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(
        Date.UTC(
            year,
            month,
            Math.min(local.getUTCDate(), lastDay),
            local.getUTCHours(),
            local.getUTCMinutes(),
            local.getUTCSeconds(),
            local.getUTCMilliseconds(),
        ) - MOSCOW_OFFSET,
    );
}

export function quoteSubscriptionChange(input: {
    currentPlan: 'free' | PaidPlan;
    currentAmountMinor: number | null;
    currentStartsAt: Date | null;
    currentEndsAt: Date | null;
    targetPlan: PaidPlan;
    period: BillingPeriod;
    timing: ChangeTiming;
    now: Date;
    promotionAmountMinor?: number | null;
}) {
    const regularAmountMinor = SUBSCRIPTION_PRICES[input.targetPlan][input.period];
    let fullAmountMinor = input.promotionAmountMinor ?? regularAmountMinor;
    const startsAt =
        input.timing === 'period_end' && input.currentEndsAt && input.currentEndsAt > input.now
            ? input.currentEndsAt
            : input.now;
    let endsAt = addMoscowMonths(startsAt, input.period === 'month' ? 1 : 12);
    let creditMinor = 0;
    if (
        input.timing === 'now' &&
        input.currentPlan === 'plus' &&
        input.targetPlan === 'pro' &&
        input.currentAmountMinor &&
        input.currentStartsAt &&
        input.currentEndsAt &&
        input.currentEndsAt > input.now
    ) {
        const duration = input.currentEndsAt.getTime() - input.currentStartsAt.getTime();
        const remaining = input.currentEndsAt.getTime() - input.now.getTime();
        if (duration > 0) {
            fullAmountMinor = Math.floor((regularAmountMinor * remaining) / duration);
            creditMinor = Math.floor((input.currentAmountMinor * remaining) / duration);
            endsAt = input.currentEndsAt;
        }
    }
    return {
        fullAmountMinor,
        creditMinor,
        amountMinor: Math.max(0, fullAmountMinor - creditMinor),
        startsAt,
        endsAt,
        nextChargeAt: endsAt,
        nextAmountMinor: regularAmountMinor,
    };
}

export const combinedProEndsAt = (first: Date, second: Date) => new Date(Math.max(first.getTime(), second.getTime()));
