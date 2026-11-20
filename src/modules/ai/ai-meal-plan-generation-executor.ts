import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { AI_V2_PROVIDER_PORT, type AiProviderPort } from './ai-provider-port.js';
import { AiV2ProviderOperationStore } from './ai-provider-operation.store.js';
import {
    aiV2MealPlanReplaceSnapshotSchema,
    aiV2MealPlanShortlistSchema,
    mealPlanGenerateProviderRequest,
    mealPlanReplaceProviderRequest,
    validateMealPlanGenerateProviderResult,
    validateMealPlanReplaceProviderResult,
    type AiV2MealPlanReplaceSnapshot,
    type AiV2MealPlanShortlist,
} from './ai-meal-plan-generation.js';

const zeroUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 } as const;

type ExecutionSource =
    | { mode: 'generate'; shortlist: AiV2MealPlanShortlist }
    | { mode: 'replace_slot'; snapshot: AiV2MealPlanReplaceSnapshot };

@Injectable()
export class AiV2MealPlanGenerationExecutor {
    constructor(
        private readonly database: DatabaseService,
        private readonly operations: AiV2ProviderOperationStore,
        @Inject(AI_V2_PROVIDER_PORT) private readonly provider: AiProviderPort,
    ) {}

    private request(clientRequestId: string, source: ExecutionSource) {
        return source.mode === 'generate'
            ? mealPlanGenerateProviderRequest({
                  clientRequestId,
                  profileVersion: 'yandexgpt-5.1-balanced-v1',
                  shortlist: aiV2MealPlanShortlistSchema.parse(source.shortlist),
              })
            : mealPlanReplaceProviderRequest({
                  clientRequestId,
                  profileVersion: 'yandexgpt-5.1-balanced-v1',
                  snapshot: aiV2MealPlanReplaceSnapshotSchema.parse(source.snapshot),
              });
    }

    private validate(raw: unknown, outputTokens: number, source: ExecutionSource) {
        return source.mode === 'generate'
            ? validateMealPlanGenerateProviderResult(raw, outputTokens, source.shortlist)
            : validateMealPlanReplaceProviderResult(raw, outputTokens, source.snapshot);
    }

    async submit(input: {
        operationId: string;
        dispatchVersion: number;
        clientRequestId: string;
        source: ExecutionSource;
        clock?: Date;
    }) {
        const clock = input.clock ?? new Date();
        const leaseToken = randomUUID();
        const claim = await this.operations.claimSubmit({
            operationId: input.operationId,
            expectedVersion: input.dispatchVersion,
            leaseOwner: 'meal-plan-generation-simulator',
            leaseToken,
            leaseUntil: new Date(clock.getTime() + 30_000),
            clock,
        });
        if (!claim) return null;
        const outcome = await this.provider.submit(this.request(input.clientRequestId, input.source));
        await this.operations.recordSubmit({
            operationId: input.operationId,
            expectedVersion: claim.version,
            leaseToken,
            outcome,
            nextReadAt: clock,
            clock: new Date(clock.getTime() + 1),
        });
        if (outcome.kind === 'rejected')
            await this.finalize(input.operationId, 'failed', null, new Date(clock.getTime() + 2));
        return { outcome, nextVersion: claim.version + 1 };
    }

    private async finalize(
        operationId: string,
        outcome: 'succeeded' | 'failed' | 'cancelled' | 'incomplete',
        result: unknown,
        clock: Date,
    ) {
        const lifecycle = outcome === 'incomplete' ? 'failed' : outcome;
        await this.database.transaction(async (tx) => {
            const operation = (
                await sql<{
                    taskId: string;
                    intervalId: string;
                    conversationId: string;
                    mode: 'generate' | 'replace_slot';
                }>`
                    select operation.task_id "taskId",operation.interval_id "intervalId",
                           task.conversation_id "conversationId",task.task_mode mode
                      from meal.ai_operations operation join meal.ai_tasks task on task.id=operation.task_id
                     where operation.id=${operationId}::uuid and operation.contract_version=2
                       and operation.lifecycle_state=${lifecycle}
                     for update of operation,task
                `.execute(tx)
            ).rows[0];
            if (!operation) return;
            if (outcome === 'succeeded') {
                await sql`
                    update meal.ai_intervals set status='completed',version=version+1
                     where id=${operation.intervalId}::uuid
                `.execute(tx);
                await sql`
                    update meal.ai_tasks set status='completed',accepted_at=coalesce(accepted_at,${clock}),version=version+1
                     where id=${operation.taskId}::uuid
                `.execute(tx);
                const itemCount =
                    operation.mode === 'generate'
                        ? ((result as { slots?: unknown[] }).slots?.length ?? 0)
                        : result
                          ? 1
                          : 0;
                await sql`
                    insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id)
                    values(${randomUUID()}::uuid,'assistant',${operation.mode === 'generate' ? `Предпросмотр рациона подготовлен: ${itemCount} слотов.` : 'Замена слота подготовлена.'},${`${operationId}:assistant`},${operation.conversationId}::uuid,${operation.intervalId}::uuid)
                    on conflict do nothing
                `.execute(tx);
            } else if (operation.mode === 'replace_slot') {
                await sql`
                    update meal.ai_intervals
                       set status='completed',clarifications_used=greatest(0,clarifications_used-1),version=version+1
                     where id=${operation.intervalId}::uuid
                `.execute(tx);
                await sql`
                    update meal.ai_tasks set status='refunded',version=version+1
                     where id=${operation.taskId}::uuid
                `.execute(tx);
            } else {
                await sql`
                    update meal.ai_intervals set status='refunded',version=version+1
                     where id=${operation.intervalId}::uuid
                `.execute(tx);
                await sql`
                    update meal.ai_tasks set status='refunded',version=version+1
                     where id=${operation.taskId}::uuid
                `.execute(tx);
            }
        });
    }

    async read(input: { operationId: string; dispatchVersion: number; source: ExecutionSource; clock?: Date }) {
        const clock = input.clock ?? new Date();
        const leaseToken = randomUUID();
        const claim = await this.operations.claimRead({
            operationId: input.operationId,
            expectedVersion: input.dispatchVersion,
            leaseOwner: 'meal-plan-generation-simulator',
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
            const result = this.validate(outcome.rawResult, outcome.usage.outputTokens, input.source);
            const normalized = result
                ? {
                      kind: 'succeeded' as const,
                      usage: outcome.usage,
                      actualCostRub: '0.00000000',
                      validatedResultSnapshot: result,
                  }
                : { kind: 'failed' as const, usage: outcome.usage, actualCostRub: '0.00000000' };
            await this.operations.recordRead({
                operationId: input.operationId,
                expectedVersion: claim.version,
                leaseToken,
                outcome: normalized,
                clock: new Date(clock.getTime() + 1),
            });
            await this.finalize(
                input.operationId,
                normalized.kind,
                normalized.kind === 'succeeded' ? normalized.validatedResultSnapshot : null,
                new Date(clock.getTime() + 2),
            );
        } else {
            await this.operations.recordRead({
                operationId: input.operationId,
                expectedVersion: claim.version,
                leaseToken,
                outcome: { kind: outcome.kind, usage: zeroUsage, actualCostRub: '0.00000000' },
                clock: new Date(clock.getTime() + 1),
            });
            await this.finalize(input.operationId, outcome.kind, null, new Date(clock.getTime() + 2));
        }
        return outcome;
    }
}
