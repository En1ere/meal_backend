import {
    ConflictException,
    ForbiddenException,
    HttpException,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/public.js';
import { classifyCulinaryQuestion } from './ai-culinary-question.js';
import { classifyIngredientExtractionText, sanitizeIngredientExtractionText } from './ai-ingredient-extraction.js';
import {
    AI_V2_NUTRITION_ALGORITHM_VERSION,
    aiV2NutritionSnapshotSchema,
    aiV2NutritionSourceSchema,
    calculateNutritionValues,
    canonicalNutritionSnapshot,
    type AiV2NutritionSnapshot,
} from './ai-nutrition-calculation.js';
import { AiV2NutritionCalculationExecutor } from './ai-nutrition-calculation-executor.js';
import { aiV4ProviderProfiles } from './ai-policy-v4.js';
import { AiService } from './ai.service.js';
import {
    aiV2NutritionCalculationResultSchema,
    aiV2NutritionExplainResultSchema,
    aiV2RunRequestSchema,
    parseAiV2PreviewRequest,
} from './ai-v2.contracts.js';
import { aiV2TaskContractColumns, aiV2TaskPreviewSnapshot, prepareAiV2Preview } from './ai-v2-preview.js';

type Tx = Transaction<DatabaseSchema>;
type Allocation = { bucketId: string; amount: number };

const calculateInputSchema = z.strictObject({
    recipeId: z.uuid(),
    servings: z
        .number()
        .positive()
        .max(50)
        .refine((value) => /^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/u.test(String(value))),
});

const calculateTaskSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('nutrition_calculation'),
    task: z.literal('nutrition_calculation'),
    mode: z.literal('calculate'),
    input: calculateInputSchema,
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
    nutrition: aiV2NutritionSnapshotSchema,
});

const explainTaskSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('nutrition_calculation'),
    task: z.literal('nutrition_calculation'),
    mode: z.literal('explain'),
    input: z.strictObject({ calculationId: z.uuid(), question: z.string().trim().min(1).max(500).optional() }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
    nutrition: aiV2NutritionSnapshotSchema,
});

type TaskRow = {
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
};

@Injectable()
export class AiV2NutritionCalculationInternalService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly quota: AiService,
        private readonly executor: AiV2NutritionCalculationExecutor,
    ) {}

    private async writable(tx: Tx, userId: string) {
        const user = await sql`
            select id from meal.users where id=${userId}::uuid and status='active' and archived_at is null for update
        `.execute(tx);
        if (!user.rows.length) throw new HttpException('Аккаунт недоступен', 403);
        const sanction = await sql`
            select id from meal.sanctions where user_id=${userId}::uuid and scope in('account','ai')
               and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1
        `.execute(tx);
        if (sanction.rows.length) throw new HttpException('Доступен только просмотр', 403);
    }

    private async dependencies(tx: Tx, userId: string) {
        const rule = (
            await sql<{ id: string }>`
                select id from meal.ai_rule_versions where kind='cost' and version=4 and effective_at<=now() limit 1
            `.execute(tx)
        ).rows[0];
        const scope = (
            await sql<{ id: string }>`
                select id from meal.data_scopes where kind='private' and user_id=${userId}::uuid limit 1
            `.execute(tx)
        ).rows[0];
        if (!rule || !scope) throw new ServiceUnavailableException('AI nutrition dependencies are not configured');
        return { ruleId: rule.id, scopeId: scope.id };
    }

    private async assertAccess(tx: Tx, userId: string) {
        const entitlement = await this.entitlements.resolve(userId, tx);
        if (entitlement.plan !== 'pro') throw new ForbiddenException('Аналитика питания доступна на тарифе Pro');
        return entitlement;
    }

    private safeQuestion(raw: string) {
        const text = sanitizeIngredientExtractionText(raw).text;
        if (classifyIngredientExtractionText(text) !== 'safe' || classifyCulinaryQuestion(text) !== 'safe')
            throw new ConflictException('Допустим только короткий нейтральный вопрос о рассчитанной пищевой ценности');
        return text;
    }

    private sourceHash(source: z.infer<typeof aiV2NutritionSourceSchema>, servings: number) {
        return createHash('sha256')
            .update(JSON.stringify({ algorithmVersion: AI_V2_NUTRITION_ALGORITHM_VERSION, servings, source }))
            .digest('hex');
    }

    private async resolveSource(tx: Tx, recipeId: string, servings: number, calculationId: string = randomUUID()) {
        const row = (
            await sql<{
                recipeId: string;
                recipeVersion: number;
                revisionId: string;
                revisionVersion: number;
                publicationId: string;
                publicationVersion: number;
                baseServings: number;
                nutritionSnapshot: unknown;
            }>`
                select recipe.id "recipeId",recipe.version::integer "recipeVersion",
                       revision.id "revisionId",revision.version::integer "revisionVersion",
                       publication.id "publicationId",publication.version::integer "publicationVersion",
                       revision.portions::integer "baseServings",revision.nutrition_snapshot "nutritionSnapshot"
                  from meal.recipes recipe
                  join meal.recipe_revisions revision on revision.recipe_id=recipe.id
                  join meal.recipe_publications publication on publication.revision_id=revision.id
                 where recipe.id=${recipeId}::uuid and publication.unpublished_at is null
                   and publication.published_at<=now() and recipe.archived_at is null
                   and recipe.status not in('hidden','unpublished','deleted','archived')
                 order by publication.published_at desc,publication.id desc limit 1
            `.execute(tx)
        ).rows[0];
        if (!row) throw new HttpException('Опубликованный рецепт не найден', 404);
        const canonical = canonicalNutritionSnapshot(row.nutritionSnapshot);
        const source = aiV2NutritionSourceSchema.parse({
            ...row,
            nutrition: canonical.nutrition,
            sourceStatus: canonical.sourceStatus,
        });
        const calculated = calculateNutritionValues({
            nutrition: source.nutrition,
            sourceStatus: source.sourceStatus,
            servings,
            baseServings: source.baseServings,
        });
        return aiV2NutritionSnapshotSchema.parse({
            calculationId,
            algorithmVersion: AI_V2_NUTRITION_ALGORITHM_VERSION,
            servings,
            sourceHash: this.sourceHash(source, servings),
            source,
            ...calculated,
        });
    }

    private calculationResult(snapshot: AiV2NutritionSnapshot) {
        return aiV2NutritionCalculationResultSchema.parse({
            schemaVersion: 'ai-result-contract-v2:nutrition_calculation:calculate',
            calculationId: snapshot.calculationId,
            recipeId: snapshot.source.recipeId,
            revisionId: snapshot.source.revisionId,
            servings: snapshot.servings,
            values: snapshot.values,
            completeness: snapshot.completeness,
            warningCodes: snapshot.warningCodes,
            recoveryCode: 'review_nutrition',
        });
    }

    async previewCalculate(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'nutrition_calculation' || request.mode !== 'calculate')
            throw new ConflictException('Internal nutrition calculation task expected');
        const input = calculateInputSchema.parse(request.input);
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const entitlement = await this.assertAccess(tx, userId);
            const nutrition = await this.resolveSource(tx, input.recipeId, input.servings);
            const previewId = randomUUID();
            const now = new Date();
            const prepared = prepareAiV2Preview(
                { task: 'nutrition_calculation', mode: 'calculate', input },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set(),
                    sourceSnapshotHash: nutrition.sourceHash,
                    previewId,
                    now,
                },
            );
            const snapshot = calculateTaskSnapshotSchema.parse({
                ...aiV2TaskPreviewSnapshot(prepared),
                requestHash: prepared.frozen.requestHash,
                nutrition,
            });
            const dependencies = await this.dependencies(tx, userId);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Расчёт пищевой ценности',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependencies.scopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: '',
                    status: 'preview',
                    preview: sql`${JSON.stringify(snapshot)}::jsonb`,
                    accepted_at: null,
                    agreement_snapshot: {
                        version: 'ai-v2-backend-public-nutrition-snapshot',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: dependencies.ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return { kind: 'preview' as const, preview: prepared.preview, result: this.calculationResult(nutrition) };
        });
    }

    async runCalculate(userId: string, raw: unknown) {
        const run = aiV2RunRequestSchema.parse(raw);
        const requestHash = createHash('sha256')
            .update(JSON.stringify({ contractVersion: 2, previewId: run.previewId }))
            .digest('hex');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            await this.assertAccess(tx, userId);
            const existing = (
                await sql<{ operationId: string; requestHash: string }>`
                    select id "operationId",request_hash "requestHash" from meal.ai_operations
                     where user_id=${userId}::uuid and idempotency_key=${run.idempotencyKey} and contract_version=2
                     for update
                `.execute(tx)
            ).rows[0];
            if (existing) {
                if (existing.requestHash !== requestHash)
                    throw new ConflictException('Ключ идемпотентности использован с другим запросом');
                return { operationId: existing.operationId, replayed: true as const };
            }
            const task = (
                await sql<{
                    id: string;
                    conversationId: string;
                    preview: unknown;
                    taskPolicyVersion: string;
                    contextPolicyVersion: string;
                    routingPolicyVersion: string;
                    pricePolicyVersion: string;
                    resultSchemaVersion: string;
                    safetyPolicyVersion: string;
                    cachePolicyVersion: string;
                }>`
                    select task.id,task.conversation_id "conversationId",task.preview,
                           task.task_policy_version "taskPolicyVersion",task.context_policy_version "contextPolicyVersion",
                           task.routing_policy_version "routingPolicyVersion",task.price_policy_version "pricePolicyVersion",
                           task.result_schema_version "resultSchemaVersion",task.safety_policy_version "safetyPolicyVersion",
                           task.cache_policy_version "cachePolicyVersion"
                      from meal.ai_tasks task join meal.ai_conversations conversation on conversation.id=task.conversation_id
                     where task.id=${run.previewId}::uuid and conversation.user_id=${userId}::uuid
                       and task.contract_version=2 and task.task_code='nutrition_calculation'
                       and task.task_mode='calculate' and task.status='preview' for update of task
                `.execute(tx)
            ).rows[0];
            if (!task) throw new ConflictException('AI-предпросмотр недоступен');
            const snapshot = calculateTaskSnapshotSchema.parse(task.preview);
            if (snapshot.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            const current = await this.resolveSource(
                tx,
                snapshot.input.recipeId,
                snapshot.input.servings,
                snapshot.nutrition.calculationId,
            );
            if (JSON.stringify(current) !== JSON.stringify(snapshot.nutrition))
                throw new ConflictException('Публикация рецепта изменилась');
            const operationId = randomUUID();
            const intervalId = randomUUID();
            const userMessageId = randomUUID();
            const assistantMessageId = randomUUID();
            const now = new Date();
            const result = this.calculationResult(current);
            await sql`
                insert into meal.ai_intervals(id,starts_at,ends_at,clarifications_used,cost,status,task_id)
                values(${intervalId}::uuid,${now},${new Date(now.getTime() + 10 * 60_000)},0,0,'completed',${task.id}::uuid)
            `.execute(tx);
            await sql`
                insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id)
                values(${userMessageId}::uuid,'user','Рассчитать пищевую ценность',${run.idempotencyKey},${task.conversationId}::uuid,${intervalId}::uuid),
                      (${assistantMessageId}::uuid,'assistant','Расчёт пищевой ценности подготовлен',${`${operationId}:assistant`},${task.conversationId}::uuid,${intervalId}::uuid)
            `.execute(tx);
            await sql`
                insert into meal.ai_operations(
                    id,status,result_snapshot,started_at,finished_at,provider_cost,idempotency_key,interval_id,message_id,
                    user_id,task_id,contract_version,command_kind,request_hash,lifecycle_state,financial_state,
                    queued_at,next_attempt_at,task_policy_version,context_manifest_version,provider_profile_version,
                    execution_route,routing_policy_version,price_policy_version,result_schema_version,
                    safety_policy_version,cache_policy_version,provider_cost_state,provider_cost_currency,updated_at,expires_at)
                values(
                    ${operationId}::uuid,'succeeded',${JSON.stringify(result)}::jsonb,${now},${now},null,
                    ${run.idempotencyKey},${intervalId}::uuid,${userMessageId}::uuid,${userId}::uuid,${task.id}::uuid,
                    2,'initial',${requestHash},'succeeded','none',${now},${now},${task.taskPolicyVersion},
                    ${task.contextPolicyVersion},null,'backend',${task.routingPolicyVersion},${task.pricePolicyVersion},
                    ${task.resultSchemaVersion},${task.safetyPolicyVersion},${task.cachePolicyVersion},'none',null,${now},
                    ${new Date(now.getTime() + 30 * 86_400_000)})
            `.execute(tx);
            await sql`update meal.ai_tasks set status='completed',accepted_at=${now},version=version+1 where id=${task.id}::uuid and status='preview'`.execute(
                tx,
            );
            return { operationId, replayed: false as const, result };
        });
    }

    private async resolveCalculation(tx: Tx, userId: string, calculationId: string) {
        const tasks = (
            await sql<{ preview: unknown }>`
                select task.preview from meal.ai_tasks task
                join meal.ai_conversations conversation on conversation.id=task.conversation_id
                 where conversation.user_id=${userId}::uuid and task.contract_version=2
                   and task.task_code='nutrition_calculation' and task.task_mode='calculate'
                   and task.status='completed' and (task.preview->>'expiresAt')::timestamptz>now()
                 order by task.created_at desc limit 50
            `.execute(tx)
        ).rows;
        const found = tasks
            .map((task) => calculateTaskSnapshotSchema.parse(task.preview))
            .find((task) => task.nutrition.calculationId === calculationId);
        if (!found) throw new ConflictException('Расчёт пищевой ценности недоступен');
        const current = await this.resolveSource(
            tx,
            found.input.recipeId,
            found.input.servings,
            found.nutrition.calculationId,
        );
        if (JSON.stringify(current) !== JSON.stringify(found.nutrition))
            throw new ConflictException('Публикация рецепта изменилась');
        if (current.completeness === 'unavailable')
            throw new ConflictException('Нет достоверных показателей для объяснения');
        return current;
    }

    async previewExplain(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'nutrition_calculation' || request.mode !== 'explain')
            throw new ConflictException('Internal nutrition explanation task expected');
        const input = z
            .strictObject({ calculationId: z.uuid(), question: z.string().trim().min(1).max(500).optional() })
            .parse(request.input);
        const question = input.question ? this.safeQuestion(input.question) : undefined;
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const entitlement = await this.assertAccess(tx, userId);
            const nutrition = await this.resolveCalculation(tx, userId, input.calculationId);
            const normalizedInput = { calculationId: input.calculationId, ...(question ? { question } : {}) };
            const previewId = randomUUID();
            const now = new Date();
            const prepared = prepareAiV2Preview(
                { task: 'nutrition_calculation', mode: 'explain', input: normalizedInput },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set([aiV4ProviderProfiles.economy.version]),
                    sourceSnapshotHash: nutrition.sourceHash,
                    previewId,
                    now,
                },
            );
            const snapshot = explainTaskSnapshotSchema.parse({
                ...aiV2TaskPreviewSnapshot(prepared),
                requestHash: prepared.frozen.requestHash,
                nutrition,
            });
            const dependencies = await this.dependencies(tx, userId);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Объяснение пищевой ценности',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependencies.scopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: question ?? 'Объяснить расчёт пищевой ценности',
                    status: 'preview',
                    preview: sql`${JSON.stringify(snapshot)}::jsonb`,
                    accepted_at: null,
                    agreement_snapshot: {
                        version: 'ai-v2-internal-simulator',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: dependencies.ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return { kind: 'preview' as const, preview: prepared.preview };
        });
    }

    private async reserveBuckets(tx: Tx, userId: string) {
        const buckets = (
            await sql<{ id: string; available: number }>`
                select id,(balance_projection-reserved_projection)::integer available from meal.ai_buckets
                 where user_id=${userId}::uuid and kind<>'family_reserve'
                   and balance_projection-reserved_projection>0 and (expires_at is null or expires_at>now())
                 order by case kind when 'subscription' then 1 when 'transferred' then 2
                                    when 'trial' then 3 when 'purchased' then 4 else 5 end,
                          expires_at nulls last,created_at,id for update
            `.execute(tx)
        ).rows;
        let remaining = 1;
        const allocations: Allocation[] = [];
        for (const bucket of buckets) {
            const amount = Math.min(remaining, bucket.available);
            if (amount > 0) allocations.push({ bucketId: bucket.id, amount });
            remaining -= amount;
            if (!remaining) break;
        }
        if (remaining) throw new ConflictException('Недостаточно AI-действий');
        return allocations;
    }

    private async reserveExplain(userId: string, raw: unknown) {
        const run = aiV2RunRequestSchema.parse(raw);
        await this.quota.balance(userId);
        const requestHash = createHash('sha256')
            .update(JSON.stringify({ contractVersion: 2, previewId: run.previewId }))
            .digest('hex');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            await this.assertAccess(tx, userId);
            const existing = (
                await sql<{ operationId: string; requestHash: string }>`
                    select id "operationId",request_hash "requestHash" from meal.ai_operations
                     where user_id=${userId}::uuid and idempotency_key=${run.idempotencyKey} and contract_version=2
                     for update
                `.execute(tx)
            ).rows[0];
            if (existing) {
                if (existing.requestHash !== requestHash)
                    throw new ConflictException('Ключ идемпотентности использован с другим запросом');
                return { replayed: true as const, operationId: existing.operationId };
            }
            const task = (
                await sql<TaskRow>`
                    select task.id,task.conversation_id "conversationId",task.preview,task.execution_route route,
                           task.task_policy_version "taskPolicyVersion",task.context_policy_version "contextPolicyVersion",
                           task.routing_policy_version "routingPolicyVersion",task.price_policy_version "pricePolicyVersion",
                           task.result_schema_version "resultSchemaVersion",task.safety_policy_version "safetyPolicyVersion",
                           task.cache_policy_version "cachePolicyVersion",task.provider_profile_version "providerProfileVersion"
                      from meal.ai_tasks task join meal.ai_conversations conversation on conversation.id=task.conversation_id
                     where task.id=${run.previewId}::uuid and conversation.user_id=${userId}::uuid
                       and task.contract_version=2 and task.task_code='nutrition_calculation'
                       and task.task_mode='explain' and task.status='preview' for update of task
                `.execute(tx)
            ).rows[0];
            if (!task) throw new ConflictException('AI-предпросмотр недоступен');
            const preview = explainTaskSnapshotSchema.parse(task.preview);
            if (preview.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            if (preview.input.question) this.safeQuestion(preview.input.question);
            const nutrition = await this.resolveCalculation(tx, userId, preview.input.calculationId);
            if (JSON.stringify(nutrition) !== JSON.stringify(preview.nutrition))
                throw new ConflictException('Расчёт пищевой ценности изменился');
            const allocations = await this.reserveBuckets(tx, userId);
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
                    body: preview.input.question ?? 'Объяснить расчёт пищевой ценности',
                    client_message_key: run.idempotencyKey,
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
                    provider_cost_currency,updated_at,expires_at)
                values(
                    ${operationId}::uuid,'processing',${JSON.stringify({ allocations, charged: true, continuation: false })}::jsonb,
                    ${now},null,null,${run.idempotencyKey},${intervalId}::uuid,${messageId}::uuid,${userId}::uuid,
                    ${task.id}::uuid,2,'initial',${requestHash},'queued','reserved',${now},${now},
                    'simulator-economy-v1',${task.taskPolicyVersion},${task.contextPolicyVersion},
                    ${task.providerProfileVersion},${task.route},${task.routingPolicyVersion},${task.pricePolicyVersion},
                    ${task.resultSchemaVersion},${task.safetyPolicyVersion},${task.cachePolicyVersion},'none','RUB',${now},
                    ${new Date(now.getTime() + 30 * 86_400_000)})
            `.execute(tx);
            for (const allocation of allocations) {
                await sql`
                    insert into meal.ai_ledger(id,kind,delta,reserved_delta,recorded_at,idempotency_key,bucket_id,operation_id,compensates_id)
                    values(${randomUUID()}::uuid,'reserve',0,${allocation.amount},${now},
                           ${`${operationId}:reserve:${allocation.bucketId}`},${allocation.bucketId}::uuid,${operationId}::uuid,null)
                `.execute(tx);
                const updated = await sql`
                    update meal.ai_buckets set reserved_projection=reserved_projection+${allocation.amount},version=version+1
                     where id=${allocation.bucketId}::uuid and balance_projection-reserved_projection>=${allocation.amount}
                `.execute(tx);
                if (!updated.numAffectedRows) throw new ConflictException('AI-баланс изменился');
            }
            await sql`
                insert into meal.ai_provider_dispatches(
                    operation_id,client_request_id,profile_version,requested_model,state,estimated_cost_rub,created_at,updated_at)
                values(${operationId}::uuid,${clientRequestId}::uuid,${task.providerProfileVersion},
                       'simulator-economy-v1','prepared',1.00000000,${now},${now})
            `.execute(tx);
            await sql`update meal.ai_tasks set status='processing',accepted_at=${now},version=version+1 where id=${task.id}::uuid and status='preview'`.execute(
                tx,
            );
            return {
                replayed: false as const,
                operationId,
                clientRequestId,
                nutrition,
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
                           operation.interval_id "intervalId",operation.task_id "taskId",task.conversation_id "conversationId"
                      from meal.ai_operations operation join meal.ai_tasks task on task.id=operation.task_id
                     where operation.id=${operationId}::uuid and operation.contract_version=2
                     for update of operation,task
                `.execute(tx)
            ).rows[0];
            if (!row) throw new ConflictException('AI-операция недоступна');
            if (row.state === 'succeeded') {
                const result = aiV2NutritionExplainResultSchema.parse(row.result);
                await sql`
                    insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id)
                    values(${randomUUID()}::uuid,'assistant',${result.explanation},${`${operationId}:assistant`},
                           ${row.conversationId}::uuid,${row.intervalId}::uuid)
                    on conflict(conversation_id,client_message_key) do nothing
                `.execute(tx);
                await sql`update meal.ai_intervals set status='completed',version=version+1 where id=${row.intervalId}::uuid and status='processing'`.execute(
                    tx,
                );
                await sql`update meal.ai_tasks set status='completed',version=version+1 where id=${row.taskId}::uuid and status='processing'`.execute(
                    tx,
                );
            } else if (row.state === 'failed' || row.state === 'cancelled') {
                await sql`update meal.ai_intervals set status='refunded',version=version+1 where id=${row.intervalId}::uuid and status='processing'`.execute(
                    tx,
                );
                await sql`update meal.ai_tasks set status='failed',version=version+1 where id=${row.taskId}::uuid and status='processing'`.execute(
                    tx,
                );
            }
        });
    }

    async runExplainSimulator(userId: string, raw: unknown) {
        const reserved = await this.reserveExplain(userId, raw);
        if (reserved.replayed) return { operationId: reserved.operationId, replayed: true as const };
        const submitted = await this.executor.submit({
            operationId: reserved.operationId,
            dispatchVersion: 1,
            clientRequestId: reserved.clientRequestId,
            snapshot: reserved.nutrition,
            ...(reserved.question ? { question: reserved.question } : {}),
            clock: new Date(reserved.clock.getTime() + 1),
        });
        if (submitted?.outcome.kind === 'accepted')
            await this.executor.read({
                operationId: reserved.operationId,
                dispatchVersion: submitted.nextVersion,
                snapshot: reserved.nutrition,
                clock: new Date(reserved.clock.getTime() + 4),
            });
        await this.projectOperation(reserved.operationId);
        return { operationId: reserved.operationId, replayed: false as const };
    }
}
