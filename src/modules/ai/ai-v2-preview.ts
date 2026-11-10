import { createHash, randomUUID } from 'node:crypto';
import type { PlanCode } from '../entitlements/public.js';
import {
    aiV2FrozenPreviewSchema,
    aiV2PreviewSchema,
    parseAiV2PreviewRequest,
    type AiV2FrozenPreview,
    type AiV2Preview,
} from './ai-v2.contracts.js';
import {
    AI_CACHE_POLICY_V1,
    AI_CONTEXT_POLICY_V2,
    AI_PRICE_POLICY_V1,
    AI_ROUTING_POLICY_V1,
    AI_SAFETY_POLICY_V1,
    AI_TASK_POLICY_V4,
    aiTaskModeV4,
} from './ai-policy-v4.js';

export type AiV2OfferedSource = {
    id: string;
    label: string;
    itemCount: number;
    truncated: boolean;
};

export type AiV2PreviewEnvironment = {
    plan: PlanCode;
    offeredSources: readonly AiV2OfferedSource[];
    readyProviderProfileVersions: ReadonlySet<string>;
    sourceSnapshotHash: string;
    now?: Date;
    previewId?: string;
};

export type AiV2PreparedPreview = {
    preview: AiV2Preview;
    frozen: AiV2FrozenPreview;
};

export type AiV2PreviewPolicyErrorCode =
    | 'task_mode_unavailable'
    | 'plan_required'
    | 'source_not_offered'
    | 'provider_profile_unavailable'
    | 'input_too_large';

export class AiV2PreviewPolicyError extends Error {
    constructor(readonly code: AiV2PreviewPolicyErrorCode) {
        super(code);
    }
}

const planRank: Record<PlanCode, number> = { free: 0, plus: 1, pro: 2 };

export function prepareAiV2Preview(raw: unknown, environment: AiV2PreviewEnvironment): AiV2PreparedPreview {
    let request: ReturnType<typeof parseAiV2PreviewRequest>;
    try {
        request = parseAiV2PreviewRequest(raw);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('AI task/mode is not executable:')) {
            throw new AiV2PreviewPolicyError('task_mode_unavailable');
        }
        throw error;
    }
    const definition = aiTaskModeV4(request.task, request.mode);
    if (definition === undefined || definition.route === 'disabled' || definition.minimumPlan === null) {
        throw new AiV2PreviewPolicyError('task_mode_unavailable');
    }
    if (planRank[environment.plan] < planRank[definition.minimumPlan]) {
        throw new AiV2PreviewPolicyError('plan_required');
    }

    const inputBytes = Buffer.byteLength(JSON.stringify(request.input), 'utf8');
    if (inputBytes > definition.maxInputBytes) throw new AiV2PreviewPolicyError('input_too_large');

    const offeredSources = new Map(environment.offeredSources.map((source) => [source.id, source]));
    if (offeredSources.size !== environment.offeredSources.length) {
        throw new AiV2PreviewPolicyError('source_not_offered');
    }
    const sourceIds = [...(request.context?.sourceIds ?? [])].sort();
    if (new Set(sourceIds).size !== sourceIds.length) throw new AiV2PreviewPolicyError('source_not_offered');
    const sources = sourceIds.map((id) => {
        const source = offeredSources.get(id);
        if (source === undefined) throw new AiV2PreviewPolicyError('source_not_offered');
        return source;
    });

    if (
        definition.providerProfileVersion !== null &&
        !environment.readyProviderProfileVersions.has(definition.providerProfileVersion)
    ) {
        throw new AiV2PreviewPolicyError('provider_profile_unavailable');
    }

    const now = environment.now ?? new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const requestIdentity = {
        contractVersion: 2,
        task: request.task,
        mode: request.mode,
        input: request.input,
        sourceIds,
        taskPolicyVersion: AI_TASK_POLICY_V4,
        contextPolicyVersion: AI_CONTEXT_POLICY_V2,
        routingPolicyVersion: AI_ROUTING_POLICY_V1,
        pricePolicyVersion: AI_PRICE_POLICY_V1,
        resultSchemaVersion: definition.resultSchemaVersion,
        safetyPolicyVersion: AI_SAFETY_POLICY_V1,
        cachePolicyVersion: AI_CACHE_POLICY_V1,
        providerProfileVersion: definition.providerProfileVersion,
        sourceSnapshotHash: environment.sourceSnapshotHash,
    };
    const requestHash = createHash('sha256').update(JSON.stringify(requestIdentity)).digest('hex');
    const costCeiling = definition.providerCostCeilingMinor ?? 0;

    const frozen = aiV2FrozenPreviewSchema.parse({
        ...requestIdentity,
        route: definition.route,
        cost: definition.actionCost,
        providerCostCeilingMinor: costCeiling,
        requestHash,
        expiresAt,
    });
    const preview = aiV2PreviewSchema.parse({
        id: environment.previewId ?? randomUUID(),
        task: request.task,
        mode: request.mode,
        route: definition.route,
        cost: definition.actionCost,
        sources,
        expiresAt,
        policyVersion: AI_TASK_POLICY_V4,
    });
    return { preview, frozen };
}

export function aiV2TaskContractColumns(frozen: AiV2FrozenPreview) {
    return {
        contract_version: frozen.contractVersion,
        task_code: frozen.task,
        task_mode: frozen.mode,
        execution_route: frozen.route,
        task_policy_version: frozen.taskPolicyVersion,
        context_policy_version: frozen.contextPolicyVersion,
        routing_policy_version: frozen.routingPolicyVersion,
        price_policy_version: frozen.pricePolicyVersion,
        result_schema_version: frozen.resultSchemaVersion,
        safety_policy_version: frozen.safetyPolicyVersion,
        cache_policy_version: frozen.cachePolicyVersion,
        provider_profile_version: frozen.providerProfileVersion,
        provider_cost_ceiling_minor: frozen.providerCostCeilingMinor,
        source_snapshot_hash: frozen.sourceSnapshotHash,
        accepted_cost: frozen.cost,
    } as const;
}

export function aiV2TaskPreviewSnapshot(prepared: AiV2PreparedPreview) {
    return {
        contractVersion: 2 as const,
        taskType: prepared.frozen.task,
        task: prepared.frozen.task,
        mode: prepared.frozen.mode,
        input: prepared.frozen.input,
        sourceIds: prepared.frozen.sourceIds,
        expiresAt: prepared.frozen.expiresAt,
    };
}
