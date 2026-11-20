import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { AI_V2_PROVIDER_PORT, type AiProviderPort } from './ai-provider-port.js';
import { AiV2ProviderOperationStore } from './ai-provider-operation.store.js';
import { aiV2EventMenuGenerationResultSchema } from './ai-v2.contracts.js';
import {
    aiV2EventMenuShortlistSchema,
    eventMenuProviderRequest,
    validateEventMenuProviderResult,
    type AiV2EventMenuShortlist,
} from './ai-event-menu-generation.js';

const zeroUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 } as const;

@Injectable()
export class AiV2EventMenuGenerationExecutor {
    constructor(
        private readonly database: DatabaseService,
        private readonly operations: AiV2ProviderOperationStore,
        @Inject(AI_V2_PROVIDER_PORT) private readonly provider: AiProviderPort,
    ) {}

    private request(clientRequestId: string, shortlist: AiV2EventMenuShortlist) {
        return eventMenuProviderRequest({
            clientRequestId,
            profileVersion: 'yandexgpt-5.1-balanced-v1',
            shortlist: aiV2EventMenuShortlistSchema.parse(shortlist),
        });
    }

    private async project(operationId: string, clock: Date) {
        await this.database.transaction(async (tx) => {
            const operation = (
                await sql<{
                    lifecycle: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
                    taskId: string;
                    intervalId: string;
                    conversationId: string;
                    result: unknown;
                }>`
                    select operation.lifecycle_state lifecycle,operation.task_id "taskId",
                           operation.interval_id "intervalId",task.conversation_id "conversationId",
                           operation.result_snapshot result
                      from meal.ai_operations operation join meal.ai_tasks task on task.id=operation.task_id
                     where operation.id=${operationId}::uuid and operation.contract_version=2
                       and operation.lifecycle_state in('succeeded','failed','cancelled','unknown')
                     for update of operation,task
                `.execute(tx)
            ).rows[0];
            if (!operation || operation.lifecycle === 'unknown') return;
            if (operation.lifecycle === 'succeeded') {
                const result = aiV2EventMenuGenerationResultSchema.parse(operation.result);
                await sql`
                    update meal.ai_intervals set status='completed',version=version+1
                     where id=${operation.intervalId}::uuid and status='processing'
                `.execute(tx);
                const task = await sql`
                    update meal.ai_tasks set status='completed',accepted_at=coalesce(accepted_at,${clock}),version=version+1
                     where id=${operation.taskId}::uuid and status='processing'
                `.execute(tx);
                if (!task.numAffectedRows) return;
                await sql`
                    insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id)
                    values(${randomUUID()}::uuid,'assistant',${`Предпросмотр меню подготовлен: ${result.items.length} позиции.`},
                           ${`${operationId}:assistant`},${operation.conversationId}::uuid,${operation.intervalId}::uuid)
                    on conflict do nothing
                `.execute(tx);
            } else {
                await sql`
                    update meal.ai_intervals set status='refunded',version=version+1
                     where id=${operation.intervalId}::uuid and status='processing'
                `.execute(tx);
                await sql`
                    update meal.ai_tasks set status='refunded',version=version+1
                     where id=${operation.taskId}::uuid and status='processing'
                `.execute(tx);
            }
        });
    }

    async submit(input: {
        operationId: string;
        dispatchVersion: number;
        clientRequestId: string;
        shortlist: AiV2EventMenuShortlist;
        clock?: Date;
    }) {
        const clock = input.clock ?? new Date();
        const leaseToken = randomUUID();
        const claim = await this.operations.claimSubmit({
            operationId: input.operationId,
            expectedVersion: input.dispatchVersion,
            leaseOwner: 'event-menu-generation-simulator',
            leaseToken,
            leaseUntil: new Date(clock.getTime() + 30_000),
            clock,
        });
        if (!claim) return null;
        const outcome = await this.provider.submit(this.request(input.clientRequestId, input.shortlist));
        await this.operations.recordSubmit({
            operationId: input.operationId,
            expectedVersion: claim.version,
            leaseToken,
            outcome,
            nextReadAt: clock,
            clock: new Date(clock.getTime() + 1),
        });
        await this.project(input.operationId, new Date(clock.getTime() + 2));
        return { outcome, nextVersion: claim.version + 1 };
    }

    async read(input: {
        operationId: string;
        dispatchVersion: number;
        shortlist: AiV2EventMenuShortlist;
        clock?: Date;
    }) {
        const clock = input.clock ?? new Date();
        const leaseToken = randomUUID();
        const claim = await this.operations.claimRead({
            operationId: input.operationId,
            expectedVersion: input.dispatchVersion,
            leaseOwner: 'event-menu-generation-simulator',
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
            const result = validateEventMenuProviderResult(
                outcome.rawResult,
                outcome.usage.outputTokens,
                input.shortlist,
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
        await this.project(input.operationId, new Date(clock.getTime() + 2));
        return outcome;
    }
}
