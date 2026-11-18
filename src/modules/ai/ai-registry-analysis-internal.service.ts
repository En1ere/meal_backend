import { ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/public.js';
import { classifyCulinaryQuestion } from './ai-culinary-question.js';
import { classifyIngredientExtractionText, sanitizeIngredientExtractionText } from './ai-ingredient-extraction.js';
import { aiV4ProviderProfiles } from './ai-policy-v4.js';
import { aiV2RegistryFactsSnapshotSchema, registryWarningCodes } from './ai-registry-analysis.js';
import { AiV2RegistryAnalysisExecutor } from './ai-registry-analysis-executor.js';
import { AiService } from './ai.service.js';
import {
    aiV2RegistryExplainResultSchema,
    aiV2RegistryFactsResultSchema,
    aiV2RunRequestSchema,
    parseAiV2PreviewRequest,
} from './ai-v2.contracts.js';
import { aiV2TaskContractColumns, aiV2TaskPreviewSnapshot, prepareAiV2Preview } from './ai-v2-preview.js';

type Tx = Transaction<DatabaseSchema>;
type Allocation = { bucketId: string; amount: number };

function moscowDate(clock = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(clock);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
}

const factsTaskSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('registry_analysis'),
    task: z.literal('registry_analysis'),
    mode: z.literal('facts'),
    input: z.strictObject({ query: z.string().trim().min(3).max(500) }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    facts: aiV2RegistryFactsSnapshotSchema,
});

const explainTaskSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('registry_analysis'),
    task: z.literal('registry_analysis'),
    mode: z.literal('explain'),
    input: z.strictObject({ factsId: z.uuid(), question: z.string().trim().min(1).max(500).optional() }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    facts: aiV2RegistryFactsSnapshotSchema,
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

@Injectable()
export class AiV2RegistryAnalysisInternalService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly quota: AiService,
        private readonly executor: AiV2RegistryAnalysisExecutor,
    ) {}

    private async writable(tx: Tx, userId: string) {
        const user = await sql`
            select id from meal.users
             where id=${userId}::uuid and status='active' and archived_at is null for update
        `.execute(tx);
        if (!user.rows.length) throw new HttpException('Аккаунт недоступен', 403);
        const sanction = await sql`
            select id from meal.sanctions
             where user_id=${userId}::uuid and scope in('account','ai') and revoked_at is null
               and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1
        `.execute(tx);
        if (sanction.rows.length) throw new HttpException('Доступен только просмотр', 403);
    }

    private async dependencies(tx: Tx, userId: string) {
        const scope = (
            await sql<{ id: string; version: number }>`
                select id,version::integer from meal.data_scopes
                 where kind='private' and user_id=${userId}::uuid limit 1
            `.execute(tx)
        ).rows[0];
        const rule = (
            await sql<{ id: string }>`
                select id from meal.ai_rule_versions where kind='cost' and version=4 and effective_at<=now() limit 1
            `.execute(tx)
        ).rows[0];
        if (!scope || !rule) throw new ServiceUnavailableException('AI v2 dependencies are not configured');
        return { scope, ruleId: rule.id };
    }

    private safeText(raw: string) {
        const text = sanitizeIngredientExtractionText(raw).text;
        if (classifyIngredientExtractionText(text) !== 'safe' || classifyCulinaryQuestion(text) !== 'safe')
            throw new ConflictException('Запрос должен быть коротким безопасным вопросом о реестре запасов');
        return text;
    }

    private async buildFacts(tx: Tx, userId: string, query: string, options?: { id?: string; asOfDate?: string }) {
        const dependency = await this.dependencies(tx, userId);
        const asOfDate = options?.asOfDate ?? moscowDate();
        const sourceRows = (
            await sql<{ id: string; version: number }>`
                select id,version::integer from meal.inventory_batches
                 where scope_id=${dependency.scope.id}::uuid and archived_at is null
                 order by id limit 5001
            `.execute(tx)
        ).rows;
        if (sourceRows.length > 5_000) throw new ConflictException('Реестр слишком большой для безопасного анализа');
        const aggregate = (
            await sql<{
                activeBatches: number;
                distinctItems: number;
                expiredBatches: number;
                expiringBatches: number;
                unknownQuantityBatches: number;
                unknownExpiryBatches: number;
                openedBatches: number;
            }>`
                select count(*)::integer "activeBatches",
                       count(distinct coalesce(
                           batch.product_id::text,batch.variant_id::text,batch.ingredient_id::text,lower(batch.name)
                       ))::integer "distinctItems",
                       count(*) filter(where batch.expiry_on<${asOfDate}::date)::integer "expiredBatches",
                       count(*) filter(where batch.expiry_on between ${asOfDate}::date and ${asOfDate}::date+7)::integer "expiringBatches",
                       count(*) filter(where not batch.quantity_known or batch.quantity is null)::integer "unknownQuantityBatches",
                       count(*) filter(where batch.expiry_on is null)::integer "unknownExpiryBatches",
                       count(*) filter(where batch.opened_at is not null)::integer "openedBatches"
                  from meal.inventory_batches batch
                 where batch.scope_id=${dependency.scope.id}::uuid and batch.archived_at is null
            `.execute(tx)
        ).rows[0];
        if (!aggregate) throw new ServiceUnavailableException('Registry facts are unavailable');
        const facts = [
            { key: 'active_batches' as const, value: aggregate.activeBatches, unit: 'batches' as const },
            { key: 'distinct_items' as const, value: aggregate.distinctItems, unit: 'items' as const },
            { key: 'expired_batches' as const, value: aggregate.expiredBatches, unit: 'batches' as const },
            { key: 'expiring_7d_batches' as const, value: aggregate.expiringBatches, unit: 'batches' as const },
            {
                key: 'unknown_quantity_batches' as const,
                value: aggregate.unknownQuantityBatches,
                unit: 'batches' as const,
            },
            {
                key: 'unknown_expiry_batches' as const,
                value: aggregate.unknownExpiryBatches,
                unit: 'batches' as const,
            },
            { key: 'opened_batches' as const, value: aggregate.openedBatches, unit: 'batches' as const },
        ];
        return aiV2RegistryFactsSnapshotSchema.parse({
            id: options?.id ?? randomUUID(),
            scope: 'personal',
            scopeId: dependency.scope.id,
            scopeVersion: dependency.scope.version,
            query,
            asOfDate,
            sourceCount: sourceRows.length,
            sourceHash: createHash('sha256')
                .update(
                    JSON.stringify({
                        scopeId: dependency.scope.id,
                        scopeVersion: dependency.scope.version,
                        asOfDate,
                        refs: sourceRows,
                    }),
                )
                .digest('hex'),
            facts,
            warningCodes: registryWarningCodes(facts),
        });
    }

    async facts(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'registry_analysis' || request.mode !== 'facts')
            throw new ConflictException('Internal registry facts task expected');
        const input = z.strictObject({ query: z.string().trim().min(3).max(500) }).parse(request.input);
        const query = this.safeText(input.query);
        const normalized = { task: 'registry_analysis' as const, mode: 'facts', input: { query } };
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const entitlement = await this.entitlements.resolve(userId, tx);
            const snapshot = await this.buildFacts(tx, userId, query);
            const now = new Date();
            const previewId = randomUUID();
            const prepared = prepareAiV2Preview(normalized, {
                plan: entitlement.plan,
                offeredSources: [],
                readyProviderProfileVersions: new Set(),
                sourceSnapshotHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
                now,
                previewId,
            });
            const stored = factsTaskSnapshotSchema.parse({ ...aiV2TaskPreviewSnapshot(prepared), facts: snapshot });
            const dependency = await this.dependencies(tx, userId);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Анализ личного реестра',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.scope.id,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: query,
                    status: 'completed',
                    preview: sql`${JSON.stringify(stored)}::jsonb`,
                    accepted_at: now,
                    agreement_snapshot: {
                        version: 'ai-v2-backend-personal-registry-facts',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: dependency.ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return aiV2RegistryFactsResultSchema.parse({
                schemaVersion: 'ai-result-contract-v2:registry_analysis:facts',
                factsId: snapshot.id,
                scope: snapshot.scope,
                asOfDate: snapshot.asOfDate,
                facts: snapshot.facts,
                warningCodes: snapshot.warningCodes,
            });
        });
    }

    private async resolveFacts(tx: Tx, userId: string, factsId: string) {
        const tasks = (
            await sql<{ preview: unknown }>`
                select task.preview from meal.ai_tasks task
                join meal.ai_conversations conversation on conversation.id=task.conversation_id
                 where conversation.user_id=${userId}::uuid and task.contract_version=2
                   and task.task_code='registry_analysis' and task.task_mode='facts'
                   and task.status='completed' and (task.preview->>'expiresAt')::timestamptz>now()
                 order by task.created_at desc limit 20
            `.execute(tx)
        ).rows;
        const found = tasks
            .map((task) => factsTaskSnapshotSchema.parse(task.preview))
            .find((task) => task.facts.id === factsId);
        if (!found) throw new ConflictException('Факты реестра недоступны');
        const current = await this.buildFacts(tx, userId, found.facts.query, {
            id: found.facts.id,
            asOfDate: found.facts.asOfDate,
        });
        if (JSON.stringify(current) !== JSON.stringify(found.facts)) throw new ConflictException('Реестр изменился');
        return current;
    }

    async previewExplain(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'registry_analysis' || request.mode !== 'explain')
            throw new ConflictException('Internal registry explanation task expected');
        const input = z
            .strictObject({ factsId: z.uuid(), question: z.string().trim().min(1).max(500).optional() })
            .parse(request.input);
        const question = input.question ? this.safeText(input.question) : undefined;
        if ((await this.quota.balance(userId)).available < 1) throw new ConflictException('Недостаточно AI-действий');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const snapshot = await this.resolveFacts(tx, userId, input.factsId);
            const entitlement = await this.entitlements.resolve(userId, tx);
            const normalized = {
                task: 'registry_analysis' as const,
                mode: 'explain',
                input: { factsId: input.factsId, ...(question ? { question } : {}) },
            };
            const now = new Date();
            const previewId = randomUUID();
            const prepared = prepareAiV2Preview(normalized, {
                plan: entitlement.plan,
                offeredSources: [],
                readyProviderProfileVersions: new Set([aiV4ProviderProfiles.economy.version]),
                sourceSnapshotHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
                now,
                previewId,
            });
            const stored = explainTaskSnapshotSchema.parse({
                ...aiV2TaskPreviewSnapshot(prepared),
                facts: snapshot,
                requestHash: prepared.frozen.requestHash,
            });
            const dependency = await this.dependencies(tx, userId);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Объяснение реестра',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.scope.id,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: question ?? snapshot.query,
                    status: 'preview',
                    preview: sql`${JSON.stringify(stored)}::jsonb`,
                    accepted_at: null,
                    agreement_snapshot: {
                        version: 'ai-v2-internal-simulator',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: dependency.ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return { kind: 'preview' as const, preview: prepared.preview };
        });
    }

    private async reserve(userId: string, raw: unknown) {
        const input = aiV2RunRequestSchema.parse(raw);
        await this.quota.balance(userId);
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const requestHash = createHash('sha256')
                .update(JSON.stringify({ contractVersion: 2, previewId: input.previewId }))
                .digest('hex');
            const existing = (
                await sql<{ operationId: string; requestHash: string }>`
                    select id "operationId",request_hash "requestHash" from meal.ai_operations
                     where user_id=${userId}::uuid and idempotency_key=${input.idempotencyKey}
                       and contract_version=2 for update
                `.execute(tx)
            ).rows[0];
            if (existing) {
                if (existing.requestHash !== requestHash)
                    throw new ConflictException('Ключ идемпотентности использован с другим запросом');
                return { replayed: true as const, operationId: existing.operationId };
            }
            const task = (
                await sql<{
                    id: string;
                    conversationId: string;
                    preview: unknown;
                    route: 'economy';
                    taskPolicyVersion: string;
                    contextPolicyVersion: string;
                    routingPolicyVersion: string;
                    pricePolicyVersion: string;
                    resultSchemaVersion: string;
                    safetyPolicyVersion: string;
                    cachePolicyVersion: string;
                    providerProfileVersion: string;
                }>`
                    select task.id,task.conversation_id "conversationId",task.preview,
                           task.execution_route route,task.task_policy_version "taskPolicyVersion",
                           task.context_policy_version "contextPolicyVersion",
                           task.routing_policy_version "routingPolicyVersion",
                           task.price_policy_version "pricePolicyVersion",
                           task.result_schema_version "resultSchemaVersion",
                           task.safety_policy_version "safetyPolicyVersion",
                           task.cache_policy_version "cachePolicyVersion",
                           task.provider_profile_version "providerProfileVersion"
                      from meal.ai_tasks task join meal.ai_conversations conversation on conversation.id=task.conversation_id
                     where task.id=${input.previewId}::uuid and conversation.user_id=${userId}::uuid
                       and task.contract_version=2 and task.task_code='registry_analysis'
                       and task.task_mode='explain' and task.status='preview' for update of task
                `.execute(tx)
            ).rows[0];
            if (!task) throw new ConflictException('AI-предпросмотр недоступен');
            const preview = explainTaskSnapshotSchema.parse(task.preview);
            if (preview.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            if (preview.input.question) this.safeText(preview.input.question);
            const facts = await this.resolveFacts(tx, userId, preview.input.factsId);
            if (JSON.stringify(facts) !== JSON.stringify(preview.facts))
                throw new ConflictException('Реестр изменился');
            const entitlement = await this.entitlements.resolve(userId, tx);
            prepareAiV2Preview(
                { task: 'registry_analysis', mode: 'explain', input: preview.input },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set([aiV4ProviderProfiles.economy.version]),
                    sourceSnapshotHash: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
                },
            );
            const buckets = (
                await sql<{ id: string; available: number }>`
                    select id,(balance_projection-reserved_projection)::integer available
                      from meal.ai_buckets
                     where user_id=${userId}::uuid and balance_projection>reserved_projection
                       and (expires_at is null or expires_at>now())
                       and (kind<>'subscription' or exists(
                           select 1 from meal.ai_quota_periods quota
                           left join meal.subscriptions subscription on subscription.id=quota.subscription_id
                           left join meal.family_coverages coverage on coverage.id=quota.family_coverage_id
                          where quota.id=ai_buckets.quota_period_id
                            and ((quota.subscription_id is not null and subscription.status='active')
                              or (quota.family_coverage_id is not null and coverage.selected_at is not null
                                and (coverage.ends_at is null or coverage.ends_at>now())))
                       ))
                     order by case kind when 'subscription' then 1 when 'transferred' then 2
                                        when 'trial' then 3 when 'purchased' then 4 else 5 end,
                              expires_at nulls last,created_at,id for update
                `.execute(tx)
            ).rows;
            const bucket = buckets.find((item) => item.available >= 1);
            if (!bucket) throw new ConflictException('Недостаточно AI-действий');
            const allocation: Allocation = { bucketId: bucket.id, amount: 1 };
            const operationId = randomUUID();
            const intervalId = randomUUID();
            const messageId = randomUUID();
            const clientRequestId = randomUUID();
            const now = new Date();
            await tx
                .insertInto('ai_intervals')
                .values({
                    id: intervalId,
                    starts_at: now,
                    ends_at: new Date(now.getTime() + 10 * 60_000),
                    clarifications_used: 0,
                    cost: 1,
                    status: 'processing',
                    task_id: task.id,
                })
                .execute();
            await tx
                .insertInto('ai_messages')
                .values({
                    id: messageId,
                    role: 'user',
                    body: preview.input.question ?? facts.query,
                    client_message_key: input.idempotencyKey,
                    conversation_id: task.conversationId,
                    interval_id: intervalId,
                })
                .execute();
            await sql`
                insert into meal.ai_operations(
                    id,status,result_snapshot,started_at,finished_at,provider_cost,idempotency_key,interval_id,message_id,
                    user_id,task_id,contract_version,command_kind,request_hash,lifecycle_state,financial_state,
                    queued_at,next_attempt_at,requested_model,task_policy_version,context_manifest_version,
                    provider_profile_version,execution_route,routing_policy_version,price_policy_version,
                    result_schema_version,safety_policy_version,cache_policy_version,provider_cost_state,
                    provider_cost_currency,updated_at,expires_at
                ) values(
                    ${operationId}::uuid,'processing',${JSON.stringify({ allocations: [allocation] })}::jsonb,${now},null,null,
                    ${input.idempotencyKey},${intervalId}::uuid,${messageId}::uuid,${userId}::uuid,${task.id}::uuid,
                    2,'initial',${requestHash},'queued','reserved',${now},${now},'simulator-economy-v1',
                    ${task.taskPolicyVersion},${task.contextPolicyVersion},${task.providerProfileVersion},${task.route},
                    ${task.routingPolicyVersion},${task.pricePolicyVersion},${task.resultSchemaVersion},
                    ${task.safetyPolicyVersion},${task.cachePolicyVersion},'none','RUB',${now},
                    ${new Date(now.getTime() + 30 * 86_400_000)}
                )
            `.execute(tx);
            await sql`
                insert into meal.ai_ledger(
                    id,kind,delta,reserved_delta,recorded_at,idempotency_key,bucket_id,operation_id,compensates_id
                ) values(
                    ${randomUUID()}::uuid,'reserve',0,1,${now},${`${operationId}:reserve:${bucket.id}`},
                    ${bucket.id}::uuid,${operationId}::uuid,null
                )
            `.execute(tx);
            await sql`
                update meal.ai_buckets set reserved_projection=reserved_projection+1,version=version+1
                 where id=${bucket.id}::uuid and balance_projection>reserved_projection
            `.execute(tx);
            await sql`
                insert into meal.ai_provider_dispatches(
                    operation_id,client_request_id,profile_version,requested_model,state,
                    estimated_cost_rub,created_at,updated_at
                ) values(
                    ${operationId}::uuid,${clientRequestId}::uuid,${task.providerProfileVersion},
                    'simulator-economy-v1','prepared',1.00000000,${now},${now}
                )
            `.execute(tx);
            await sql`
                update meal.ai_tasks set status='processing',accepted_at=${now},version=version+1
                 where id=${task.id}::uuid and status='preview'
            `.execute(tx);
            return {
                replayed: false as const,
                operationId,
                clientRequestId,
                facts,
                question: preview.input.question,
                clock: now,
            };
        });
    }

    private async projectOperation(operationId: string) {
        await this.database.transaction(async (tx) => {
            const row = (
                await sql<{
                    state: string;
                    result: unknown;
                    intervalId: string;
                    taskId: string;
                    conversationId: string;
                }>`
                    select operation.lifecycle_state state,operation.result_snapshot result,
                           operation.interval_id "intervalId",operation.task_id "taskId",
                           task.conversation_id "conversationId"
                      from meal.ai_operations operation join meal.ai_tasks task on task.id=operation.task_id
                     where operation.id=${operationId}::uuid and operation.contract_version=2
                     for update of operation,task
                `.execute(tx)
            ).rows[0];
            if (!row) throw new ConflictException('AI-операция недоступна');
            if (row.state === 'succeeded') {
                const result = aiV2RegistryExplainResultSchema.parse(row.result);
                await sql`
                    insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id)
                    values(
                        ${randomUUID()}::uuid,'assistant',${result.explanation},${`${operationId}:assistant`},
                        ${row.conversationId}::uuid,${row.intervalId}::uuid
                    ) on conflict(conversation_id,client_message_key) do nothing
                `.execute(tx);
                await sql`
                    update meal.ai_intervals set status='completed',version=version+1
                     where id=${row.intervalId}::uuid and status='processing'
                `.execute(tx);
                await sql`
                    update meal.ai_tasks set status='completed',version=version+1
                     where id=${row.taskId}::uuid and status='processing'
                `.execute(tx);
            } else if (['failed', 'cancelled'].includes(row.state)) {
                await sql`
                    update meal.ai_intervals set status='refunded',version=version+1
                     where id=${row.intervalId}::uuid and status='processing'
                `.execute(tx);
                await sql`
                    update meal.ai_tasks set status='failed',version=version+1
                     where id=${row.taskId}::uuid and status='processing'
                `.execute(tx);
            }
        });
    }

    async runSimulator(userId: string, raw: unknown) {
        const reserved = await this.reserve(userId, raw);
        if (reserved.replayed) return { operationId: reserved.operationId, replayed: true as const };
        const submitted = await this.executor.submit({
            operationId: reserved.operationId,
            dispatchVersion: 1,
            clientRequestId: reserved.clientRequestId,
            snapshot: reserved.facts,
            ...(reserved.question ? { question: reserved.question } : {}),
            clock: new Date(reserved.clock.getTime() + 1),
        });
        if (submitted?.outcome.kind === 'accepted')
            await this.executor.read({
                operationId: reserved.operationId,
                dispatchVersion: submitted.nextVersion,
                snapshot: reserved.facts,
                clock: new Date(reserved.clock.getTime() + 4),
            });
        await this.projectOperation(reserved.operationId);
        return { operationId: reserved.operationId, replayed: false as const };
    }
}
