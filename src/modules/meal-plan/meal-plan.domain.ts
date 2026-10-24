import { createHash } from 'node:crypto';
import type { PlanQuery } from './meal-plan.contracts.js';

const day = 86_400_000;
export function planRange(selection: PlanQuery) {
    if (selection.view === 'range') return { startsOn: selection.date, endsOn: selection.endDate! };
    const selected = new Date(`${selection.date}T00:00:00Z`);
    if (selection.view === 'calendar') {
        const start = new Date(Date.UTC(selected.getUTCFullYear(), selected.getUTCMonth(), 1));
        const end = new Date(Date.UTC(selected.getUTCFullYear(), selected.getUTCMonth() + 1, 0));
        return { startsOn: start.toISOString().slice(0, 10), endsOn: end.toISOString().slice(0, 10) };
    }
    const start = new Date(selected);
    if (selection.view === 'week') {
        const weekday = (start.getUTCDay() + 6) % 7;
        start.setUTCDate(start.getUTCDate() - weekday);
    }
    const end = new Date(start.getTime() + (selection.view === 'week' ? 6 : 0) * day);
    return { startsOn: start.toISOString().slice(0, 10), endsOn: end.toISOString().slice(0, 10) };
}
export function weeklyDates(startsOn: string, endsOn: string, weekdays: readonly number[]) {
    const selected = new Set(weekdays);
    const result: string[] = [];
    for (let value = startsOn; value <= endsOn;) {
        const instant = new Date(`${value}T12:00:00Z`);
        if (selected.has(instant.getUTCDay())) result.push(value);
        instant.setUTCDate(instant.getUTCDate() + 1);
        value = instant.toISOString().slice(0, 10);
    }
    return result;
}
function signature(value: unknown, expires: number) {
    return createHash('sha256').update(JSON.stringify({ value, expires })).digest('hex').slice(0, 48);
}
export function createPlanToken(value: unknown, now = Date.now()) {
    const expires = now + 10 * 60_000;
    return {
        token: `${expires.toString(16).padStart(16, '0')}${signature(value, expires)}`,
        expiresAt: new Date(expires).toISOString(),
    };
}
export function validPlanToken(token: string, value: unknown, now = Date.now()) {
    const expires = Number.parseInt(token.slice(0, 16), 16);
    if (!Number.isSafeInteger(expires) || expires < now || expires > now + 10 * 60_000) return false;
    return token === `${expires.toString(16).padStart(16, '0')}${signature(value, expires)}`;
}
