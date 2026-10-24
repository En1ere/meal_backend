import { z } from 'zod';
export const sanctionCategories = [
    'spam',
    'harassment',
    'discrimination',
    'privacy',
    'copyright',
    'dangerous',
    'inappropriate',
    'fraud',
    'evasion',
    'other',
    'rules',
] as const;
export const governanceParamsSchema = z.strictObject({
    section: z.enum(['users', 'sanctions', 'access']),
    id: z.string().uuid(),
});
export const governanceCommandSchema = z
    .strictObject({
        version: z
            .string()
            .regex(/^[1-9][0-9]*$/)
            .max(19),
        idempotencyKey: z.string().uuid(),
        action: z.enum(['ban', 'revoke', 'extend', 'grantModerator', 'revokeRole', 'acceptAppeal', 'rejectAppeal']),
        appealId: z.string().uuid().optional(),
        appealVersion: z
            .string()
            .regex(/^[1-9][0-9]*$/)
            .max(19)
            .optional(),
        category: z.enum(sanctionCategories).nullable(),
        scope: z.enum(['account', 'ai', 'publications', 'comments']),
        startsAt: z.string().datetime().nullable(),
        endsAt: z.string().datetime().nullable(),
        reason: z.string().trim().min(1).max(5000),
        privateNote: z.string().trim().max(5000),
        allowTemporaryBan: z.boolean(),
        subscriptionDisposition: z.enum(['keep', 'transfer']),
        subscriptionRecipientUserId: z.string().uuid().nullable(),
        confirmed: z.literal(true),
    })
    .superRefine((input, context) => {
        if (input.action === 'ban' && !input.category)
            context.addIssue({ code: 'custom', path: ['category'], message: 'Выберите категорию причины' });
        if (input.subscriptionDisposition === 'transfer' && !input.subscriptionRecipientUserId)
            context.addIssue({
                code: 'custom',
                path: ['subscriptionRecipientUserId'],
                message: 'Выберите получателя Plus',
            });
        if (input.subscriptionDisposition === 'keep' && input.subscriptionRecipientUserId)
            context.addIssue({ code: 'custom', path: ['subscriptionRecipientUserId'], message: 'Получатель не нужен' });
        if ((input.action !== 'ban' || input.scope !== 'account') && input.subscriptionDisposition !== 'keep')
            context.addIssue({
                code: 'custom',
                path: ['subscriptionDisposition'],
                message: 'Передача доступна только при бане аккаунта',
            });
        if (['acceptAppeal', 'rejectAppeal'].includes(input.action) && (!input.appealId || !input.appealVersion))
            context.addIssue({ code: 'custom', path: ['appealId'], message: 'Выберите актуальную апелляцию' });
    });
export const governanceResultSchema = z.strictObject({ id: z.string().uuid(), version: z.string() });
export const governanceViewSchema = z.strictObject({
    id: z.string().uuid(),
    version: z.string(),
    userId: z.string().uuid(),
    name: z.string(),
    role: z.string().nullable(),
    soleAdmin: z.boolean(),
    scope: z.string().nullable(),
    endsAt: z.string().nullable(),
    status: z.string(),
    appeals: z.array(
        z.strictObject({
            id: z.string().uuid(),
            version: z.string(),
            body: z.string(),
            status: z.string(),
            response: z.string().nullable(),
            submittedAt: z.string(),
            resolvedAt: z.string().nullable(),
        }),
    ),
    history: z.array(z.strictObject({ action: z.string(), reason: z.string(), at: z.string() })),
    familySubscription: z
        .strictObject({
            subscriptionId: z.string().uuid(),
            familyId: z.string().uuid(),
            familyName: z.string(),
            candidates: z.array(
                z.strictObject({ userId: z.string().uuid(), displayName: z.string(), login: z.string() }),
            ),
        })
        .nullable(),
});
