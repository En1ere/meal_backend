import { z } from 'zod';
import {
    aiContextSourceKindSchema,
    aiOperationFinancialStateSchema,
    aiOperationStateSchema,
    aiTaskClassSchema,
    aiTaskTypeSchema,
} from '../ai/public.js';

const boundedCount = z.number().int().min(0).max(1_000_000_000);
const money = z.string().regex(/^\d{1,7}\.\d{8}$/);
const usageSchema = z.strictObject({
    tasks: boundedCount,
    actions: boundedCount,
    completed: boundedCount,
    refunded: boundedCount,
    failed: boundedCount,
});

export const adminAiControlPlaneSchema = z.strictObject({
    schemaVersion: z.literal(3),
    generatedAt: z.iso.datetime(),
    executionAvailable: z.boolean(),
    provider: z.strictObject({
        configured: z.boolean(),
        kind: z.enum(['disabled', 'openai_compatible']),
        model: z.string().nullable(),
        profileVersion: z.string().nullable(),
        monthlyBudgetUsd: money.nullable(),
    }),
    policies: z.strictObject({
        task: z.strictObject({ version: z.string(), effectiveAt: z.iso.datetime().nullable() }),
        context: z.strictObject({ version: z.string(), effectiveAt: z.iso.datetime().nullable() }),
    }),
    usage: z.strictObject({ last24Hours: usageSchema, last30Days: usageSchema }),
    cost: z.strictObject({
        monthStartsAt: z.iso.datetime(),
        actualUsd: money,
        heldUsd: money,
        spentOrHeldUsd: money,
        remainingUsd: money.nullable(),
        utilizationPercent: z.number().min(0).max(100_000).nullable(),
        stopLossState: z.enum(['unconfigured', 'disabled', 'ready', 'exhausted']),
    }),
    statuses: z.array(
        z.strictObject({
            status: z.enum(['preview', 'processing', 'completed', 'failed', 'refunded']),
            count: boundedCount,
        }),
    ),
    operations: z.strictObject({
        lifecycle: z.array(z.strictObject({ state: aiOperationStateSchema, count: boundedCount })),
        financial: z.array(z.strictObject({ state: aiOperationFinancialStateSchema, count: boundedCount })),
        oldestQueuedAt: z.iso.datetime().nullable(),
        oldestRunningAt: z.iso.datetime().nullable(),
        unknownCount: boundedCount,
        reconciliationHoldCount: boundedCount,
    }),
    tasks: z.array(
        z.strictObject({
            code: aiTaskTypeSchema,
            label: z.string().min(1),
            taskClass: aiTaskClassSchema,
            cost: z.number().int().min(1).max(5),
            availableOn: z.array(z.enum(['free', 'plus', 'pro'])).max(3),
            requiredContext: z.array(aiContextSourceKindSchema),
            optionalContext: z.array(aiContextSourceKindSchema),
        }),
    ),
});

export type AdminAiControlPlane = z.infer<typeof adminAiControlPlaneSchema>;
