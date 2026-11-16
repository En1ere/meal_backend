import { ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/public.js';
import { classifyIngredientExtractionText, sanitizeIngredientExtractionText } from './ai-ingredient-extraction.js';
import { aiV4ProviderProfiles } from './ai-policy-v4.js';
import { AiV2ProductClassificationExecutor } from './ai-product-classification-executor.js';
import { aiV2ProductClassificationShortlistSchema } from './ai-product-classification.js';
import { AiService } from './ai.service.js';
import {
    aiV2ProductClassificationResultSchema,
    aiV2RunRequestSchema,
    parseAiV2PreviewRequest,
} from './ai-v2.contracts.js';
import { aiV2TaskContractColumns, aiV2TaskPreviewSnapshot, prepareAiV2Preview } from './ai-v2-preview.js';

type Tx = Transaction<DatabaseSchema>;
type Allocation = { bucketId: string; amount: number };

const shortlistSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('product_classification'),
    task: z.literal('product_classification'),
    mode: z.literal('candidates'),
    input: z.strictObject({ query: z.string().trim().min(1).max(500) }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    shortlist: aiV2ProductClassificationShortlistSchema,
});

const classifySnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('product_classification'),
    task: z.literal('product_classification'),
    mode: z.literal('classify'),
    input: z.strictObject({ shortlistId: z.uuid() }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    shortlist: aiV2ProductClassificationShortlistSchema,
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

@Injectable()
export class AiV2ProductClassificationInternalService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly quota: AiService,
        private readonly executor: AiV2ProductClassificationExecutor,
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
            await sql<{
                id: string;
            }>`select id from meal.data_scopes where kind='private' and user_id=${userId}::uuid limit 1`.execute(tx)
        ).rows[0];
        if (!scope) throw new ServiceUnavailableException('Personal data scope is not configured');
        const rule = (
            await sql<{
                id: string;
            }>`select id from meal.ai_rule_versions where kind='cost' and version=4 and effective_at<=now() limit 1`.execute(
                tx,
            )
        ).rows[0];
        if (!rule) throw new ServiceUnavailableException('AI v2 policies are not configured');
        return { scopeId: scope.id, ruleId: rule.id };
    }

    async candidates(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'product_classification' || request.mode !== 'candidates')
            throw new ConflictException('Internal product classification candidates task expected');
        const sanitized = sanitizeIngredientExtractionText(z.string().parse(request.input.query));
        if (classifyIngredientExtractionText(sanitized.text) !== 'safe')
            throw new ConflictException('Разрешён только короткий текстовый запрос');
        const normalizedRequest = {
            task: 'product_classification' as const,
            mode: 'candidates',
            input: { query: sanitized.text },
        };
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const entitlement = await this.entitlements.resolve(userId, tx);
            const rows = (
                await sql<{
                    ingredientId: string;
                    ingredientVersion: number;
                    name: string;
                    categoryId: string;
                    categoryVersion: number;
                    matchRank: number;
                }>`
                    select ingredient.id "ingredientId",ingredient.version::integer "ingredientVersion",
                           ingredient.name,category.id "categoryId",category.version::integer "categoryVersion",
                           case
                               when lower(ingredient.name)=lower(${sanitized.text}) then 0
                               when exists(select 1 from jsonb_array_elements_text(coalesce(ingredient.aliases,'[]'::jsonb)) a(value)
                                            where lower(a.value)=lower(${sanitized.text})) then 1
                               when lower(ingredient.name) like lower(${`${sanitized.text}%`}) then 2
                               when exists(select 1 from jsonb_array_elements_text(coalesce(ingredient.aliases,'[]'::jsonb)) a(value)
                                            where lower(a.value) like lower(${`${sanitized.text}%`})) then 3
                               else 4 end "matchRank"
                      from meal.ingredients ingredient
                      join meal.categories category on category.id=ingredient.primary_category_id
                     where ingredient.status in('active','approved','published') and (
                           position(lower(${sanitized.text}) in lower(ingredient.name))>0
                           or exists(
                               select 1 from jsonb_array_elements_text(coalesce(ingredient.aliases,'[]'::jsonb)) alias(value)
                                where position(lower(${sanitized.text}) in lower(alias.value))>0
                           )
                     )
                     order by "matchRank",lower(ingredient.name),ingredient.id limit 8
                `.execute(tx)
            ).rows;
            const shortlist = aiV2ProductClassificationShortlistSchema.parse({
                id: randomUUID(),
                query: sanitized.text,
                candidates: rows.map(({ matchRank, ...row }, index) => ({
                    key: index + 1,
                    ...row,
                    matchKind: matchRank <= 1 ? 'exact' : matchRank <= 3 ? 'prefix' : 'contains',
                })),
            });
            const now = new Date();
            const previewId = randomUUID();
            const sourceSnapshotHash = createHash('sha256').update(JSON.stringify(shortlist)).digest('hex');
            const prepared = prepareAiV2Preview(normalizedRequest, {
                plan: entitlement.plan,
                offeredSources: [],
                readyProviderProfileVersions: new Set(),
                sourceSnapshotHash,
                now,
                previewId,
            });
            const snapshot = shortlistSnapshotSchema.parse({ ...aiV2TaskPreviewSnapshot(prepared), shortlist });
            const dependency = await this.dependencies(tx, userId);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Кандидаты классификации',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.scopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: sanitized.text,
                    status: 'completed',
                    preview: sql`${JSON.stringify(snapshot)}::jsonb`,
                    accepted_at: now,
                    agreement_snapshot: {
                        version: 'ai-v2-backend-product-classification-candidates',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: dependency.ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return {
                schemaVersion: 'ai-result-contract-v2:product_classification:candidates' as const,
                shortlistId: shortlist.id,
                candidates: shortlist.candidates.map((candidate) => ({
                    id: candidate.ingredientId,
                    name: candidate.name,
                })),
                expiresAt: prepared.preview.expiresAt,
            };
        });
    }

    private async resolveShortlist(tx: Tx, userId: string, shortlistId: string) {
        const tasks = (
            await sql<{ preview: unknown }>`
                select task.preview
                  from meal.ai_tasks task join meal.ai_conversations conversation on conversation.id=task.conversation_id
                 where conversation.user_id=${userId}::uuid and task.contract_version=2
                   and task.task_code='product_classification' and task.task_mode='candidates'
                   and task.status='completed' and (task.preview->>'expiresAt')::timestamptz>now()
                 order by task.created_at desc limit 20
            `.execute(tx)
        ).rows;
        const shortlist = tasks
            .map((task) => shortlistSnapshotSchema.parse(task.preview).shortlist)
            .find((item) => item.id === shortlistId);
        if (!shortlist) throw new ConflictException('Shortlist классификации недоступен');
        if (shortlist.candidates.length) {
            const current = (
                await sql<{
                    ingredientId: string;
                    ingredientVersion: number;
                    categoryId: string;
                    categoryVersion: number;
                }>`
                    select ingredient.id "ingredientId",ingredient.version::integer "ingredientVersion",
                           category.id "categoryId",category.version::integer "categoryVersion"
                      from meal.ingredients ingredient
                      join meal.categories category on category.id=ingredient.primary_category_id
                     where ingredient.id=any(${shortlist.candidates.map((item) => item.ingredientId)}::uuid[])
                       and ingredient.status in('active','approved','published') order by ingredient.id
                `.execute(tx)
            ).rows;
            for (const candidate of shortlist.candidates) {
                const row = current.find((item) => item.ingredientId === candidate.ingredientId);
                if (
                    !row ||
                    row.ingredientVersion !== candidate.ingredientVersion ||
                    row.categoryId !== candidate.categoryId ||
                    row.categoryVersion !== candidate.categoryVersion
                )
                    throw new ConflictException('Shortlist классификации устарел');
            }
        }
        return shortlist;
    }

    async previewClassify(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'product_classification' || request.mode !== 'classify')
            throw new ConflictException('Internal product classification task expected');
        const input = z.strictObject({ shortlistId: z.uuid() }).parse(request.input);
        const resolved = await this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const shortlist = await this.resolveShortlist(tx, userId, input.shortlistId);
            const exact = shortlist.candidates.filter((candidate) => candidate.matchKind === 'exact');
            if (!shortlist.candidates.length)
                return {
                    kind: 'resolved' as const,
                    result: aiV2ProductClassificationResultSchema.parse({
                        schemaVersion: 'ai-result-contract-v2:product_classification:classify',
                        selectedCandidateId: null,
                        selectedName: null,
                        confidence: 'low',
                        warningCodes: ['no_match'],
                        recoveryCode: 'refine_query',
                    }),
                };
            if (exact.length === 1)
                return {
                    kind: 'resolved' as const,
                    result: aiV2ProductClassificationResultSchema.parse({
                        schemaVersion: 'ai-result-contract-v2:product_classification:classify',
                        selectedCandidateId: exact[0]!.ingredientId,
                        selectedName: exact[0]!.name,
                        confidence: 'high',
                        warningCodes: [],
                        recoveryCode: 'review_selection',
                    }),
                };
            return { kind: 'model' as const, shortlist };
        });
        if (resolved.kind === 'resolved') return resolved;
        const balance = await this.quota.balance(userId);
        if (balance.available < 1) throw new ConflictException('Недостаточно AI-действий');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const shortlist = await this.resolveShortlist(tx, userId, input.shortlistId);
            if (JSON.stringify(shortlist) !== JSON.stringify(resolved.shortlist))
                throw new ConflictException('Shortlist классификации устарел');
            const entitlement = await this.entitlements.resolve(userId, tx);
            const now = new Date();
            const previewId = randomUUID();
            const sourceSnapshotHash = createHash('sha256').update(JSON.stringify(shortlist)).digest('hex');
            const prepared = prepareAiV2Preview(raw, {
                plan: entitlement.plan,
                offeredSources: [],
                readyProviderProfileVersions: new Set([aiV4ProviderProfiles.economy.version]),
                sourceSnapshotHash,
                now,
                previewId,
            });
            const snapshot = classifySnapshotSchema.parse({
                ...aiV2TaskPreviewSnapshot(prepared),
                shortlist,
                requestHash: prepared.frozen.requestHash,
            });
            const dependency = await this.dependencies(tx, userId);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Классификация продукта',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.scopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: shortlist.query,
                    status: 'preview',
                    preview: sql`${JSON.stringify(snapshot)}::jsonb`,
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
                       and task.contract_version=2 and task.task_code='product_classification'
                       and task.task_mode='classify' and task.status='preview' for update of task
                `.execute(tx)
            ).rows[0];
            if (!task) throw new ConflictException('AI-предпросмотр недоступен');
            const preview = classifySnapshotSchema.parse(task.preview);
            if (preview.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            const shortlist = await this.resolveShortlist(tx, userId, preview.input.shortlistId);
            if (JSON.stringify(shortlist) !== JSON.stringify(preview.shortlist))
                throw new ConflictException('Shortlist классификации устарел');
            const entitlement = await this.entitlements.resolve(userId, tx);
            prepareAiV2Preview(
                { task: 'product_classification', mode: 'classify', input: preview.input },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set([aiV4ProviderProfiles.economy.version]),
                    sourceSnapshotHash: createHash('sha256').update(JSON.stringify(shortlist)).digest('hex'),
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
                    body: shortlist.query,
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
            await sql`update meal.ai_buckets set reserved_projection=reserved_projection+1,version=version+1 where id=${bucket.id}::uuid and balance_projection>reserved_projection`.execute(
                tx,
            );
            await sql`
                insert into meal.ai_provider_dispatches(
                    operation_id,client_request_id,profile_version,requested_model,state,
                    estimated_cost_rub,created_at,updated_at
                ) values(
                    ${operationId}::uuid,${clientRequestId}::uuid,${task.providerProfileVersion},
                    'simulator-economy-v1','prepared',1.00000000,${now},${now}
                )
            `.execute(tx);
            await sql`update meal.ai_tasks set status='processing',accepted_at=${now},version=version+1 where id=${task.id}::uuid and status='preview'`.execute(
                tx,
            );
            return { replayed: false as const, operationId, clientRequestId, shortlist, clock: now };
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
                const result = aiV2ProductClassificationResultSchema.parse(row.result);
                const body = result.selectedName ?? 'Подходящий кандидат не найден';
                await sql`
                    insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id)
                    values(
                        ${randomUUID()}::uuid,'assistant',${body},${`${operationId}:assistant`},
                        ${row.conversationId}::uuid,${row.intervalId}::uuid
                    ) on conflict(conversation_id,client_message_key) do nothing
                `.execute(tx);
                await sql`update meal.ai_intervals set status='completed',version=version+1 where id=${row.intervalId}::uuid and status='processing'`.execute(
                    tx,
                );
                await sql`update meal.ai_tasks set status='completed',version=version+1 where id=${row.taskId}::uuid and status='processing'`.execute(
                    tx,
                );
            } else if (['failed', 'cancelled'].includes(row.state)) {
                await sql`update meal.ai_intervals set status='refunded',version=version+1 where id=${row.intervalId}::uuid and status='processing'`.execute(
                    tx,
                );
                await sql`update meal.ai_tasks set status='failed',version=version+1 where id=${row.taskId}::uuid and status='processing'`.execute(
                    tx,
                );
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
            shortlist: reserved.shortlist,
            clock: new Date(reserved.clock.getTime() + 1),
        });
        if (submitted?.outcome.kind === 'accepted')
            await this.executor.read({
                operationId: reserved.operationId,
                dispatchVersion: submitted.nextVersion,
                shortlist: reserved.shortlist,
                clock: new Date(reserved.clock.getTime() + 4),
            });
        await this.projectOperation(reserved.operationId);
        return { operationId: reserved.operationId, replayed: false as const };
    }
}
