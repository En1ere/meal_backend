import { z } from 'zod';

export const familyNotesQuerySchema = z.strictObject({
    q: z.string().trim().max(100).default(''),
    tab: z.enum(['active', 'archived']).default('active'),
});
export const noteItemInputSchema = z.strictObject({
    id: z.uuid().optional(),
    text: z.string().trim().min(1).max(500),
});
export const familyNoteCreateSchema = z
    .strictObject({
        kind: z.enum(['note', 'checklist']),
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().max(10_000),
        items: z.array(noteItemInputSchema).max(200),
        idempotencyKey: z.uuid(),
    })
    .superRefine((value, ctx) => {
        if (value.kind === 'note' && value.items.length)
            ctx.addIssue({ code: 'custom', path: ['items'], message: 'У текстовой заметки нет пунктов' });
        if (value.kind === 'checklist' && !value.items.length)
            ctx.addIssue({ code: 'custom', path: ['items'], message: 'Добавьте хотя бы один пункт' });
    });
export const familyNoteUpdateSchema = familyNoteCreateSchema.extend({ expectedVersion: z.number().int().positive() });
export const familyNoteArchiveSchema = z.strictObject({
    expectedVersion: z.number().int().positive(),
    archived: z.boolean(),
    idempotencyKey: z.uuid(),
});
export const familyNoteToggleSchema = z.strictObject({
    expectedNoteVersion: z.number().int().positive(),
    expectedItemVersion: z.number().int().positive(),
    checked: z.boolean(),
    idempotencyKey: z.uuid(),
});
export const familyNoteItemSchema = z.strictObject({
    id: z.uuid(),
    position: z.number().int().nonnegative(),
    text: z.string(),
    checked: z.boolean(),
    checkedAt: z.iso.datetime().nullable(),
    checkedBy: z.strictObject({ userId: z.uuid(), displayName: z.string() }).nullable(),
    version: z.number().int().positive(),
});
export const familyNoteSchema = z.strictObject({
    id: z.uuid(),
    kind: z.enum(['note', 'checklist']),
    title: z.string(),
    body: z.string(),
    author: z.strictObject({ userId: z.uuid(), displayName: z.string() }),
    canEdit: z.boolean(),
    archivedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    version: z.number().int().positive(),
    items: z.array(familyNoteItemSchema),
});
export const familyNotesSchema = z.strictObject({ items: z.array(familyNoteSchema) });
export const familyNoteRevisionSchema = z.strictObject({
    id: z.uuid(),
    revision: z.number().int().positive(),
    actor: z.strictObject({ userId: z.uuid(), displayName: z.string() }),
    recordedAt: z.iso.datetime(),
    snapshot: z.strictObject({
        title: z.string(),
        body: z.string(),
        kind: z.enum(['note', 'checklist']),
        archived: z.boolean(),
        items: z.array(z.strictObject({ id: z.uuid(), text: z.string(), checked: z.boolean() })),
    }),
});
export const familyNoteHistorySchema = z.strictObject({ items: z.array(familyNoteRevisionSchema) });
