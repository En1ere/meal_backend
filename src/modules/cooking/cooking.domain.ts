import { HttpException } from '@nestjs/common';
import type { z } from 'zod';
import type { cookingProgressSchema, CookingAttempt } from './cooking.contracts.js';
import { decimal, decimalText } from '../inventory/inventory.domain.js';
export function cookingReminderSchedule(startedAt: string, timezone?: string) {
    const start = Date.parse(startedAt);
    if (!Number.isFinite(start)) throw new Error('Invalid cooking start');
    return {
        firstReminderAt: timezone
            ? cookingNotificationTime(start + 2 * 86400000, timezone)
            : new Date(start + 2 * 86400000).toISOString(),
        secondReminderAt: timezone
            ? cookingNotificationTime(start + 4 * 86400000, timezone)
            : new Date(start + 4 * 86400000).toISOString(),
        archiveAt: new Date(start + 6 * 86400000).toISOString(),
        quietHours: { start: '22:00', end: '09:00' } as const,
    };
}

export function cookingNotificationTime(timestamp: number, timezone: string): string {
    const format = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    });
    const localHour = (at: number) => Number(format.formatToParts(at).find((p) => p.type === 'hour')!.value);
    const hour = localHour(timestamp);
    if (hour >= 9 && hour < 22) return new Date(timestamp).toISOString();
    // Search real instants, rather than treating an IANA zone as a fixed UTC offset: DST can change overnight.
    const firstMinute = Math.ceil(timestamp / 60000) * 60000;
    for (let at = firstMinute; at <= firstMinute + 48 * 3600000; at += 60000) {
        const candidate = localHour(at);
        if (candidate >= 9 && candidate < 22) return new Date(at).toISOString();
    }
    throw new Error('No cooking notification delivery window');
}

export function cookingArchiveHiddenAt(archivedAt: string): string {
    const date = new Date(archivedAt),
        day = date.getUTCDate();
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid cooking archive date');
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last));
    return date.toISOString();
}

export function consumedRemainder(quantity: string | null, used: string): string {
    if (quantity === null) throw new HttpException('Сначала уточните остаток партии', 409);
    const remainder = decimal(quantity) - decimal(used);
    if (decimal(used) <= 0n || remainder < 0n) throw new HttpException('Недостаточно продукта в партии', 422);
    return decimalText(remainder);
}
export function progressAttempt(
    attempt: CookingAttempt,
    input: z.infer<typeof cookingProgressSchema>,
    now: number,
): CookingAttempt {
    if (attempt.version !== input.version) throw new HttpException('Приготовление изменилось', 412);
    if (!['active', 'paused'].includes(attempt.status)) throw new HttpException('Приготовление уже завершено', 409);
    if (
        new Set(input.steps.map((s) => s.position)).size !== input.steps.length ||
        input.steps.some((s) => !attempt.steps.some((a) => a.position === s.position))
    )
        throw new HttpException('Неизвестный или повторяющийся шаг', 422);
    const next = structuredClone(attempt);
    next.version++;
    next.status = input.status;
    for (const step of input.steps)
        Object.assign(
            next.steps.find((s) => s.position === step.position)!,
            step,
        );
    if (input.timer) {
        const step = next.steps.find((s) => s.position === input.timer!.position);
        if (!step) throw new HttpException('Шаг не найден', 422);
        const timer = input.timer;
        const remaining = step.timerDeadline
            ? Math.max(0, Math.ceil((Date.parse(step.timerDeadline) - now) / 1000))
            : (step.timerPausedSeconds ?? 0);
        if (timer.action === 'start' || timer.action === 'resume') {
            const seconds = timer.action === 'resume' ? remaining : (timer.seconds ?? step.durationSeconds ?? 0);
            if (seconds <= 0) throw new HttpException('Укажите положительное время таймера', 422);
            for (const other of next.steps) {
                other.timerDeadline = null;
                other.timerPausedSeconds = null;
            }
            step.timerDeadline = new Date(now + seconds * 1000).toISOString();
        } else if (timer.action === 'pause') {
            step.timerDeadline = null;
            step.timerPausedSeconds = remaining;
        } else if (timer.action === 'reset') {
            step.timerDeadline = null;
            step.timerPausedSeconds = null;
        } else {
            const seconds = Math.max(0, remaining + (timer.seconds ?? 0));
            if (step.timerDeadline) step.timerDeadline = new Date(now + seconds * 1000).toISOString();
            else step.timerPausedSeconds = seconds;
        }
    }
    if (input.status === 'cancelled')
        for (const step of next.steps) {
            step.timerDeadline = null;
            step.timerPausedSeconds = null;
        }
    return next;
}
