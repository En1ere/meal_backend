import { ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/public.js';
import { classifyCulinaryQuestion } from './ai-culinary-question.js';
import { sanitizeIngredientExtractionText } from './ai-ingredient-extraction.js';
import { aiV4ProviderProfiles } from './ai-policy-v4.js';
import { aiV2RecipeAdaptationSnapshotSchema, scaleRecipeAdaptationIngredients } from './ai-recipe-adaptation.js';
import { AiV2RecipeAdaptationExecutor } from './ai-recipe-adaptation-executor.js';
import { AiService } from './ai.service.js';
import {
    aiV2RecipeAdaptationResultSchema,
    aiV2RecipeScaleResultSchema,
    aiV2RunRequestSchema,
    parseAiV2PreviewRequest,
} from './ai-v2.contracts.js';
import { aiV2TaskContractColumns, aiV2TaskPreviewSnapshot, prepareAiV2Preview } from './ai-v2-preview.js';

type Tx = Transaction<DatabaseSchema>;
type Allocation = { bucketId: string; amount: number };

const scaleSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('recipe_adaptation'),
    task: z.literal('recipe_adaptation'),
    mode: z.literal('scale'),
    input: z.strictObject({ recipeId: z.uuid(), revisionId: z.uuid(), servings: z.number().int().min(1).max(50) }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    snapshot: aiV2RecipeAdaptationSnapshotSchema,
});

const adaptSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('recipe_adaptation'),
    task: z.literal('recipe_adaptation'),
    mode: z.literal('adapt'),
    input: z.strictObject({ snapshotId: z.uuid(), instruction: z.string().trim().min(3).max(500) }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    snapshot: aiV2RecipeAdaptationSnapshotSchema,
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

@Injectable()
export class AiV2RecipeAdaptationInternalService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly quota: AiService,
        private readonly executor: AiV2RecipeAdaptationExecutor,
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
            await sql<{ id: string }>`
                select id from meal.data_scopes where kind='private' and user_id=${userId}::uuid limit 1
            `.execute(tx)
        ).rows[0];
        const rule = (
            await sql<{ id: string }>`
                select id from meal.ai_rule_versions where kind='cost' and version=4 and effective_at<=now() limit 1
            `.execute(tx)
        ).rows[0];
        if (!scope || !rule) throw new ServiceUnavailableException('AI v2 dependencies are not configured');
        return { scopeId: scope.id, ruleId: rule.id };
    }

    private async buildSnapshot(
        tx: Tx,
        recipeId: string,
        revisionId: string,
        servings: number,
        snapshotId: string = randomUUID(),
    ) {
        const recipe = (
            await sql<{
                recipeId: string;
                recipeVersion: number;
                revisionId: string;
                revisionVersion: number;
                publicationId: string;
                publicationVersion: number;
                title: string;
                portions: number;
            }>`
                select recipe.id "recipeId",recipe.version::integer "recipeVersion",
                       revision.id "revisionId",revision.version::integer "revisionVersion",
                       publication.id "publicationId",publication.version::integer "publicationVersion",
                       revision.title,revision.portions::integer
                  from meal.recipes recipe
                  join meal.recipe_revisions revision on revision.recipe_id=recipe.id
                  join meal.recipe_publications publication on publication.revision_id=revision.id
                 where recipe.id=${recipeId}::uuid and revision.id=${revisionId}::uuid
                   and publication.unpublished_at is null and publication.published_at<=now()
                   and recipe.archived_at is null
                   and recipe.status not in('hidden','unpublished','deleted','archived')
                   and publication.id=(
                       select current_publication.id from meal.recipe_publications current_publication
                       join meal.recipe_revisions current_revision on current_revision.id=current_publication.revision_id
                        where current_revision.recipe_id=recipe.id and current_publication.unpublished_at is null
                          and current_publication.published_at<=now()
                        order by current_publication.published_at desc,current_publication.id desc limit 1
                   )
                 limit 1
            `.execute(tx)
        ).rows[0];
        if (!recipe || recipe.portions < 1) throw new ConflictException('Текущая опубликованная ревизия недоступна');
        const counts = (
            await sql<{ ingredientCount: number; stepCount: number }>`
                select
                    (select count(*)::integer from meal.recipe_ingredients where revision_id=${revisionId}::uuid) "ingredientCount",
                    (select count(*)::integer from meal.recipe_steps where revision_id=${revisionId}::uuid) "stepCount"
            `.execute(tx)
        ).rows[0];
        if (!counts?.ingredientCount || !counts.stepCount) throw new ConflictException('Рецепт неполный');
        if (counts.ingredientCount > 40 || counts.stepCount > 20)
            throw new ConflictException('Рецепт слишком большой для безопасной адаптации');
        const sourceIngredients = (
            await sql<{
                lineId: string;
                lineVersion: number;
                name: string;
                quantity: string | null;
                unit: string | null;
                optional: boolean;
            }>`
                select line.id "lineId",line.version::integer "lineVersion",
                       coalesce(product.name,variant.name,ingredient.name,source.title,'Ингредиент') name,
                       line.quantity::text,unit.code unit,line.optional
                  from meal.recipe_ingredients line
                  left join meal.brand_products product on product.id=line.product_id
                  left join meal.ingredient_variants variant on variant.id=line.variant_id
                  left join meal.ingredients ingredient on ingredient.id=line.ingredient_id
                  left join meal.units unit on unit.id=line.unit_id
                  left join lateral(
                      select source_revision.title from meal.recipe_revisions source_revision
                      join meal.recipe_publications source_publication on source_publication.revision_id=source_revision.id
                       where source_revision.recipe_id=line.source_recipe_id
                         and source_publication.unpublished_at is null and source_publication.published_at<=now()
                       order by source_publication.published_at desc,source_publication.id desc limit 1
                  ) source on true
                 where line.revision_id=${revisionId}::uuid
                 order by line.position,line.id
            `.execute(tx)
        ).rows;
        const steps = (
            await sql<{
                stepId: string;
                stepVersion: number;
                position: number;
                text: string;
            }>`
                select id "stepId",version::integer "stepVersion",position,text
                  from meal.recipe_steps where revision_id=${revisionId}::uuid order by position,id
            `.execute(tx)
        ).rows;
        const allergen = (
            await sql<{ unknownCount: number }>`
                select count(*)::integer "unknownCount"
                  from meal.recipe_ingredients line
                  left join lateral(
                      select composition.dietary_flags from meal.composition_versions composition
                       where (line.product_id is not null and composition.product_id=line.product_id)
                          or (line.product_id is null and line.variant_id is not null and composition.variant_id=line.variant_id)
                          or (line.product_id is null and line.variant_id is null
                              and composition.ingredient_id=line.ingredient_id)
                       order by composition.revision desc,composition.created_at desc limit 1
                  ) composition on true
                 where line.revision_id=${revisionId}::uuid
                   and coalesce((composition.dietary_flags->>'allergensComplete')::boolean,false)=false
            `.execute(tx)
        ).rows[0];
        return aiV2RecipeAdaptationSnapshotSchema.parse({
            id: snapshotId,
            recipeId: recipe.recipeId,
            recipeVersion: recipe.recipeVersion,
            revisionId: recipe.revisionId,
            revisionVersion: recipe.revisionVersion,
            publicationId: recipe.publicationId,
            publicationVersion: recipe.publicationVersion,
            title: recipe.title,
            sourceServings: recipe.portions,
            servings,
            allergenComplete: (allergen?.unknownCount ?? sourceIngredients.length) === 0,
            ingredients: scaleRecipeAdaptationIngredients(sourceIngredients, recipe.portions, servings),
            steps,
        });
    }

    async scale(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'recipe_adaptation' || request.mode !== 'scale')
            throw new ConflictException('Internal recipe scale task expected');
        const input = z
            .strictObject({ recipeId: z.uuid(), revisionId: z.uuid(), servings: z.number().int().min(1).max(50) })
            .parse(request.input);
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const entitlement = await this.entitlements.resolve(userId, tx);
            const snapshot = await this.buildSnapshot(tx, input.recipeId, input.revisionId, input.servings);
            const now = new Date();
            const previewId = randomUUID();
            const prepared = prepareAiV2Preview(request, {
                plan: entitlement.plan,
                offeredSources: [],
                readyProviderProfileVersions: new Set(),
                sourceSnapshotHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
                now,
                previewId,
            });
            const stored = scaleSnapshotSchema.parse({ ...aiV2TaskPreviewSnapshot(prepared), snapshot });
            const dependency = await this.dependencies(tx, userId);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Масштабирование рецепта',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.scopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: `${snapshot.title}: ${snapshot.servings}`,
                    status: 'completed',
                    preview: sql`${JSON.stringify(stored)}::jsonb`,
                    accepted_at: now,
                    agreement_snapshot: {
                        version: 'ai-v2-backend-recipe-scale',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: dependency.ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            const warnings: Array<'allergen_evidence_incomplete' | 'source_quantity_unknown'> = [];
            if (!snapshot.allergenComplete) warnings.push('allergen_evidence_incomplete');
            if (snapshot.ingredients.some((ingredient) => ingredient.quantity === null))
                warnings.push('source_quantity_unknown');
            return aiV2RecipeScaleResultSchema.parse({
                schemaVersion: 'ai-result-contract-v2:recipe_adaptation:scale',
                snapshotId: snapshot.id,
                sourceRecipeId: snapshot.recipeId,
                sourceRevisionId: snapshot.revisionId,
                title: snapshot.title,
                servings: snapshot.servings,
                ingredients: snapshot.ingredients.map((ingredient) => ({
                    ingredientKey: ingredient.key,
                    name: ingredient.name,
                    quantity: ingredient.quantity,
                    unit: ingredient.unit,
                    optional: ingredient.optional,
                })),
                steps: snapshot.steps.map((step) => step.text),
                adaptationAllowed: snapshot.allergenComplete,
                warningCodes: warnings,
            });
        });
    }

    private async resolveSnapshot(tx: Tx, userId: string, snapshotId: string) {
        const tasks = (
            await sql<{ preview: unknown }>`
                select task.preview from meal.ai_tasks task
                join meal.ai_conversations conversation on conversation.id=task.conversation_id
                 where conversation.user_id=${userId}::uuid and task.contract_version=2
                   and task.task_code='recipe_adaptation' and task.task_mode='scale'
                   and task.status='completed' and (task.preview->>'expiresAt')::timestamptz>now()
                 order by task.created_at desc limit 20
            `.execute(tx)
        ).rows;
        const found = tasks
            .map((task) => scaleSnapshotSchema.parse(task.preview))
            .find((task) => task.snapshot.id === snapshotId);
        if (!found) throw new ConflictException('Снимок рецепта недоступен');
        const current = await this.buildSnapshot(
            tx,
            found.snapshot.recipeId,
            found.snapshot.revisionId,
            found.snapshot.servings,
            found.snapshot.id,
        );
        if (JSON.stringify(current) !== JSON.stringify(found.snapshot)) throw new ConflictException('Рецепт изменился');
        return current;
    }

    async previewAdapt(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'recipe_adaptation' || request.mode !== 'adapt')
            throw new ConflictException('Internal recipe adaptation task expected');
        const input = z
            .strictObject({ snapshotId: z.uuid(), instruction: z.string().trim().min(3).max(500) })
            .parse(request.input);
        const instruction = sanitizeIngredientExtractionText(input.instruction).text;
        const boundary = classifyCulinaryQuestion(instruction);
        if (boundary !== 'safe') throw new ConflictException(`Адаптация заблокирована: ${boundary}`);
        if ((await this.quota.balance(userId)).available < 2) throw new ConflictException('Недостаточно AI-действий');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const snapshot = await this.resolveSnapshot(tx, userId, input.snapshotId);
            if (!snapshot.allergenComplete)
                throw new ConflictException('Адаптация недоступна: аллергенный состав подтверждён не полностью');
            const entitlement = await this.entitlements.resolve(userId, tx);
            const normalized = {
                task: 'recipe_adaptation' as const,
                mode: 'adapt',
                input: { snapshotId: input.snapshotId, instruction },
            };
            const now = new Date();
            const previewId = randomUUID();
            const prepared = prepareAiV2Preview(normalized, {
                plan: entitlement.plan,
                offeredSources: [],
                readyProviderProfileVersions: new Set([aiV4ProviderProfiles.balanced.version]),
                sourceSnapshotHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
                now,
                previewId,
            });
            const stored = adaptSnapshotSchema.parse({
                ...aiV2TaskPreviewSnapshot(prepared),
                snapshot,
                requestHash: prepared.frozen.requestHash,
            });
            const dependency = await this.dependencies(tx, userId);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Адаптация рецепта',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.scopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: instruction,
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
                    route: 'balanced';
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
                       and task.contract_version=2 and task.task_code='recipe_adaptation'
                       and task.task_mode='adapt' and task.status='preview' for update of task
                `.execute(tx)
            ).rows[0];
            if (!task) throw new ConflictException('AI-предпросмотр недоступен');
            const preview = adaptSnapshotSchema.parse(task.preview);
            if (preview.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            if (classifyCulinaryQuestion(preview.input.instruction) !== 'safe')
                throw new ConflictException('Цель адаптации больше недоступна');
            const snapshot = await this.resolveSnapshot(tx, userId, preview.input.snapshotId);
            if (!snapshot.allergenComplete || JSON.stringify(snapshot) !== JSON.stringify(preview.snapshot))
                throw new ConflictException('Снимок рецепта изменился');
            const entitlement = await this.entitlements.resolve(userId, tx);
            prepareAiV2Preview(
                { task: 'recipe_adaptation', mode: 'adapt', input: preview.input },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set([aiV4ProviderProfiles.balanced.version]),
                    sourceSnapshotHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
                },
            );
            const buckets = (
                await sql<{ id: string; available: number }>`
                    select id,(balance_projection-reserved_projection)::integer available
                      from meal.ai_buckets
                     where user_id=${userId}::uuid and balance_projection-reserved_projection>=2
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
            const bucket = buckets.find((item) => item.available >= 2);
            if (!bucket) throw new ConflictException('Недостаточно AI-действий');
            const allocation: Allocation = { bucketId: bucket.id, amount: 2 };
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
                    cost: 2,
                    status: 'processing',
                    task_id: task.id,
                })
                .execute();
            await tx
                .insertInto('ai_messages')
                .values({
                    id: messageId,
                    role: 'user',
                    body: preview.input.instruction,
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
                    2,'initial',${requestHash},'queued','reserved',${now},${now},'simulator-balanced-v1',
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
                    ${randomUUID()}::uuid,'reserve',0,2,${now},${`${operationId}:reserve:${bucket.id}`},
                    ${bucket.id}::uuid,${operationId}::uuid,null
                )
            `.execute(tx);
            await sql`
                update meal.ai_buckets set reserved_projection=reserved_projection+2,version=version+1
                 where id=${bucket.id}::uuid and balance_projection-reserved_projection>=2
            `.execute(tx);
            await sql`
                insert into meal.ai_provider_dispatches(
                    operation_id,client_request_id,profile_version,requested_model,state,
                    estimated_cost_rub,created_at,updated_at
                ) values(
                    ${operationId}::uuid,${clientRequestId}::uuid,${task.providerProfileVersion},
                    'simulator-balanced-v1','prepared',6.00000000,${now},${now}
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
                snapshot,
                instruction: preview.input.instruction,
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
                const result = aiV2RecipeAdaptationResultSchema.parse(row.result);
                await sql`
                    insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id)
                    values(
                        ${randomUUID()}::uuid,'assistant',${result.title},${`${operationId}:assistant`},
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
            snapshot: reserved.snapshot,
            instruction: reserved.instruction,
            clock: new Date(reserved.clock.getTime() + 1),
        });
        if (submitted?.outcome.kind === 'accepted')
            await this.executor.read({
                operationId: reserved.operationId,
                dispatchVersion: submitted.nextVersion,
                snapshot: reserved.snapshot,
                clock: new Date(reserved.clock.getTime() + 4),
            });
        await this.projectOperation(reserved.operationId);
        return { operationId: reserved.operationId, replayed: false as const };
    }
}
