import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { ProviderSubmitOutcome } from './ai-provider-port.js';
import { aiV2ProviderUsageSchema, type AiV2PersistedReadOutcome } from './ai-provider-operation.js';

type Tx = Transaction<DatabaseSchema>;

type DispatchRow = {
    operationId: string;
    clientRequestId: string;
    profileVersion: string;
    requestedModel: string;
    providerResponseId: string | null;
    estimatedCostRub: string;
    state: string;
    version: number;
};

type ReadRecordIdentity = {
    operationId: string;
    expectedVersion: number;
    leaseToken: string;
    clock: Date;
};

const reservationSnapshotSchema = z
    .object({
        allocations: z.array(z.strictObject({ bucketId: z.uuid(), amount: z.number().int().positive().max(4) })).max(4),
    })
    .passthrough();

export class AiV2ProviderDispatchConflict extends Error {
    constructor() {
        super('AI provider dispatch changed concurrently');
    }
}

@Injectable()
export class AiV2ProviderOperationStore {
    constructor(private readonly database: DatabaseService) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready()))
            throw new ServiceUnavailableException('AI provider persistence is unavailable');
        return this.database.db;
    }

    private async serializable<T>(work: (tx: Tx) => Promise<T>) {
        return (await this.db()).transaction().setIsolationLevel('serializable').execute(work);
    }

    async prepare(input: {
        operationId: string;
        clientRequestId: string;
        requestedModel: string;
        estimatedCostRub: string;
        clock: Date;
    }) {
        return this.serializable(async (tx) => {
            const inserted = await sql<DispatchRow>`
                insert into meal.ai_provider_dispatches(
                    operation_id,client_request_id,profile_version,requested_model,state,
                    estimated_cost_rub,created_at,updated_at
                )
                select operation.id,${input.clientRequestId}::uuid,operation.provider_profile_version,
                       ${input.requestedModel},'prepared',${input.estimatedCostRub}::numeric,${input.clock},${input.clock}
                  from meal.ai_operations operation
                 where operation.id=${input.operationId}::uuid and operation.contract_version=2
                returning operation_id "operationId",client_request_id "clientRequestId",
                          profile_version "profileVersion",requested_model "requestedModel",
                          provider_response_id "providerResponseId",estimated_cost_rub::text "estimatedCostRub",
                          state,version::integer
            `.execute(tx);
            const row = inserted.rows[0];
            if (!row) throw new AiV2ProviderDispatchConflict();
            return row;
        });
    }

    async claimSubmit(input: {
        operationId: string;
        expectedVersion: number;
        leaseOwner: string;
        leaseToken: string;
        leaseUntil: Date;
        clock: Date;
    }) {
        return this.serializable(async (tx) => {
            const claimed = await sql<DispatchRow>`
                update meal.ai_provider_dispatches
                   set state='submit_claimed',lease_owner=${input.leaseOwner},lease_token=${input.leaseToken}::uuid,
                       lease_until=${input.leaseUntil},updated_at=${input.clock},version=version+1
                 where operation_id=${input.operationId}::uuid and state='prepared'
                   and version=${input.expectedVersion}
                returning operation_id "operationId",client_request_id "clientRequestId",
                          profile_version "profileVersion",requested_model "requestedModel",
                          provider_response_id "providerResponseId",estimated_cost_rub::text "estimatedCostRub",
                          state,version::integer
            `.execute(tx);
            const row = claimed.rows[0];
            if (!row) return null;
            const operation = await sql`
                update meal.ai_operations
                   set lifecycle_state='running',lease_owner=${input.leaseOwner},lease_token=${input.leaseToken}::uuid,
                       lease_until=${input.leaseUntil},provider_client_request_id=${row.clientRequestId}::uuid,
                       provider_cost=${row.estimatedCostRub}::numeric,provider_cost_state='estimated_hold',
                       updated_at=${input.clock},version=version+1
                 where id=${input.operationId}::uuid and contract_version=2 and lifecycle_state='queued'
                   and execution_route in('economy','balanced') and provider_cost_state='none'
            `.execute(tx);
            if (!operation.numAffectedRows) throw new AiV2ProviderDispatchConflict();
            return row;
        });
    }

    async recordSubmit(input: {
        operationId: string;
        expectedVersion: number;
        leaseToken: string;
        outcome: ProviderSubmitOutcome;
        nextReadAt: Date;
        clock: Date;
    }) {
        return this.serializable(async (tx) => {
            if (input.outcome.kind === 'accepted') await this.acceptSubmit(tx, input, input.outcome.providerResponseId);
            else if (input.outcome.kind === 'rejected')
                await this.finishSubmit(tx, input, 'rejected', input.outcome.category);
            else await this.finishSubmit(tx, input, 'unknown_without_identity', 'provider_outcome_unknown');
        });
    }

    private async acceptSubmit(
        tx: Tx,
        input: {
            operationId: string;
            expectedVersion: number;
            leaseToken: string;
            nextReadAt: Date;
            clock: Date;
        },
        providerResponseId: string,
    ) {
        const dispatch = await sql`
            update meal.ai_provider_dispatches
               set state='accepted',submit_outcome='accepted',provider_response_id=${providerResponseId},
                   next_read_at=${input.nextReadAt},lease_owner=null,lease_token=null,lease_until=null,
                   updated_at=${input.clock},version=version+1
             where operation_id=${input.operationId}::uuid and state='submit_claimed'
               and lease_token=${input.leaseToken}::uuid and version=${input.expectedVersion}
        `.execute(tx);
        if (!dispatch.numAffectedRows) throw new AiV2ProviderDispatchConflict();
        const operation = await sql`
            update meal.ai_operations
               set lifecycle_state='queued',provider_request_id=${providerResponseId},next_attempt_at=${input.nextReadAt},
                   lease_owner=null,lease_token=null,lease_until=null,updated_at=${input.clock},version=version+1
             where id=${input.operationId}::uuid and contract_version=2 and lifecycle_state='running'
               and lease_token=${input.leaseToken}::uuid and provider_request_id is null
        `.execute(tx);
        if (!operation.numAffectedRows) throw new AiV2ProviderDispatchConflict();
    }

    private async finishSubmit(
        tx: Tx,
        input: {
            operationId: string;
            expectedVersion: number;
            leaseToken: string;
            clock: Date;
        },
        outcome: 'rejected' | 'unknown_without_identity',
        category: string,
    ) {
        const financialState = await this.settleUserQuota(tx, input.operationId, 'release', input.clock);
        const dispatch = await sql`
            update meal.ai_provider_dispatches
               set state=${outcome},submit_outcome=${outcome},error_category=${category},terminal_at=${input.clock},
                   lease_owner=null,lease_token=null,lease_until=null,updated_at=${input.clock},version=version+1
             where operation_id=${input.operationId}::uuid and state='submit_claimed'
               and lease_token=${input.leaseToken}::uuid and version=${input.expectedVersion}
        `.execute(tx);
        if (!dispatch.numAffectedRows) throw new AiV2ProviderDispatchConflict();
        const unknown = outcome === 'unknown_without_identity';
        const operation = await sql`
            update meal.ai_operations
               set lifecycle_state=${unknown ? 'unknown' : 'failed'},failure_category=${unknown ? 'provider_outcome_unknown' : 'provider_error'},
                   failure_retryable=false,financial_state=${financialState},provider_cost_state=${unknown ? 'estimated_hold' : 'released'},
                   finished_at=${input.clock},lease_owner=null,lease_token=null,lease_until=null,
                   updated_at=${input.clock},version=version+1
             where id=${input.operationId}::uuid and contract_version=2 and lifecycle_state='running'
               and lease_token=${input.leaseToken}::uuid and provider_request_id is null
        `.execute(tx);
        if (!operation.numAffectedRows) throw new AiV2ProviderDispatchConflict();
    }

    async claimRead(input: {
        operationId: string;
        expectedVersion: number;
        leaseOwner: string;
        leaseToken: string;
        leaseUntil: Date;
        clock: Date;
    }) {
        const result = await this.serializable(async (tx) => {
            const claimed = await sql<DispatchRow>`
                update meal.ai_provider_dispatches
                   set state='read_claimed',read_outcome=null,lease_owner=${input.leaseOwner},
                       lease_token=${input.leaseToken}::uuid,lease_until=${input.leaseUntil},
                       read_count=read_count+1,updated_at=${input.clock},version=version+1
                 where operation_id=${input.operationId}::uuid
                   and state in('accepted','queued','running','read_unknown')
                   and provider_response_id is not null and next_read_at<=${input.clock}
                   and version=${input.expectedVersion}
                returning operation_id "operationId",client_request_id "clientRequestId",
                          profile_version "profileVersion",requested_model "requestedModel",
                          provider_response_id "providerResponseId",estimated_cost_rub::text "estimatedCostRub",
                          state,version::integer
            `.execute(tx);
            return claimed.rows[0] ?? null;
        });
        return result;
    }

    async recordRead(input: {
        operationId: string;
        expectedVersion: number;
        leaseToken: string;
        outcome: AiV2PersistedReadOutcome;
        clock: Date;
    }) {
        return this.serializable(async (tx) => {
            const identity: ReadRecordIdentity = input;
            if (input.outcome.kind === 'queued' || input.outcome.kind === 'running')
                await this.recordPendingRead(tx, identity, input.outcome);
            else if (input.outcome.kind === 'unknown') await this.recordUnknownRead(tx, identity, input.outcome);
            else await this.recordTerminalRead(tx, identity, input.outcome);
        });
    }

    async expireClaim(input: {
        operationId: string;
        expectedVersion: number;
        leaseToken: string;
        nextReadAt: Date;
        clock: Date;
    }) {
        return this.serializable(async (tx) => {
            const row = (
                await sql<{ state: 'submit_claimed' | 'read_claimed' }>`
                    select state from meal.ai_provider_dispatches
                     where operation_id=${input.operationId}::uuid
                       and state in('submit_claimed','read_claimed')
                       and lease_token=${input.leaseToken}::uuid and lease_until<=${input.clock}
                       and version=${input.expectedVersion}
                     for update
                `.execute(tx)
            ).rows[0];
            if (!row) return false;
            if (row.state === 'submit_claimed')
                await this.finishSubmit(tx, input, 'unknown_without_identity', 'process_interrupted');
            else await this.recordUnknownRead(tx, input, { kind: 'unknown', nextReadAt: input.nextReadAt });
            return true;
        });
    }

    private async recordPendingRead(
        tx: Tx,
        input: ReadRecordIdentity,
        outcome: Extract<AiV2PersistedReadOutcome, { kind: 'queued' | 'running' }>,
    ) {
        const dispatch = await sql`
            update meal.ai_provider_dispatches
               set state=${outcome.kind},read_outcome=${outcome.kind},next_read_at=${outcome.nextReadAt},
                   lease_owner=null,lease_token=null,lease_until=null,updated_at=${input.clock},version=version+1
             where operation_id=${input.operationId}::uuid and state='read_claimed'
               and lease_token=${input.leaseToken}::uuid and version=${input.expectedVersion}
        `.execute(tx);
        if (!dispatch.numAffectedRows) throw new AiV2ProviderDispatchConflict();
        await this.updateOperationAfterRead(tx, input.operationId, outcome.kind, input.clock, {
            nextReadAt: outcome.nextReadAt,
        });
    }

    private async recordUnknownRead(
        tx: Tx,
        input: ReadRecordIdentity,
        outcome: Extract<AiV2PersistedReadOutcome, { kind: 'unknown' }>,
    ) {
        const dispatch = await sql`
            update meal.ai_provider_dispatches
               set state='read_unknown',read_outcome='unknown',error_category='provider_outcome_unknown',
                   next_read_at=${outcome.nextReadAt},lease_owner=null,lease_token=null,lease_until=null,
                   updated_at=${input.clock},version=version+1
             where operation_id=${input.operationId}::uuid and state='read_claimed'
               and lease_token=${input.leaseToken}::uuid and version=${input.expectedVersion}
        `.execute(tx);
        if (!dispatch.numAffectedRows) throw new AiV2ProviderDispatchConflict();
        await this.updateOperationAfterRead(tx, input.operationId, 'unknown', input.clock, {
            nextReadAt: outcome.nextReadAt,
        });
    }

    private async recordTerminalRead(
        tx: Tx,
        input: ReadRecordIdentity,
        outcome: Exclude<AiV2PersistedReadOutcome, { kind: 'queued' | 'running' | 'unknown' }>,
    ) {
        const usage = aiV2ProviderUsageSchema.parse(outcome.usage);
        const dispatch = await sql`
            update meal.ai_provider_dispatches
               set state=${outcome.kind},read_outcome=${outcome.kind},actual_cost_rub=${outcome.actualCostRub}::numeric,
                   input_tokens=${usage.inputTokens},output_tokens=${usage.outputTokens},cached_input_tokens=${usage.cachedInputTokens},
                   reasoning_tokens=${usage.reasoningTokens},error_category=${outcome.kind === 'succeeded' ? null : `provider_${outcome.kind}`},
                   terminal_at=${input.clock},next_read_at=null,lease_owner=null,lease_token=null,lease_until=null,
                   updated_at=${input.clock},version=version+1
             where operation_id=${input.operationId}::uuid and state='read_claimed'
               and lease_token=${input.leaseToken}::uuid and version=${input.expectedVersion}
        `.execute(tx);
        if (!dispatch.numAffectedRows) throw new AiV2ProviderDispatchConflict();
        await this.updateOperationAfterRead(tx, input.operationId, outcome.kind, input.clock, {
            usage,
            actualCostRub: outcome.actualCostRub,
            validatedResultSnapshot: outcome.kind === 'succeeded' ? outcome.validatedResultSnapshot : undefined,
        });
    }

    private async updateOperationAfterRead(
        tx: Tx,
        operationId: string,
        outcome: 'queued' | 'running' | 'unknown' | 'succeeded' | 'failed' | 'cancelled' | 'incomplete',
        clock: Date,
        evidence: {
            nextReadAt?: Date;
            usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number };
            actualCostRub?: string;
            validatedResultSnapshot?: unknown;
        },
    ) {
        const lifecycle =
            outcome === 'queued' || outcome === 'running' ? 'queued' : outcome === 'incomplete' ? 'failed' : outcome;
        const terminal = ['succeeded', 'failed', 'cancelled', 'incomplete'].includes(outcome);
        const financialState =
            outcome === 'unknown'
                ? await this.holdUserQuotaForReconciliation(tx, operationId)
                : terminal
                  ? await this.settleUserQuota(tx, operationId, outcome === 'succeeded' ? 'capture' : 'release', clock)
                  : null;
        const operation = await sql`
            update meal.ai_operations
               set lifecycle_state=${lifecycle},failure_category=${outcome === 'unknown' ? 'provider_outcome_unknown' : terminal && outcome !== 'succeeded' ? 'provider_error' : null},
                   failure_retryable=${outcome === 'unknown' || (terminal && outcome !== 'succeeded') ? false : null},
                   financial_state=${financialState ?? sql`financial_state`},
                   next_attempt_at=${evidence.nextReadAt ?? clock},
                   result_snapshot=${evidence.validatedResultSnapshot === undefined ? sql`result_snapshot` : JSON.stringify(evidence.validatedResultSnapshot)}::jsonb,
                   token_usage=${evidence.usage ? JSON.stringify(evidence.usage) : sql`token_usage`}::jsonb,
                   provider_cost=${evidence.actualCostRub ?? sql`provider_cost`}::numeric,
                   provider_cost_state=${terminal ? 'actual' : 'estimated_hold'},
                   finished_at=${terminal ? clock : null},updated_at=${clock},version=version+1
             where id=${operationId}::uuid and contract_version=2 and provider_request_id is not null
               and lifecycle_state in('queued','running','unknown')
        `.execute(tx);
        if (!operation.numAffectedRows) throw new AiV2ProviderDispatchConflict();
    }

    private async holdUserQuotaForReconciliation(tx: Tx, operationId: string) {
        const row = (
            await sql<{ financialState: 'none' | 'reserved' | 'reconciliation_hold' }>`
                select financial_state "financialState" from meal.ai_operations
                 where id=${operationId}::uuid for update
            `.execute(tx)
        ).rows[0];
        if (!row) throw new AiV2ProviderDispatchConflict();
        return row.financialState === 'reserved' ? 'reconciliation_hold' : row.financialState;
    }

    private async settleUserQuota(
        tx: Tx,
        operationId: string,
        settlement: 'capture' | 'release',
        clock: Date,
    ): Promise<'none' | 'captured' | 'released'> {
        const row = (
            await sql<{ financialState: string; resultSnapshot: unknown }>`
                select financial_state "financialState",result_snapshot "resultSnapshot"
                  from meal.ai_operations where id=${operationId}::uuid for update
            `.execute(tx)
        ).rows[0];
        if (!row) throw new AiV2ProviderDispatchConflict();
        if (row.financialState === 'none') return 'none';
        if (!['reserved', 'reconciliation_hold'].includes(row.financialState)) throw new AiV2ProviderDispatchConflict();
        const snapshot = reservationSnapshotSchema.safeParse(row.resultSnapshot);
        if (!snapshot.success || !snapshot.data.allocations.length) throw new AiV2ProviderDispatchConflict();
        for (const allocation of snapshot.data.allocations) {
            await sql`
                insert into meal.ai_ledger(
                    id,kind,delta,reserved_delta,recorded_at,idempotency_key,bucket_id,operation_id,compensates_id
                ) values(
                    ${randomUUID()}::uuid,${settlement},${settlement === 'capture' ? -allocation.amount : 0},
                    ${-allocation.amount},${clock},${`${operationId}:${settlement}:${allocation.bucketId}`},
                    ${allocation.bucketId}::uuid,${operationId}::uuid,null
                )
            `.execute(tx);
            const bucket = await sql`
                update meal.ai_buckets
                   set balance_projection=balance_projection+${settlement === 'capture' ? -allocation.amount : 0},
                       reserved_projection=reserved_projection-${allocation.amount},version=version+1
                 where id=${allocation.bucketId}::uuid and reserved_projection>=${allocation.amount}
                   and balance_projection>=${settlement === 'capture' ? allocation.amount : 0}
            `.execute(tx);
            if (!bucket.numAffectedRows) throw new AiV2ProviderDispatchConflict();
        }
        return settlement === 'capture' ? 'captured' : 'released';
    }
}
