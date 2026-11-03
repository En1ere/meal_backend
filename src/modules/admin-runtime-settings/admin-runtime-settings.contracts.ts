import { z } from 'zod';

export const runtimeSettingsTabSchema = z.enum([
    'notifications',
    'mail',
    'storage',
    'security',
    'deploy_backup',
    'backup_recovery',
    'integrations',
    'legal',
]);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const webPushPolicyInputSchema = z
    .strictObject({
        quietHours: z.strictObject({ start: clock, end: clock }),
        ttlSeconds: z.strictObject({
            critical: z.number().int().min(0).max(86400),
            important: z.number().int().min(0).max(86400),
            informational: z.number().int().min(0).max(86400),
            marketing: z.number().int().min(0).max(86400),
        }),
        expectedVersion: z.number().int().positive(),
    })
    .refine((value) => value.quietHours.start !== value.quietHours.end, { path: ['quietHours'] });
export const webPushPolicyExecuteSchema = webPushPolicyInputSchema
    .extend({
        previewId: z.uuid(),
        idempotencyKey: z.uuid(),
    })
    .strict();
export type WebPushPolicyInput = z.infer<typeof webPushPolicyInputSchema>;
const policyOutput = z.strictObject({
    quietHours: z.strictObject({ start: clock, end: clock }),
    ttlSeconds: webPushPolicyInputSchema.shape.ttlSeconds,
    version: z.number().int().positive(),
});
const historyItem = z.strictObject({ at: z.iso.datetime(), actor: z.string(), summary: z.string() });
export const runtimeSettingsSchema = z.strictObject({
    generatedAt: z.iso.datetime(),
    completeness: z.enum(['complete', 'partial']),
    unavailableSources: z.array(z.string()),
    tabs: z.array(z.strictObject({ code: runtimeSettingsTabSchema, label: z.string() })),
    selectedTab: runtimeSettingsTabSchema,
    entries: z.array(
        z.strictObject({
            key: z.string(),
            label: z.string(),
            description: z.string(),
            value: z.string(),
            status: z.enum(['active', 'disabled', 'partial', 'blocked']),
            source: z.enum(['database', 'environment', 'vps_secret', 'github_secret', 'derived']),
            readiness: z.enum(['ready', 'owner_input', 'external_dependency', 'disabled']),
            editable: z.boolean(),
            sensitive: z.boolean(),
            updatedAt: z.iso.datetime().nullable(),
            version: z.number().int().positive().nullable(),
            blockers: z.array(z.string()),
            affectedServices: z.array(z.string()),
            checks: z.array(z.string()),
            instruction: z.string().nullable(),
            history: z.array(historyItem).max(20),
            secret: z
                .strictObject({
                    configured: z.boolean(),
                    fingerprint: z.string().nullable(),
                    rotatedAt: z.iso.datetime().nullable(),
                })
                .nullable(),
            policy: policyOutput.nullable(),
        }),
    ),
});
export const webPushPolicyPreviewSchema = z.strictObject({
    previewId: z.uuid(),
    expiresAt: z.iso.datetime(),
    changes: z.array(z.strictObject({ field: z.string(), from: z.string().nullable(), to: z.string() })),
    policy: policyOutput,
});
export const webPushPolicyResultSchema = z.strictObject({ policy: policyOutput, updatedAt: z.iso.datetime() });
