import { ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

export const BACKUP_RECOVERY_CONTRACT_VERSION = 4 as const;
const checksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const opaqueLocatorSchema = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{2,299}$/)
    .refine((value) => !value.includes('..') && !value.includes('//'));
const artifactKindSchema = z.enum([
    'postgres_custom_dump',
    'media_archive',
    'media_manifest',
    'migration_manifest',
    'grants_manifest',
]);
export const recoveryArtifactSchema = z.strictObject({
    kind: artifactKindSchema,
    artifactId: z.uuid(),
    locator: opaqueLocatorSchema,
    createdAt: z.iso.datetime(),
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    checksum: checksumSchema,
    encrypted: z.literal(true),
    immutable: z.literal(true),
    offsite: z.literal(true),
    retentionPolicyVersion: z.number().int().positive(),
});
export const recoveryPolicySchema = z.strictObject({
    policyVersion: z.number().int().positive(),
    rpoSeconds: z.number().int().min(60).max(604_800),
    rtoSeconds: z.number().int().min(60).max(604_800),
    approvedAt: z.iso.datetime(),
    approvedByRole: z.enum(['owner', 'operations']),
});
export const recoverySetSchema = z
    .strictObject({
        contractVersion: z.literal(BACKUP_RECOVERY_CONTRACT_VERSION),
        state: z.literal('ready'),
        database: z.literal('meal_planner_postgres'),
        postgresMajor: z.literal(18),
        schemaVersion: z.literal(26),
        migrationManifestChecksum: checksumSchema,
        snapshotAt: z.iso.datetime(),
        secrets: z.literal('excluded'),
        artifacts: z.array(recoveryArtifactSchema).length(5),
    })
    .superRefine((value, context) => {
        const kinds = value.artifacts.map((artifact) => artifact.kind);
        for (const kind of artifactKindSchema.options)
            if (kinds.filter((candidate) => candidate === kind).length !== 1)
                context.addIssue({ code: 'custom', path: ['artifacts'], message: `Expected exactly one ${kind}` });
    });
export type RecoverySet = z.infer<typeof recoverySetSchema>;

export const restoreDrillPlanSchema = z.strictObject({
    contractVersion: z.literal(BACKUP_RECOVERY_CONTRACT_VERSION),
    targetEnvironment: z.literal('ephemeral_test'),
    targetDatabase: z.literal('meal_planner_postgres'),
    isolatedTarget: z.literal(true),
    emptyTargetConfirmed: z.literal(true),
    sourceMutationAllowed: z.literal(false),
    timeoutSeconds: z.number().int().min(300).max(14_400),
    changeTicket: z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/),
    policyVersion: z.number().int().positive(),
    recoverySet: recoverySetSchema,
});
export const restoreDrillEvidenceSchema = z
    .strictObject({
        contractVersion: z.literal(BACKUP_RECOVERY_CONTRACT_VERSION),
        outcome: z.enum(['passed', 'failed', 'unknown']),
        sourceUnchanged: z.literal(true),
        policyVersion: z.number().int().positive(),
        recoverySetSnapshotAt: z.iso.datetime(),
        migrationManifestChecksum: checksumSchema,
        measuredRestoreSeconds: z.number().int().nonnegative().max(86_400),
        recoveredSnapshotAt: z.iso.datetime(),
        gates: z.strictObject({
            artifactHashes: z.boolean(),
            schemaVersion: z.boolean(),
            tableCount209: z.boolean(),
            foreignKeyCount482: z.boolean(),
            applicationRole: z.boolean(),
            domainSmoke: z.boolean(),
            mediaCoverage: z.boolean(),
        }),
    })
    .superRefine((value, context) => {
        if (value.outcome === 'passed' && Object.values(value.gates).some((passed) => !passed))
            context.addIssue({ code: 'custom', path: ['outcome'], message: 'Every recovery gate must pass' });
    });

export interface BackupProvider {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    lookup(id: string): Promise<RecoverySet>;
}
export class DisabledBackupProvider implements BackupProvider {
    status() {
        return { configured: false, provider: null } as const;
    }
    lookup(id: string): Promise<RecoverySet> {
        void id;
        return Promise.reject(new ServiceUnavailableException('Backup provider is not configured'));
    }
}

export function recoveryReadiness(input: { policy: unknown; recoverySet: unknown; lastDrill: unknown; clock?: Date }) {
    const policy = recoveryPolicySchema.safeParse(input.policy);
    if (!policy.success) return { status: 'blocked', reason: 'objectives_unapproved' } as const;
    const set = recoverySetSchema.safeParse(input.recoverySet);
    if (!set.success) return { status: 'blocked', reason: 'backup_unavailable' } as const;
    const drill = restoreDrillEvidenceSchema.safeParse(input.lastDrill);
    if (!drill.success || drill.data.outcome !== 'passed')
        return { status: 'blocked', reason: 'restore_unproven' } as const;
    if (
        drill.data.policyVersion !== policy.data.policyVersion ||
        drill.data.recoverySetSnapshotAt !== set.data.snapshotAt ||
        drill.data.recoveredSnapshotAt !== set.data.snapshotAt ||
        drill.data.migrationManifestChecksum !== set.data.migrationManifestChecksum
    )
        return { status: 'blocked', reason: 'restore_unproven' } as const;
    const clock = input.clock ?? new Date();
    if ((clock.getTime() - Date.parse(set.data.snapshotAt)) / 1000 > policy.data.rpoSeconds)
        return { status: 'blocked', reason: 'rpo_exceeded' } as const;
    if (drill.data.measuredRestoreSeconds > policy.data.rtoSeconds)
        return { status: 'blocked', reason: 'rto_exceeded' } as const;
    return { status: 'ready', reason: 'verified' } as const;
}
