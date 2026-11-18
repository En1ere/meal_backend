import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AI_V2_PROVIDER_PORT, type AiProviderPort } from './ai-provider-port.js';
import { AiV2ProviderOperationStore } from './ai-provider-operation.store.js';
import {
    aiV2RecipeAdaptationSnapshotSchema,
    recipeAdaptationProviderRequest,
    validateRecipeAdaptationProviderResult,
    type AiV2RecipeAdaptationSnapshot,
} from './ai-recipe-adaptation.js';

const zeroUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 } as const;

@Injectable()
export class AiV2RecipeAdaptationExecutor {
    constructor(
        private readonly operations: AiV2ProviderOperationStore,
        @Inject(AI_V2_PROVIDER_PORT) private readonly provider: AiProviderPort,
    ) {}

    async submit(input: {
        operationId: string;
        dispatchVersion: number;
        clientRequestId: string;
        snapshot: AiV2RecipeAdaptationSnapshot;
        instruction: string;
        clock?: Date;
    }) {
        const clock = input.clock ?? new Date();
        const leaseToken = randomUUID();
        const claim = await this.operations.claimSubmit({
            operationId: input.operationId,
            expectedVersion: input.dispatchVersion,
            leaseOwner: 'recipe-adaptation-simulator',
            leaseToken,
            leaseUntil: new Date(clock.getTime() + 30_000),
            clock,
        });
        if (!claim) return null;
        const outcome = await this.provider.submit(
            recipeAdaptationProviderRequest({
                clientRequestId: input.clientRequestId,
                profileVersion: 'yandexgpt-5.1-balanced-v1',
                snapshot: aiV2RecipeAdaptationSnapshotSchema.parse(input.snapshot),
                instruction: input.instruction,
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

    async read(input: {
        operationId: string;
        dispatchVersion: number;
        snapshot: AiV2RecipeAdaptationSnapshot;
        clock?: Date;
    }) {
        const clock = input.clock ?? new Date();
        const leaseToken = randomUUID();
        const claim = await this.operations.claimRead({
            operationId: input.operationId,
            expectedVersion: input.dispatchVersion,
            leaseOwner: 'recipe-adaptation-simulator',
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
            const result = validateRecipeAdaptationProviderResult(
                outcome.rawResult,
                outcome.usage.outputTokens,
                input.snapshot,
            );
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
