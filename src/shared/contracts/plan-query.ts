import { z } from 'zod';

export const planViewSchema = z.enum(['day', 'week', 'range', 'calendar']);
export const planDateSchema = z.iso.date();
export const planTimezoneSchema = z
    .string()
    .min(1)
    .max(100)
    .regex(/^(?![+-])/, 'Укажите именованный часовой пояс IANA')
    .refine((value) => {
        try {
            new Intl.DateTimeFormat('en', { timeZone: value });
            return true;
        } catch {
            return false;
        }
    }, 'Неизвестный часовой пояс');

export const planQuerySchema = z
    .object({
        scope: z.enum(['private', 'family']).default('private'),
        view: planViewSchema.default('week'),
        date: planDateSchema,
        endDate: planDateSchema.optional(),
        timezone: planTimezoneSchema,
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.view === 'range' && !value.endDate)
            ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Укажите конец периода' });
        if (value.endDate && value.endDate < value.date)
            ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Конец периода раньше начала' });
        if (value.endDate) {
            const days = Math.round(
                (Date.parse(`${value.endDate}T00:00:00Z`) - Date.parse(`${value.date}T00:00:00Z`)) / 86400000,
            );
            if (days > 366)
                ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Период не может быть больше года' });
        }
    });
