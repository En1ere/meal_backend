import { ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/public.js';
import { aiV4ProviderProfiles } from './ai-policy-v4.js';
import { AiService } from './ai.service.js';
import { AiV2StorageAdviceExecutor } from './ai-storage-advice-executor.js';
import { aiV2StorageTypeSchema, aiV2StorageVerdictSchema } from './ai-storage-advice.js';
import { aiV2RunRequestSchema, aiV2StorageExplainResultSchema, parseAiV2PreviewRequest } from './ai-v2.contracts.js';
import { aiV2TaskContractColumns, aiV2TaskPreviewSnapshot, prepareAiV2Preview } from './ai-v2-preview.js';

type Tx = Transaction<DatabaseSchema>;
type Allocation = { bucketId: string; amount: number };

const ruleSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('storage_advice'),
    task: z.literal('storage_advice'),
    mode: z.literal('rule'),
    input: z.strictObject({ productId: z.uuid() }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    verdict: aiV2StorageVerdictSchema,
});

const explainSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('storage_advice'),
    task: z.literal('storage_advice'),
    mode: z.literal('explain'),
    input: z.strictObject({ verdictId: z.uuid() }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    verdict: aiV2StorageVerdictSchema,
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

type ProductFacts = {
    productId: string;
    productVersion: number;
    productName: string;
    variantId: string;
    variantVersion: number;
    ingredientId: string;
    ingredientVersion: number;
    ingredientName: string;
    storageType: string | null;
    compositionId: string | null;
    compositionRevision: number | null;
};

@Injectable()
export class AiV2StorageAdviceInternalService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly quota: AiService,
        private readonly executor: AiV2StorageAdviceExecutor,
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

    private async productFacts(tx: Tx, productId: string): Promise<ProductFacts> {
        const facts = (
            await sql<ProductFacts>`
                select product.id "productId",product.version::integer "productVersion",product.name "productName",
                       variant.id "variantId",variant.version::integer "variantVersion",
                       ingredient.id "ingredientId",ingredient.version::integer "ingredientVersion",
                       ingredient.name "ingredientName",ingredient.default_storage_type "storageType",
                       composition.id "compositionId",composition.revision::integer "compositionRevision"
                  from meal.brand_products product
                  join meal.ingredient_variants variant on variant.id=product.variant_id
                  join meal.ingredients ingredient on ingredient.id=variant.ingredient_id
                  left join lateral(
                      select version.id,version.revision
                        from meal.composition_versions version
                       where version.product_id=product.id
                          or (version.product_id is null and version.variant_id=variant.id)
                          or (version.product_id is null and version.variant_id is null
                              and version.ingredient_id=ingredient.id)
                       order by case when version.product_id=product.id then 1
                                          when version.variant_id=variant.id then 2 else 3 end,
                                version.revision desc,version.created_at desc,version.id desc limit 1
                  ) composition on true
                 where product.id=${productId}::uuid
                   and product.status in('active','approved','published')
                   and variant.status in('active','approved','published')
                   and ingredient.status in('active','approved','published')
            `.execute(tx)
        ).rows[0];
        if (!facts) throw new ConflictException('Товар недоступен в активном каталоге');
        return facts;
    }

    private verdictFromFacts(facts: ProductFacts, verdictId: string = randomUUID()) {
        const storage = aiV2StorageTypeSchema.safeParse(facts.storageType);
        const warningCodes: Array<'shelf_life_unknown' | 'storage_type_unknown' | 'composition_unknown'> = [
            'shelf_life_unknown',
        ];
        if (!storage.success) warningCodes.push('storage_type_unknown');
        if (!facts.compositionId) warningCodes.push('composition_unknown');
        return aiV2StorageVerdictSchema.parse({
            id: verdictId,
            productId: facts.productId,
            productVersion: facts.productVersion,
            productName: facts.productName,
            variantId: facts.variantId,
            variantVersion: facts.variantVersion,
            ingredientId: facts.ingredientId,
            ingredientVersion: facts.ingredientVersion,
            ingredientName: facts.ingredientName,
            compositionId: facts.compositionId,
            compositionRevision: facts.compositionRevision,
            storageType: storage.success ? storage.data : null,
            shelfLifeDays: null,
            warningCodes,
            recoveryCode: 'check_product_label',
        });
    }

    async rule(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'storage_advice' || request.mode !== 'rule')
            throw new ConflictException('Internal storage rule task expected');
        const input = z.strictObject({ productId: z.uuid() }).parse(request.input);
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const entitlement = await this.entitlements.resolve(userId, tx);
            const facts = await this.productFacts(tx, input.productId);
            const verdict = this.verdictFromFacts(facts);
            const now = new Date();
            const previewId = randomUUID();
            const sourceSnapshotHash = createHash('sha256')
                .update(
                    JSON.stringify({
                        productId: verdict.productId,
                        productVersion: verdict.productVersion,
                        variantVersion: verdict.variantVersion,
                        ingredientVersion: verdict.ingredientVersion,
                        compositionId: verdict.compositionId,
                        compositionRevision: verdict.compositionRevision,
                    }),
                )
                .digest('hex');
            const prepared = prepareAiV2Preview(raw, {
                plan: entitlement.plan,
                offeredSources: [],
                readyProviderProfileVersions: new Set(),
                sourceSnapshotHash,
                now,
                previewId,
            });
            const snapshot = ruleSnapshotSchema.parse({ ...aiV2TaskPreviewSnapshot(prepared), verdict });
            const dependency = await this.dependencies(tx, userId);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Правило хранения',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.scopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: facts.productName,
                    status: 'completed',
                    preview: sql`${JSON.stringify(snapshot)}::jsonb`,
                    accepted_at: now,
                    agreement_snapshot: {
                        version: 'ai-v2-backend-storage-rule',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: dependency.ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return {
                schemaVersion: 'ai-result-contract-v2:storage_advice:rule' as const,
                verdict: {
                    id: verdict.id,
                    productName: verdict.productName,
                    storageType: verdict.storageType,
                    shelfLifeDays: null,
                    warningCodes: verdict.warningCodes,
                    recoveryCode: verdict.recoveryCode,
                },
                expiresAt: prepared.preview.expiresAt,
            };
        });
    }

    private async resolveVerdict(tx: Tx, userId: string, verdictId: string) {
        const tasks = (
            await sql<{ preview: unknown }>`
                select task.preview
                  from meal.ai_tasks task
                  join meal.ai_conversations conversation on conversation.id=task.conversation_id
                 where conversation.user_id=${userId}::uuid and task.contract_version=2
                   and task.task_code='storage_advice' and task.task_mode='rule'
                   and task.status='completed' and (task.preview->>'expiresAt')::timestamptz>now()
                 order by task.created_at desc limit 20
            `.execute(tx)
        ).rows;
        const verdict = tasks
            .map((task) => ruleSnapshotSchema.parse(task.preview).verdict)
            .find((item) => item.id === verdictId);
        if (!verdict) throw new ConflictException('Вердикт хранения недоступен');
        const current = this.verdictFromFacts(await this.productFacts(tx, verdict.productId), verdict.id);
        if (JSON.stringify(current) !== JSON.stringify(verdict))
            throw new ConflictException('Вердикт хранения устарел');
        return verdict;
    }

    async previewExplain(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'storage_advice' || request.mode !== 'explain')
            throw new ConflictException('Internal storage explain task expected');
        const input = z.strictObject({ verdictId: z.uuid() }).parse(request.input);
        const balance = await this.quota.balance(userId);
        if (balance.available < 1) throw new ConflictException('Недостаточно AI-действий');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const verdict = await this.resolveVerdict(tx, userId, input.verdictId);
            const entitlement = await this.entitlements.resolve(userId, tx);
            const now = new Date();
            const previewId = randomUUID();
            const sourceSnapshotHash = createHash('sha256').update(JSON.stringify(verdict)).digest('hex');
            const prepared = prepareAiV2Preview(raw, {
                plan: entitlement.plan,
                offeredSources: [],
                readyProviderProfileVersions: new Set([aiV4ProviderProfiles.economy.version]),
                sourceSnapshotHash,
                now,
                previewId,
            });
            const snapshot = explainSnapshotSchema.parse({
                ...aiV2TaskPreviewSnapshot(prepared),
                verdict,
                requestHash: prepared.frozen.requestHash,
            });
            const dependency = await this.dependencies(tx, userId);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Объяснение хранения',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.scopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: verdict.productName,
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
                      from meal.ai_tasks task
                      join meal.ai_conversations conversation on conversation.id=task.conversation_id
                     where task.id=${input.previewId}::uuid and conversation.user_id=${userId}::uuid
                       and task.contract_version=2 and task.task_code='storage_advice'
                       and task.task_mode='explain' and task.status='preview' for update of task
                `.execute(tx)
            ).rows[0];
            if (!task) throw new ConflictException('AI-предпросмотр недоступен');
            const preview = explainSnapshotSchema.parse(task.preview);
            if (preview.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            const verdict = await this.resolveVerdict(tx, userId, preview.input.verdictId);
            if (JSON.stringify(verdict) !== JSON.stringify(preview.verdict))
                throw new ConflictException('Вердикт хранения устарел');
            const entitlement = await this.entitlements.resolve(userId, tx);
            prepareAiV2Preview(
                { task: 'storage_advice', mode: 'explain', input: preview.input },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set([aiV4ProviderProfiles.economy.version]),
                    sourceSnapshotHash: createHash('sha256').update(JSON.stringify(verdict)).digest('hex'),
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
                    body: verdict.productName,
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
            return { replayed: false as const, operationId, clientRequestId, verdict, clock: now };
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
                const result = aiV2StorageExplainResultSchema.parse(row.result);
                await sql`
                    insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id)
                    values(
                        ${randomUUID()}::uuid,'assistant',${result.explanation},${`${operationId}:assistant`},
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
            verdict: reserved.verdict,
            clock: new Date(reserved.clock.getTime() + 1),
        });
        if (submitted?.outcome.kind === 'accepted')
            await this.executor.read({
                operationId: reserved.operationId,
                dispatchVersion: submitted.nextVersion,
                verdict: reserved.verdict,
                clock: new Date(reserved.clock.getTime() + 4),
            });
        await this.projectOperation(reserved.operationId);
        return { operationId: reserved.operationId, replayed: false as const };
    }
}
