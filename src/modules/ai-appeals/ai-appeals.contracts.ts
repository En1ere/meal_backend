import { z } from 'zod';
import { supportMessageSchema, supportTicketSchema } from '../support/support.contracts.js';

export const aiRestrictionSchema = z.strictObject({
    id: z.uuid(),
    status: z.enum(['scheduled', 'active', 'expired', 'revoked']),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime().nullable(),
    reasonCategory: z.literal('safety_policy'),
    reasonLabel: z.literal('Ограничение по правилам безопасного использования AI'),
});

export const aiAppealStatusSchema = z.enum(['pending', 'accepted', 'rejected']);
export const aiAppealSummarySchema = z.strictObject({
    id: z.uuid(),
    sanctionId: z.uuid(),
    status: aiAppealStatusSchema,
    submittedAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
    response: z.string().nullable(),
    version: z.number().int().positive(),
    ticket: supportTicketSchema,
});
export const aiAppealsListSchema = z.strictObject({
    restriction: aiRestrictionSchema.nullable(),
    items: z.array(aiAppealSummarySchema),
});
export const aiAppealDetailSchema = z.strictObject({
    restriction: aiRestrictionSchema,
    appeal: aiAppealSummarySchema,
    messages: z.array(supportMessageSchema),
});
export const aiAppealCreateSchema = z.strictObject({
    sanctionId: z.uuid(),
    body: z.string().trim().min(1).max(10000),
    idempotencyKey: z.uuid(),
});
