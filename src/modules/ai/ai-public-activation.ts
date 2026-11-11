import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import { aiV2CulinaryAnswerResultSchema } from './ai-v2.contracts.js';
import { AI_V2_PROVIDER_RUNTIME, type AiV2ProviderRuntime } from './ai-provider-port.js';

export const aiV2PublicActivationBlockerSchema = z.enum([
    'explicit_enable_missing',
    'provider_runtime_not_yandex',
    'provider_not_ready',
    'economy_profile_missing',
    'store_false_readback_evidence_missing',
    'eval_evidence_missing',
    'legal_evidence_missing',
    'rollback_evidence_missing',
    'monthly_budget_missing',
]);

export type AiV2PublicActivationBlocker = z.infer<typeof aiV2PublicActivationBlockerSchema>;

export const aiV2CulinaryPublicPreviewSchema = z.strictObject({
    id: z.uuid(),
    task: z.literal('culinary_question'),
    mode: z.literal('answer'),
    cost: z.literal(1),
    expiresAt: z.iso.datetime(),
    policyVersion: z.literal('ai-task-policy-v4'),
});

export const aiV2CulinaryPublicOperationSchema = z.strictObject({
    item: z.strictObject({
        id: z.uuid(),
        taskId: z.uuid(),
        task: z.literal('culinary_question'),
        mode: z.literal('answer'),
        state: z.enum(['queued', 'running', 'succeeded', 'failed', 'unknown']),
        result: aiV2CulinaryAnswerResultSchema.nullable(),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        version: z.number().int().positive(),
    }),
});

type ActivationConfig = Pick<
    AppConfig,
    | 'AI_V2_CULINARY_PUBLIC_ENABLED'
    | 'AI_V2_CULINARY_STORE_FALSE_READBACK_EVIDENCE'
    | 'AI_V2_CULINARY_EVAL_EVIDENCE'
    | 'AI_V2_CULINARY_LEGAL_EVIDENCE'
    | 'AI_V2_CULINARY_ROLLBACK_EVIDENCE'
    | 'AI_V2_CULINARY_MONTHLY_BUDGET_RUB'
>;

export function culinaryPublicActivationDecision(config: ActivationConfig, runtime: AiV2ProviderRuntime) {
    const blockers: AiV2PublicActivationBlocker[] = [];
    if (!config.AI_V2_CULINARY_PUBLIC_ENABLED) blockers.push('explicit_enable_missing');
    if (runtime.kind !== 'yandex') blockers.push('provider_runtime_not_yandex');
    if (runtime.readiness !== 'ready') blockers.push('provider_not_ready');
    if (!runtime.profileVersions.includes('yandex-alice-flash-economy-v1')) blockers.push('economy_profile_missing');
    if (config.AI_V2_CULINARY_STORE_FALSE_READBACK_EVIDENCE !== 'yandex-store-false-readback-v1')
        blockers.push('store_false_readback_evidence_missing');
    if (config.AI_V2_CULINARY_EVAL_EVIDENCE !== 'ai-culinary-eval-v1') blockers.push('eval_evidence_missing');
    if (config.AI_V2_CULINARY_LEGAL_EVIDENCE !== 'ai-yandex-ru-processing-v1') blockers.push('legal_evidence_missing');
    if (config.AI_V2_CULINARY_ROLLBACK_EVIDENCE !== 'ai-culinary-rollback-v1')
        blockers.push('rollback_evidence_missing');
    if (!config.AI_V2_CULINARY_MONTHLY_BUDGET_RUB) blockers.push('monthly_budget_missing');
    return { ready: blockers.length === 0, blockers } as const;
}

@Injectable()
export class AiV2PublicActivationGate {
    constructor(
        @Inject(APP_CONFIG) private readonly config: ActivationConfig,
        @Inject(AI_V2_PROVIDER_RUNTIME) private readonly runtime: AiV2ProviderRuntime,
    ) {}

    status() {
        return culinaryPublicActivationDecision(this.config, this.runtime);
    }

    assertCulinaryReady() {
        const decision = this.status();
        if (!decision.ready) throw new ServiceUnavailableException('AI culinary public route is not activated');
    }
}
