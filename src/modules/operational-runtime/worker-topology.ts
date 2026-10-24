import { z } from 'zod';

export const WORKER_TOPOLOGY_VERSION = 1 as const;

export const workerTaskIdSchema = z.enum([
    'scheduled-news',
    'incident-ignore-expiry',
    'retention-inspection',
    'scheduled-sanctions',
    'diary-portions',
    'email-changes',
    'exports',
    'account-retention',
    'ai-reconciliation',
    'cooking-lifecycle',
]);
export type WorkerTaskId = z.infer<typeof workerTaskIdSchema>;

const requirementSchema = z.enum([
    'database',
    'application_grants',
    'published_retention_policy',
    'admin_approval',
    'legal_hold_check',
    'object_storage',
]);

export const workerTaskDefinitionSchema = z.strictObject({
    id: workerTaskIdSchema,
    executionMode: z.enum(['external_one_shot', 'embedded_interval']),
    argv: z.array(z.string().min(1).max(200)).min(2).max(8).nullable(),
    activationEnvironment: z.enum(['AI_RECONCILIATION_ENABLED', 'COOKING_LIFECYCLE_ENABLED']).nullable(),
    defaultEnabled: z.literal(false),
    mutating: z.boolean(),
    destructive: z.boolean(),
    overlapPolicy: z.enum(['skip_locked', 'state_recheck', 'deduplicated_partition', 'inspection_only']),
    batchLimit: z.number().int().min(1).max(1_000),
    timeoutSeconds: z.number().int().min(10).max(3_600),
    minimumIntervalSeconds: z.number().int().min(60).max(86_400),
    requirements: z.array(requirementSchema).min(1).max(6),
});
export type WorkerTaskDefinition = z.infer<typeof workerTaskDefinitionSchema>;

export const workerTopologySchema = z
    .strictObject({
        version: z.literal(WORKER_TOPOLOGY_VERSION),
        tasks: z.array(workerTaskDefinitionSchema).length(workerTaskIdSchema.options.length),
    })
    .superRefine((value, context) => {
        const ids = value.tasks.map((task) => task.id);
        if (new Set(ids).size !== ids.length)
            context.addIssue({ code: 'custom', path: ['tasks'], message: 'Worker task identifiers must be unique' });
        for (const id of workerTaskIdSchema.options) {
            if (!ids.includes(id))
                context.addIssue({ code: 'custom', path: ['tasks'], message: `Missing worker task: ${id}` });
        }
        for (const [index, task] of value.tasks.entries()) {
            if (task.executionMode === 'external_one_shot' && (!task.argv || task.activationEnvironment))
                context.addIssue({
                    code: 'custom',
                    path: ['tasks', index],
                    message: 'External workers require argv and cannot use an activation environment variable',
                });
            if (task.executionMode === 'embedded_interval' && (task.argv || !task.activationEnvironment))
                context.addIssue({
                    code: 'custom',
                    path: ['tasks', index],
                    message: 'Embedded workers require an activation environment variable and cannot expose argv',
                });
            if (task.destructive && !task.requirements.includes('admin_approval'))
                context.addIssue({
                    code: 'custom',
                    path: ['tasks', index, 'requirements'],
                    message: 'Destructive workers require administrative approval',
                });
        }
    });

const commonRequirements = ['database', 'application_grants'] as const;
const topology = workerTopologySchema.parse({
    version: WORKER_TOPOLOGY_VERSION,
    tasks: [
        {
            id: 'scheduled-news',
            executionMode: 'external_one_shot',
            argv: ['node', 'scripts/process-operational-maintenance.mjs', 'news', '--apply'],
            activationEnvironment: null,
            defaultEnabled: false,
            mutating: true,
            destructive: false,
            overlapPolicy: 'skip_locked',
            batchLimit: 25,
            timeoutSeconds: 120,
            minimumIntervalSeconds: 60,
            requirements: commonRequirements,
        },
        {
            id: 'incident-ignore-expiry',
            executionMode: 'external_one_shot',
            argv: ['node', 'scripts/process-operational-maintenance.mjs', 'incidents', '--apply'],
            activationEnvironment: null,
            defaultEnabled: false,
            mutating: true,
            destructive: false,
            overlapPolicy: 'skip_locked',
            batchLimit: 250,
            timeoutSeconds: 120,
            minimumIntervalSeconds: 300,
            requirements: commonRequirements,
        },
        {
            id: 'retention-inspection',
            executionMode: 'external_one_shot',
            argv: ['node', 'scripts/process-operational-maintenance.mjs', 'retention', '--apply'],
            activationEnvironment: null,
            defaultEnabled: false,
            mutating: false,
            destructive: false,
            overlapPolicy: 'inspection_only',
            batchLimit: 1,
            timeoutSeconds: 300,
            minimumIntervalSeconds: 86_400,
            requirements: [...commonRequirements, 'published_retention_policy'],
        },
        {
            id: 'scheduled-sanctions',
            executionMode: 'external_one_shot',
            argv: ['node', 'scripts/process-operational-maintenance.mjs', 'sanctions', '--apply'],
            activationEnvironment: null,
            defaultEnabled: false,
            mutating: true,
            destructive: false,
            overlapPolicy: 'state_recheck',
            batchLimit: 50,
            timeoutSeconds: 120,
            minimumIntervalSeconds: 60,
            requirements: commonRequirements,
        },
        {
            id: 'diary-portions',
            executionMode: 'external_one_shot',
            argv: ['node', 'scripts/process-operational-maintenance.mjs', 'diary-portions', '--apply'],
            activationEnvironment: null,
            defaultEnabled: false,
            mutating: true,
            destructive: false,
            overlapPolicy: 'state_recheck',
            batchLimit: 100,
            timeoutSeconds: 120,
            minimumIntervalSeconds: 60,
            requirements: commonRequirements,
        },
        {
            id: 'email-changes',
            executionMode: 'external_one_shot',
            argv: ['node', 'scripts/process-email-changes.mjs', '--apply'],
            activationEnvironment: null,
            defaultEnabled: false,
            mutating: true,
            destructive: false,
            overlapPolicy: 'state_recheck',
            batchLimit: 100,
            timeoutSeconds: 120,
            minimumIntervalSeconds: 60,
            requirements: commonRequirements,
        },
        {
            id: 'exports',
            executionMode: 'external_one_shot',
            argv: ['node', 'scripts/process-exports.mjs', '--apply'],
            activationEnvironment: null,
            defaultEnabled: false,
            mutating: true,
            destructive: false,
            overlapPolicy: 'skip_locked',
            batchLimit: 10,
            timeoutSeconds: 900,
            minimumIntervalSeconds: 60,
            requirements: [...commonRequirements, 'object_storage'],
        },
        {
            id: 'account-retention',
            executionMode: 'external_one_shot',
            argv: ['node', 'scripts/process-account-retention.mjs', '--apply'],
            activationEnvironment: null,
            defaultEnabled: false,
            mutating: true,
            destructive: true,
            overlapPolicy: 'state_recheck',
            batchLimit: 25,
            timeoutSeconds: 900,
            minimumIntervalSeconds: 86_400,
            requirements: [...commonRequirements, 'published_retention_policy', 'admin_approval', 'legal_hold_check'],
        },
        {
            id: 'ai-reconciliation',
            executionMode: 'embedded_interval',
            argv: null,
            activationEnvironment: 'AI_RECONCILIATION_ENABLED',
            defaultEnabled: false,
            mutating: true,
            destructive: false,
            overlapPolicy: 'state_recheck',
            batchLimit: 100,
            timeoutSeconds: 60,
            minimumIntervalSeconds: 60,
            requirements: commonRequirements,
        },
        {
            id: 'cooking-lifecycle',
            executionMode: 'embedded_interval',
            argv: null,
            activationEnvironment: 'COOKING_LIFECYCLE_ENABLED',
            defaultEnabled: false,
            mutating: true,
            destructive: false,
            overlapPolicy: 'deduplicated_partition',
            batchLimit: 200,
            timeoutSeconds: 60,
            minimumIntervalSeconds: 60,
            requirements: commonRequirements,
        },
    ],
});

export function workerTopology(): Readonly<z.infer<typeof workerTopologySchema>> {
    return structuredClone(topology);
}

export const workerInvocationRequestSchema = z.strictObject({
    topologyVersion: z.literal(WORKER_TOPOLOGY_VERSION),
    task: workerTaskIdSchema,
    deploymentId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    requestedAt: z.iso.datetime(),
    apply: z.literal(true),
    maxItems: z.number().int().positive(),
    timeoutSeconds: z.number().int().positive(),
    destructiveApproval: z
        .strictObject({
            changeTicket: z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/),
            policyVersion: z.number().int().positive(),
        })
        .nullable(),
});
export type WorkerInvocationRequest = z.infer<typeof workerInvocationRequestSchema>;

export const workerInvocationPlanSchema = workerInvocationRequestSchema.omit({ apply: true }).extend({
    executionMode: workerTaskDefinitionSchema.shape.executionMode,
    argv: workerTaskDefinitionSchema.shape.argv,
    overlapPolicy: workerTaskDefinitionSchema.shape.overlapPolicy,
    mutating: z.boolean(),
    destructive: z.boolean(),
});
export type WorkerInvocationPlan = z.infer<typeof workerInvocationPlanSchema>;

export class WorkerTopologyError extends Error {
    constructor(public readonly code: 'not_one_shot' | 'limit_exceeded' | 'approval_required') {
        super(code);
    }
}

export function planWorkerInvocation(raw: unknown): WorkerInvocationPlan {
    const request = workerInvocationRequestSchema.parse(raw);
    const task = topology.tasks.find((candidate) => candidate.id === request.task)!;
    if (task.executionMode !== 'external_one_shot') throw new WorkerTopologyError('not_one_shot');
    if (request.maxItems > task.batchLimit || request.timeoutSeconds > task.timeoutSeconds)
        throw new WorkerTopologyError('limit_exceeded');
    if (task.destructive && !request.destructiveApproval) throw new WorkerTopologyError('approval_required');
    if (!task.destructive && request.destructiveApproval) throw new WorkerTopologyError('approval_required');
    return workerInvocationPlanSchema.parse({
        topologyVersion: request.topologyVersion,
        task: request.task,
        deploymentId: request.deploymentId,
        requestedAt: request.requestedAt,
        maxItems: request.maxItems,
        timeoutSeconds: request.timeoutSeconds,
        destructiveApproval: request.destructiveApproval,
        executionMode: task.executionMode,
        argv: task.argv,
        overlapPolicy: task.overlapPolicy,
        mutating: task.mutating,
        destructive: task.destructive,
    });
}
