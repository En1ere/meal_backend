import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AI_V2_PROVIDER_PORT, type AiProviderPort } from './ai-provider-port.js';
import { AiV2ProviderOperationStore } from './ai-provider-operation.store.js';
import {
    aiV2SubstitutionCandidateSchema,
    substitutionProviderRequest,
    validateSubstitutionProviderResult,
    type AiV2SubstitutionCandidate,
} from './ai-substitution.js';
import { aiV2SubstitutionExplainResultSchema } from './ai-v2.contracts.js';

const zeroUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 } as const;

@Injectable()
export class AiV2SubstitutionExecutor {
    constructor(
        private readonly operations: AiV2ProviderOperationStore,
        @Inject(AI_V2_PROVIDER_PORT) private readonly provider: AiProviderPort,
    ) {}

    async submit(input: {
        operationId: string;
        dispatchVersion: number;
        clientRequestId: string;
        candidate: AiV2SubstitutionCandidate;
        question?: string;
        clock?: Date;
    }) {
        const clock = input.clock ?? new Date();
        const leaseToken = randomUUID();
        const claim = await this.operations.claimSubmit({
            operationId: input.operationId,
            expectedVersion: input.dispatchVersion,
            leaseOwner: 'substitution-simulator',
            leaseToken,
            leaseUntil: new Date(clock.getTime() + 30_000),
            clock,
        });
        if (!claim) return null;
        const outcome = await this.provider.submit(
            substitutionProviderRequest({
                clientRequestId: input.clientRequestId,
                profileVersion: 'yandex-alice-flash-economy-v1',
                candidate: aiV2SubstitutionCandidateSchema.parse(input.candidate),
                ...(input.question ? { question: input.question } : {}),
            }),
        );
        await this.operations.recordSubmit({
            operationId: input.operationId,
            expectedVersion: claim.version,
            leaseToken,
            outcome,
            nextReadAt: clock,
            clock: new Date(clock.getTime() + 1),
        });
        return { outcome, nextVersion: claim.version + 1 };
    }

    async read(input: { operationId: string; dispatchVersion: number; clock?: Date }) {
        const clock = input.clock ?? new Date();
        const leaseToken = randomUUID();
        const claim = await this.operations.claimRead({
            operationId: input.operationId,
            expectedVersion: input.dispatchVersion,
            leaseOwner: 'substitution-simulator',
            leaseToken,
            leaseUntil: new Date(clock.getTime() + 30_000),
            clock,
        });
        if (!claim?.providerResponseId) return null;
        const outcome = await this.provider.read(claim.providerResponseId);
        const nextReadAt = new Date(clock.getTime() + 5_000);
        if (outcome.kind === 'queued' || outcome.kind === 'running')
            await this.operations.recordRead({
                operationId: input.operationId,
                expectedVersion: claim.version,
                leaseToken,
                outcome: { kind: outcome.kind, nextReadAt },
                clock: new Date(clock.getTime() + 1),
            });
        else if (outcome.kind === 'unknown')
            await this.operations.recordRead({
                operationId: input.operationId,
                expectedVersion: claim.version,
                leaseToken,
                outcome: { kind: 'unknown', nextReadAt },
                clock: new Date(clock.getTime() + 1),
            });
        else if (outcome.kind === 'succeeded') {
            const parsed = validateSubstitutionProviderResult(outcome.rawResult, outcome.usage.outputTokens);
            const result = parsed
                ? aiV2SubstitutionExplainResultSchema.parse({
                      ...parsed,
                      warningCodes: [...new Set([...parsed.warningCodes, 'allergen_status_unknown'])].slice(0, 2),
                      recoveryCode: parsed.recoveryCode ?? 'check_product_label',
                  })
                : null;
            await this.operations.recordRead({
                operationId: input.operationId,
                expectedVersion: claim.version,
                leaseToken,
                outcome: result
                    ? {
                          kind: 'succeeded',
                          usage: outcome.usage,
                          actualCostRub: '0.00000000',
                          validatedResultSnapshot: result,
                      }
                    : { kind: 'failed', usage: outcome.usage, actualCostRub: '0.00000000' },
                clock: new Date(clock.getTime() + 1),
            });
        } else
            await this.operations.recordRead({
                operationId: input.operationId,
                expectedVersion: claim.version,
                leaseToken,
                outcome: { kind: outcome.kind, usage: zeroUsage, actualCostRub: '0.00000000' },
                clock: new Date(clock.getTime() + 1),
            });
        return outcome;
    }
}
