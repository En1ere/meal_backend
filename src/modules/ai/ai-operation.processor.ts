import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { AiProvider, AiProviderError, type AiBackgroundResult } from './ai-provider.js';
import { aiTaskTypeSchema, type AiTaskType } from './ai.contracts.js';
import { aiTask, aiTaskAvailable, aiTokenBudget } from './ai-orchestration.js';
import { parseAiContextSnapshot, renderAiContext } from './ai-context.js';
import type { AiWorkerConfig } from './ai-worker.config.js';
import { aiMoneyUnits, aiProviderCost } from '../../shared/config/ai-provider-profile.js';

type Db = Kysely<DatabaseSchema>;
type Tx = Transaction<DatabaseSchema>;
type Allocation = { bucketId: string; amount: number };
type Claimed = {
    id: string;
    userId: string;
    taskId: string;
    intervalId: string;
    conversationId: string;
    messageId: string;
    commandKind: 'initial' | 'continuation';
    taskType: AiTaskType;
    prompt: string;
    personalContext: unknown;
    usePersonalData: boolean;
    cost: 1 | 2 | 3 | 4 | 5;
    resultSnapshot: Record<string, unknown>;
    attemptId: string;
    attemptNo: number;
    clientRequestId: string;
    providerRequestId: string | null;
    leaseToken: string;
    startedAt: Date;
    localFailureCode: string | null;
};

const planRank = { free: 0, plus: 1, pro: 2 } as const;
const allocations = (snapshot: Record<string, unknown>): Allocation[] =>
    Array.isArray(snapshot.allocations)
        ? snapshot.allocations.flatMap((value) => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
              const item = value as Record<string, unknown>;
              return typeof item.bucketId === 'string' && Number.isInteger(item.amount) && Number(item.amount) > 0
                  ? [{ bucketId: item.bucketId, amount: Number(item.amount) }]
                  : [];
          })
        : [];

export class AiOperationProcessor {
    constructor(
        private readonly db: Db,
        private readonly config: AiWorkerConfig,
        private readonly provider: AiProvider,
    ) {}

    private async fenced(tx: Tx, job: Claimed) {
        const row =
            await sql`select id from meal.ai_operations where id=${job.id}::uuid and lifecycle_state='running' and lease_token=${job.leaseToken}::uuid and lease_until>now() for update`.execute(
                tx,
            );
        return row.rows.length === 1;
    }

    private async currentPlan(userId: string): Promise<'free' | 'plus' | 'pro'> {
        const result = await sql<{ plan: string }>`
            select p.code plan
            from meal.subscriptions s
            join meal.billing_products p on p.id=s.product_id
            join meal.subscription_periods period on period.subscription_id=s.id
            left join meal.grace_incidents grace on grace.subscription_id=s.id and grace.ends_at>now()
            where s.owner_id=${userId}::uuid and s.status='active' and period.starts_at<=now()
              and (period.ends_at>now() or grace.ends_at>now())
              and not exists(
                select 1 from meal.subscription_changes r
                where r.subscription_id=s.id and r.kind='revokeGift' and r.status='applied'
                  and r.preview->>'targetId'=period.id::text
              )
            union all
            select p.code plan
            from meal.family_memberships m
            join meal.family_coverages coverage on coverage.family_id=m.family_id
            join meal.subscriptions s on s.id=coverage.subscription_id
            join meal.billing_products p on p.id=s.product_id
            join meal.subscription_periods period on period.subscription_id=s.id
            left join meal.grace_incidents grace on grace.subscription_id=s.id and grace.ends_at>now()
            where m.user_id=${userId}::uuid and m.left_at is null
              and coverage.selected_at is not null and coverage.starts_at<=now()
              and (coverage.ends_at is null or coverage.ends_at>now())
              and s.status='active' and period.starts_at<=now()
              and (period.ends_at>now() or grace.ends_at>now())
              and not exists(
                select 1 from meal.subscription_changes r
                where r.subscription_id=s.id and r.kind='revokeGift' and r.status='applied'
                  and r.preview->>'targetId'=period.id::text
              )
        `.execute(this.db);
        return result.rows.reduce<'free' | 'plus' | 'pro'>((best, row) => {
            const plan = row.plan === 'pro' ? 'pro' : row.plan === 'plus' ? 'plus' : 'free';
            return planRank[plan] > planRank[best] ? plan : best;
        }, 'free');
    }

    private async authorized(job: Claimed) {
        const access = await sql<{ allowed: boolean; aiConsent: boolean; specialConsent: boolean }>`
            select
              u.status='active' and u.archived_at is null and not exists(
                select 1 from meal.sanctions s where s.user_id=u.id and s.scope in ('account','ai')
                  and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now())
              ) allowed,
              coalesce((select e.action='accepted' from meal.legal_consent_events e where e.user_id=u.id and e.kind='ai_data_access' order by e.revision desc limit 1),false) "aiConsent",
              coalesce((select e.action='accepted' from meal.legal_consent_events e where e.user_id=u.id and e.kind='special_category' order by e.revision desc limit 1),false) "specialConsent"
            from meal.users u where u.id=${job.userId}::uuid
        `.execute(this.db);
        const row = access.rows[0];
        if (!row?.allowed) return false;
        const plan = await this.currentPlan(job.userId);
        if (!aiTaskAvailable(aiTask(job.taskType), plan)) return false;
        if (!job.usePersonalData) return true;
        if (!row.aiConsent) return false;
        const context = parseAiContextSnapshot(job.personalContext);
        return !context.preferences?.allergens.length || row.specialConsent;
    }

    private async release(tx: Tx, job: Claimed, category: string) {
        const reserved = allocations(job.resultSnapshot);
        if (job.resultSnapshot.charged !== false && !reserved.length)
            throw new Error('AI reservation snapshot missing');
        for (const allocation of job.resultSnapshot.charged === false ? [] : reserved) {
            await sql`
                with inserted as (
                    insert into meal.ai_ledger(id,kind,delta,reserved_delta,recorded_at,idempotency_key,bucket_id,operation_id,compensates_id)
                    values(${randomUUID()}::uuid,'release',0,${-allocation.amount},now(),${`${job.id}:release:${allocation.bucketId}`},${allocation.bucketId}::uuid,${job.id}::uuid,null)
                    on conflict(idempotency_key) do nothing returning 1
                )
                update meal.ai_buckets set reserved_projection=reserved_projection-${allocation.amount},version=version+1
                where id=${allocation.bucketId}::uuid and reserved_projection>=${allocation.amount} and exists(select 1 from inserted)
            `.execute(tx);
        }
        const result = { ...job.resultSnapshot, failure: category, refunded: true };
        await sql`update meal.ai_operations set lifecycle_state='failed',result_snapshot=${JSON.stringify(result)}::jsonb,failure_category=${category},failure_retryable=false,finished_at=now(),version=version+1 where id=${job.id}::uuid and lifecycle_state='running' and lease_token=${job.leaseToken}::uuid`.execute(
            tx,
        );
        const includedContinuation = job.commandKind === 'continuation' && job.resultSnapshot.charged === false;
        await sql`update meal.ai_intervals set status=${includedContinuation ? 'completed' : 'refunded'},clarifications_used=case when ${includedContinuation} then greatest(0,clarifications_used-1) else clarifications_used end,version=version+1 where id=${job.intervalId}::uuid`.execute(
            tx,
        );
        await sql`update meal.ai_tasks set status=${job.commandKind === 'continuation' ? 'completed' : 'refunded'},version=version+1 where id=${job.taskId}::uuid`.execute(
            tx,
        );
    }

    private async claim(): Promise<Claimed[]> {
        return this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                await sql`select pg_advisory_xact_lock(187731,1)`.execute(tx);
                const spending = (
                    await sql<{
                        spent: string;
                    }>`select coalesce(sum(provider_cost),0)::text spent from meal.ai_operations where created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'`.execute(
                        tx,
                    )
                ).rows[0];
                let heldUnits = aiMoneyUnits(spending?.spent ?? '0');
                const candidates = await sql<{
                    id: string;
                    userId: string;
                    taskId: string;
                    intervalId: string;
                    conversationId: string;
                    messageId: string;
                    commandKind: string;
                    taskType: string;
                    prompt: string;
                    personalContext: unknown;
                    usePersonalData: boolean;
                    cost: number;
                    resultSnapshot: unknown;
                    attemptCount: number;
                    providerRequestId: string | null;
                    requestedModel: string | null;
                    providerProfileVersion: string;
                }>`select o.id,o.user_id "userId",o.task_id "taskId",o.interval_id "intervalId",t.conversation_id "conversationId",o.message_id "messageId",o.command_kind "commandKind",t.preview->>'taskType' "taskType",t.goal prompt,t.preview->'personalContext' "personalContext",coalesce((t.preview->>'usePersonalData')::boolean,false) "usePersonalData",t.accepted_cost::integer cost,o.result_snapshot "resultSnapshot",o.attempt_count::integer "attemptCount",o.provider_request_id "providerRequestId",o.requested_model "requestedModel",o.provider_profile_version "providerProfileVersion" from meal.ai_operations o join meal.ai_tasks t on t.id=o.task_id where o.contract_version=1 and o.lifecycle_state='queued' and o.next_attempt_at<=now() and o.expires_at>now() order by o.next_attempt_at,o.created_at,o.id limit ${this.config.AI_WORKER_BATCH_SIZE} for update of o skip locked`.execute(
                    tx,
                );
                const claimed: Claimed[] = [];
                for (const candidate of candidates.rows) {
                    const taskType = aiTaskTypeSchema.safeParse(candidate.taskType);
                    const cost = [1, 2, 3, 4, 5].includes(candidate.cost)
                        ? (candidate.cost as 1 | 2 | 3 | 4 | 5)
                        : null;
                    if (
                        !taskType.success ||
                        !cost ||
                        !candidate.requestedModel ||
                        !['initial', 'continuation'].includes(candidate.commandKind)
                    )
                        continue;
                    const leaseToken = randomUUID();
                    const clientRequestId = randomUUID();
                    const attemptNo = candidate.providerRequestId ? candidate.attemptCount : candidate.attemptCount + 1;
                    const tokenBudget = aiTokenBudget(cost);
                    const estimatedCost = candidate.providerRequestId
                        ? null
                        : aiProviderCost(this.config.providerProfile, {
                              inputTokens: tokenBudget.maxInputTokens,
                              outputTokens: tokenBudget.maxOutputTokens,
                          });
                    let localFailureCode: string | null = null;
                    if (
                        candidate.providerProfileVersion !== this.config.AI_PROVIDER_PROFILE_VERSION ||
                        candidate.requestedModel !== this.config.AI_MODEL
                    )
                        localFailureCode = candidate.providerRequestId
                            ? 'provider_profile_mismatch_after_submit'
                            : 'provider_profile_mismatch';
                    else if (
                        estimatedCost !== null &&
                        heldUnits + aiMoneyUnits(estimatedCost) > this.config.monthlyBudgetUnits
                    )
                        localFailureCode = 'provider_budget_exhausted';
                    const heldCost = localFailureCode ? '0.00000000' : estimatedCost;
                    if (heldCost !== null) heldUnits += aiMoneyUnits(heldCost);
                    const updated =
                        await sql`update meal.ai_operations set lifecycle_state='running',lease_owner=${this.config.AI_WORKER_OWNER_ID},lease_token=${leaseToken}::uuid,lease_until=now()+${this.config.AI_WORKER_LEASE_SECONDS}*interval '1 second',attempt_count=${attemptNo},provider_client_request_id=coalesce(provider_client_request_id,${clientRequestId}::uuid),provider_cost=coalesce(provider_cost,${heldCost}),version=version+1 where id=${candidate.id}::uuid and lifecycle_state='queued'`.execute(
                            tx,
                        );
                    if (!updated.numAffectedRows) continue;
                    let attemptId: string;
                    let stableClientRequestId: string = clientRequestId;
                    let startedAt = new Date();
                    if (candidate.providerRequestId) {
                        const attempt = (
                            await sql<{
                                id: string;
                                clientRequestId: string;
                                startedAt: Date;
                            }>`select id,client_request_id "clientRequestId",started_at "startedAt" from meal.ai_operation_attempts where operation_id=${candidate.id}::uuid and provider_request_id=${candidate.providerRequestId} order by attempt_no desc limit 1`.execute(
                                tx,
                            )
                        ).rows[0];
                        if (!attempt) throw new Error('AI provider attempt evidence missing');
                        attemptId = attempt.id;
                        stableClientRequestId = attempt.clientRequestId;
                        startedAt = attempt.startedAt;
                    } else {
                        attemptId = randomUUID();
                        await sql`insert into meal.ai_operation_attempts(id,operation_id,attempt_no,state,client_request_id,lease_token,requested_model,estimated_cost,started_at) values(${attemptId}::uuid,${candidate.id}::uuid,${attemptNo},'prepared',${clientRequestId}::uuid,${leaseToken}::uuid,${candidate.requestedModel},${heldCost},${startedAt})`.execute(
                            tx,
                        );
                    }
                    claimed.push({
                        ...candidate,
                        commandKind: candidate.commandKind as Claimed['commandKind'],
                        taskType: taskType.data,
                        cost,
                        resultSnapshot: (candidate.resultSnapshot ?? {}) as Record<string, unknown>,
                        attemptId,
                        attemptNo,
                        clientRequestId: stableClientRequestId,
                        leaseToken,
                        startedAt,
                        localFailureCode,
                    });
                }
                return claimed;
            });
    }

    private async prompt(job: Claimed) {
        const context = job.usePersonalData ? parseAiContextSnapshot(job.personalContext) : null;
        if (job.commandKind === 'continuation') {
            const messages = await sql<{
                role: string;
                body: string;
            }>`select role,body from (select m.role,m.body,m.created_at,m.id from meal.ai_messages m where m.conversation_id=${job.conversationId}::uuid order by m.created_at desc,m.id desc limit 40) recent order by created_at,id`.execute(
                this.db,
            );
            const dialogue = messages.rows
                .map((message) => `${message.role === 'assistant' ? 'Помощник' : 'Пользователь'}: ${message.body}`)
                .join('\n\n');
            return `Тип задачи: ${job.taskType}\nПродолжи ту же цель беседы. История:\n${dialogue}\n\nРазрешённый снимок контекста:\n${renderAiContext(context)}`;
        }
        return `Тип задачи: ${job.taskType}\nЗапрос пользователя:\n${job.prompt}\n\nРазрешённый снимок контекста:\n${renderAiContext(context)}`;
    }

    private async pending(job: Claimed, result: Extract<AiBackgroundResult, { state: 'pending' }>) {
        await this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                if (!(await this.fenced(tx, job))) return;
                await sql`update meal.ai_operation_attempts set state='submitted',provider_request_id=${result.providerRequestId},actual_model=${result.actualModel},service_tier=${result.serviceTier},submitted_at=coalesce(submitted_at,now()) where id=${job.attemptId}::uuid and state='prepared'`.execute(
                    tx,
                );
                await sql`update meal.ai_operation_attempts set state='polling' where id=${job.attemptId}::uuid and state='submitted'`.execute(
                    tx,
                );
                await sql`update meal.ai_operations set lifecycle_state='queued',provider_request_id=${result.providerRequestId},actual_model=${result.actualModel},service_tier=${result.serviceTier},next_attempt_at=now()+${this.config.AI_WORKER_PROVIDER_POLL_MS}*interval '1 millisecond',version=version+1 where id=${job.id}::uuid and lifecycle_state='running' and lease_token=${job.leaseToken}::uuid`.execute(
                    tx,
                );
            });
    }

    private async unknown(job: Claimed, category = 'provider_outcome_unknown') {
        await this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                if (!(await this.fenced(tx, job))) return;
                await sql`update meal.ai_operation_attempts set state='unknown',error_category='provider_outcome_unknown',error_code=${category},submitted_at=coalesce(submitted_at,now()),finished_at=now() where id=${job.attemptId}::uuid and state in ('prepared','submitted','polling')`.execute(
                    tx,
                );
                await sql`update meal.ai_operations set lifecycle_state='unknown',financial_state='reconciliation_hold',result_snapshot=jsonb_set(coalesce(result_snapshot,'{}'::jsonb),'{failure}',to_jsonb(${category}::text),true),failure_category=${category},failure_retryable=false,version=version+1 where id=${job.id}::uuid and lifecycle_state='running' and lease_token=${job.leaseToken}::uuid`.execute(
                    tx,
                );
            });
    }

    private async failed(
        job: Claimed,
        category: string,
        errorCode: string,
        usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null = null,
    ) {
        const actualCost = usage ? aiProviderCost(this.config.providerProfile, usage) : '0.00000000';
        const attemptCategory = category === 'access_revoked' ? 'safety_rejected' : category;
        await this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                if (!(await this.fenced(tx, job))) return;
                await sql`update meal.ai_operation_attempts set state='failed',input_tokens=${usage?.inputTokens ?? null},output_tokens=${usage?.outputTokens ?? null},reasoning_tokens=${usage?.reasoningTokens ?? null},actual_cost=${actualCost},error_category=${attemptCategory},error_code=${errorCode},submitted_at=coalesce(submitted_at,now()),finished_at=now() where id=${job.attemptId}::uuid and state in ('prepared','submitted','polling')`.execute(
                    tx,
                );
                await sql`update meal.ai_operations set provider_cost=${actualCost},token_usage=${usage ? JSON.stringify(usage) : null}::jsonb where id=${job.id}::uuid and lifecycle_state='running' and lease_token=${job.leaseToken}::uuid`.execute(
                    tx,
                );
                await this.release(tx, job, category);
            });
    }

    private async succeeded(job: Claimed, result: Extract<AiBackgroundResult, { state: 'succeeded' }>) {
        const actualCost = aiProviderCost(this.config.providerProfile, result.usage);
        await this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                if (!(await this.fenced(tx, job))) return;
                const reserved = allocations(job.resultSnapshot);
                if (job.resultSnapshot.charged !== false && !reserved.length)
                    throw new Error('AI reservation snapshot missing');
                for (const allocation of job.resultSnapshot.charged === false ? [] : reserved) {
                    await sql`with inserted as (insert into meal.ai_ledger(id,kind,delta,reserved_delta,recorded_at,idempotency_key,bucket_id,operation_id,compensates_id) values(${randomUUID()}::uuid,'capture',${-allocation.amount},${-allocation.amount},now(),${`${job.id}:capture:${allocation.bucketId}`},${allocation.bucketId}::uuid,${job.id}::uuid,null) on conflict(idempotency_key) do nothing returning 1) update meal.ai_buckets set balance_projection=balance_projection-${allocation.amount},reserved_projection=reserved_projection-${allocation.amount},version=version+1 where id=${allocation.bucketId}::uuid and reserved_projection>=${allocation.amount} and exists(select 1 from inserted)`.execute(
                        tx,
                    );
                }
                await sql`insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id) values(${randomUUID()}::uuid,'assistant',${result.answer},${`${job.id}:assistant`},${job.conversationId}::uuid,${job.intervalId}::uuid) on conflict(conversation_id,client_message_key) do nothing`.execute(
                    tx,
                );
                await sql`update meal.ai_operation_attempts set state='submitted',provider_request_id=${result.providerRequestId},actual_model=${result.actualModel},service_tier=${result.serviceTier},submitted_at=coalesce(submitted_at,now()) where id=${job.attemptId}::uuid and state='prepared'`.execute(
                    tx,
                );
                await sql`update meal.ai_operation_attempts set state='succeeded',provider_request_id=${result.providerRequestId},actual_model=${result.actualModel},service_tier=${result.serviceTier},input_tokens=${result.usage.inputTokens},output_tokens=${result.usage.outputTokens},reasoning_tokens=${result.usage.reasoningTokens},actual_cost=${actualCost},finished_at=now(),latency_ms=least(3600000,greatest(0,(extract(epoch from now()-started_at)*1000)::integer)) where id=${job.attemptId}::uuid and state in ('submitted','polling')`.execute(
                    tx,
                );
                const snapshot = { ...job.resultSnapshot, text: result.answer };
                await sql`update meal.ai_operations set lifecycle_state='succeeded',result_snapshot=${JSON.stringify(snapshot)}::jsonb,provider_request_id=${result.providerRequestId},actual_model=${result.actualModel},service_tier=${result.serviceTier},token_usage=${JSON.stringify(result.usage)}::jsonb,provider_cost=${actualCost},finished_at=now(),version=version+1 where id=${job.id}::uuid and lifecycle_state='running' and lease_token=${job.leaseToken}::uuid`.execute(
                    tx,
                );
                await sql`update meal.ai_intervals set status='completed',version=version+1 where id=${job.intervalId}::uuid`.execute(
                    tx,
                );
                await sql`update meal.ai_tasks set status='completed',version=version+1 where id=${job.taskId}::uuid`.execute(
                    tx,
                );
            });
    }

    private async process(job: Claimed) {
        if (job.localFailureCode === 'provider_profile_mismatch_after_submit')
            return this.unknown(job, job.localFailureCode);
        if (job.localFailureCode) return this.failed(job, 'provider_error', job.localFailureCode);
        if (!job.providerRequestId && !(await this.authorized(job)))
            return this.failed(job, 'access_revoked', 'access_revoked');
        let result: AiBackgroundResult;
        try {
            result = job.providerRequestId
                ? await this.provider.retrieveBackground(job.providerRequestId)
                : await this.provider.submitBackground(
                      await this.prompt(job),
                      aiTokenBudget(job.cost),
                      job.clientRequestId,
                  );
        } catch (error) {
            if (error instanceof AiProviderError && error.disposition === 'release')
                return this.failed(job, 'provider_error', 'provider_rejected');
            return this.unknown(job);
        }
        if (result.state === 'pending') return this.pending(job, result);
        if (result.state === 'failed') return this.failed(job, 'provider_error', result.errorCode, result.usage);
        return this.succeeded(job, result);
    }

    private async reapExpired() {
        return this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                const expired = await sql<{
                    id: string;
                }>`select id from meal.ai_operations where lifecycle_state='running' and lease_until<=now() order by lease_until,id limit ${this.config.AI_WORKER_BATCH_SIZE} for update skip locked`.execute(
                    tx,
                );
                for (const operation of expired.rows) {
                    await sql`update meal.ai_operation_attempts set state='unknown',error_category='process_interrupted',error_code='lease_expired',submitted_at=coalesce(submitted_at,now()),finished_at=now() where operation_id=${operation.id}::uuid and state in ('prepared','submitted','polling')`.execute(
                        tx,
                    );
                    await sql`update meal.ai_operations set lifecycle_state='unknown',financial_state='reconciliation_hold',failure_category='process_interrupted',failure_retryable=false,result_snapshot=jsonb_set(coalesce(result_snapshot,'{}'::jsonb),'{failure}','"process_interrupted"'::jsonb,true),version=version+1 where id=${operation.id}::uuid and lifecycle_state='running'`.execute(
                        tx,
                    );
                }
                return expired.rows.length;
            });
    }

    async runOnce() {
        await this.reapExpired();
        const jobs = await this.claim();
        for (const job of jobs) await this.process(job);
        return jobs.length;
    }
}
