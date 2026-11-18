import { ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/public.js';
import {
    aiV2BeveragePairingShortlistSchema,
    beveragePairingBoundaryResult,
    containsAlcoholMarker,
} from './ai-beverage-pairing.js';
import { AiV2BeveragePairingExecutor } from './ai-beverage-pairing-executor.js';
import { classifyIngredientExtractionText, sanitizeIngredientExtractionText } from './ai-ingredient-extraction.js';
import { aiV4ProviderProfiles } from './ai-policy-v4.js';
import { AiService } from './ai.service.js';
import { aiV2BeveragePairingResultSchema, aiV2RunRequestSchema, parseAiV2PreviewRequest } from './ai-v2.contracts.js';
import { aiV2TaskContractColumns, aiV2TaskPreviewSnapshot, prepareAiV2Preview } from './ai-v2-preview.js';

type Tx = Transaction<DatabaseSchema>;
type Allocation = { bucketId: string; amount: number };

const catalogSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('beverage_pairing'),
    task: z.literal('beverage_pairing'),
    mode: z.literal('catalog'),
    input: z.strictObject({ recipeId: z.uuid() }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    shortlist: aiV2BeveragePairingShortlistSchema,
});

const customSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('beverage_pairing'),
    task: z.literal('beverage_pairing'),
    mode: z.literal('custom'),
    input: z.strictObject({ shortlistId: z.uuid(), preferences: z.string().trim().min(1).max(500).optional() }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    shortlist: aiV2BeveragePairingShortlistSchema,
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

@Injectable()
export class AiV2BeveragePairingInternalService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly quota: AiService,
        private readonly executor: AiV2BeveragePairingExecutor,
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
        const rule = (
            await sql<{ id: string }>`
                select id from meal.ai_rule_versions where kind='cost' and version=4 and effective_at<=now() limit 1
            `.execute(tx)
        ).rows[0];
        if (!scope || !rule) throw new ServiceUnavailableException('AI v2 dependencies are not configured');
        return { scopeId: scope.id, ruleId: rule.id };
    }

    private boundedStrings(value: unknown, max: number) {
        return Array.isArray(value)
            ? value
                  .filter((item): item is string => typeof item === 'string')
                  .map((item) => item.trim())
                  .filter((item) => item.length > 0 && item.length <= 160)
                  .slice(0, max)
            : [];
    }

    private async buildShortlist(tx: Tx, recipeId: string) {
        const recipe = (
            await sql<{
                recipeId: string;
                recipeVersion: number;
                revisionId: string;
                revisionVersion: number;
                publicationId: string;
                publicationVersion: number;
                title: string;
                category: string | null;
                tags: unknown;
            }>`
                select recipe.id "recipeId",recipe.version::integer "recipeVersion",
                       revision.id "revisionId",revision.version::integer "revisionVersion",
                       publication.id "publicationId",publication.version::integer "publicationVersion",
                       revision.title,revision.category,revision.tags
                  from meal.recipes recipe
                  join meal.recipe_revisions revision on revision.recipe_id=recipe.id
                  join meal.recipe_publications publication on publication.revision_id=revision.id
                 where recipe.id=${recipeId}::uuid and publication.unpublished_at is null
                   and publication.published_at<=now() and recipe.archived_at is null
                   and recipe.status not in('hidden','unpublished','deleted','archived')
                 order by publication.published_at desc,publication.id desc limit 1
            `.execute(tx)
        ).rows[0];
        if (!recipe) throw new ConflictException('Опубликованный рецепт недоступен');
        const ingredients = (
            await sql<{ name: string }>`
                select coalesce(product.name,variant.name,ingredient.name,source.title,'Ингредиент') name
                  from meal.recipe_ingredients line
                  left join meal.brand_products product on product.id=line.product_id
                  left join meal.ingredient_variants variant on variant.id=line.variant_id
                  left join meal.ingredients ingredient on ingredient.id=line.ingredient_id
                  left join lateral(
                      select revision.title from meal.recipe_revisions revision
                      join meal.recipe_publications publication on publication.revision_id=revision.id
                       where revision.recipe_id=line.source_recipe_id and publication.unpublished_at is null
                         and publication.published_at<=now()
                       order by publication.published_at desc,publication.id desc limit 1
                  ) source on true
                 where line.revision_id=${recipe.revisionId}::uuid
                 order by line.position,line.id limit 20
            `.execute(tx)
        ).rows
            .map((row) => row.name.trim())
            .filter(Boolean);
        const recipeTags = this.boundedStrings(recipe.tags, 20).filter((tag) => tag.length <= 80);
        const alcoholBlocked = [recipe.title, ...ingredients].some(containsAlcoholMarker);
        const rawCandidates = alcoholBlocked
            ? []
            : (
                  await sql<{
                      variantId: string;
                      variantVersion: number;
                      ingredientId: string;
                      ingredientVersion: number;
                      categoryId: string;
                      categoryVersion: number;
                      name: string;
                      matchRank: number;
                  }>`
                    select variant.id "variantId",variant.version::integer "variantVersion",
                           ingredient.id "ingredientId",ingredient.version::integer "ingredientVersion",
                           category.id "categoryId",category.version::integer "categoryVersion",
                           variant.name,
                           (select count(*)::integer from jsonb_array_elements_text(
                               case when jsonb_typeof(variant.attributes->'pairingTags')='array'
                                    then variant.attributes->'pairingTags' else '[]'::jsonb end
                           ) tag(value) where lower(tag.value)=any(${[recipe.category ?? '', ...recipeTags].map((item) => item.toLowerCase())}::text[])) "matchRank"
                      from meal.ingredient_variants variant
                      join meal.ingredients ingredient on ingredient.id=variant.ingredient_id
                      join meal.categories category on category.id=ingredient.primary_category_id
                     where variant.status in('active','approved','published')
                       and ingredient.status in('active','approved','published')
                       and variant.attributes->'beverage'='true'::jsonb
                       and variant.attributes->'alcoholFree'='true'::jsonb
                       and (not (variant.attributes ? 'alcoholByVolume')
                            or variant.attributes->>'alcoholByVolume' ~ '^0(?:\.0+)?$')
                     order by "matchRank" desc,lower(variant.name),variant.id limit 16
                `.execute(tx)
              ).rows;
        const candidates = rawCandidates
            .filter((candidate) => !containsAlcoholMarker(candidate.name))
            .slice(0, 8)
            .map(({ matchRank, ...candidate }, index) => {
                void matchRank;
                return { key: index + 1, ...candidate };
            });
        return aiV2BeveragePairingShortlistSchema.parse({
            id: randomUUID(),
            recipeId: recipe.recipeId,
            recipeVersion: recipe.recipeVersion,
            revisionId: recipe.revisionId,
            revisionVersion: recipe.revisionVersion,
            publicationId: recipe.publicationId,
            publicationVersion: recipe.publicationVersion,
            recipeTitle: recipe.title,
            recipeCategory: recipe.category,
            recipeTags,
            recipeIngredients: ingredients,
            alcoholBlocked,
            candidates,
        });
    }

    async catalog(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'beverage_pairing' || request.mode !== 'catalog')
            throw new ConflictException('Internal beverage catalog task expected');
        const input = z.strictObject({ recipeId: z.uuid() }).parse(request.input);
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const entitlement = await this.entitlements.resolve(userId, tx);
            const shortlist = await this.buildShortlist(tx, input.recipeId);
            const now = new Date();
            const previewId = randomUUID();
            const sourceSnapshotHash = createHash('sha256').update(JSON.stringify(shortlist)).digest('hex');
            const prepared = prepareAiV2Preview(request, {
                plan: entitlement.plan,
                offeredSources: [],
                readyProviderProfileVersions: new Set(),
                sourceSnapshotHash,
                now,
                previewId,
            });
            const snapshot = catalogSnapshotSchema.parse({ ...aiV2TaskPreviewSnapshot(prepared), shortlist });
            const dependency = await this.dependencies(tx, userId);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Безалкогольные напитки к рецепту',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.scopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: shortlist.recipeTitle,
                    status: 'completed',
                    preview: sql`${JSON.stringify(snapshot)}::jsonb`,
                    accepted_at: now,
                    agreement_snapshot: {
                        version: 'ai-v2-backend-non-alcoholic-beverage-catalog',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: dependency.ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return {
                schemaVersion: 'ai-result-contract-v2:beverage_pairing:catalog' as const,
                shortlistId: shortlist.id,
                recipeId: shortlist.recipeId,
                pairingAvailable: !shortlist.alcoholBlocked && shortlist.candidates.length > 0,
                warningCodes: shortlist.alcoholBlocked
                    ? (['alcohol_mode_disabled'] as const)
                    : shortlist.candidates.length
                      ? ([] as const)
                      : (['no_match'] as const),
                candidates: shortlist.candidates.map((candidate) => ({
                    id: candidate.variantId,
                    name: candidate.name,
                })),
                expiresAt: prepared.preview.expiresAt,
            };
        });
    }

    private async resolveShortlist(tx: Tx, userId: string, shortlistId: string) {
        const tasks = (
            await sql<{ preview: unknown }>`
                select task.preview from meal.ai_tasks task
                join meal.ai_conversations conversation on conversation.id=task.conversation_id
                 where conversation.user_id=${userId}::uuid and task.contract_version=2
                   and task.task_code='beverage_pairing' and task.task_mode='catalog'
                   and task.status='completed' and (task.preview->>'expiresAt')::timestamptz>now()
                 order by task.created_at desc limit 20
            `.execute(tx)
        ).rows;
        const shortlist = tasks
            .map((task) => catalogSnapshotSchema.parse(task.preview).shortlist)
            .find((item) => item.id === shortlistId);
        if (!shortlist) throw new ConflictException('Подборка напитков недоступна');
        const current = await this.buildShortlist(tx, shortlist.recipeId);
        const comparable = { ...current, id: shortlist.id };
        if (JSON.stringify(comparable) !== JSON.stringify(shortlist))
            throw new ConflictException('Рецепт или каталог напитков изменился');
        return shortlist;
    }

    private sanitizePreferences(value: string | undefined) {
        if (!value) return undefined;
        const sanitized = sanitizeIngredientExtractionText(value).text;
        if (classifyIngredientExtractionText(sanitized) !== 'safe')
            throw new ConflictException('Предпочтения должны быть коротким текстом без ссылок и инструкций');
        return sanitized;
    }

    async previewCustom(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'beverage_pairing' || request.mode !== 'custom')
            throw new ConflictException('Internal beverage pairing task expected');
        const input = z
            .strictObject({ shortlistId: z.uuid(), preferences: z.string().trim().min(1).max(500).optional() })
            .parse(request.input);
        const preferences = this.sanitizePreferences(input.preferences);
        const boundary = await this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const shortlist = await this.resolveShortlist(tx, userId, input.shortlistId);
            if (shortlist.alcoholBlocked)
                return { kind: 'resolved' as const, result: beveragePairingBoundaryResult('alcohol_mode_disabled') };
            if (!shortlist.candidates.length)
                return { kind: 'resolved' as const, result: beveragePairingBoundaryResult('no_match') };
            if (shortlist.candidates.length === 1 && !preferences) {
                const candidate = shortlist.candidates[0]!;
                return {
                    kind: 'resolved' as const,
                    result: aiV2BeveragePairingResultSchema.parse({
                        schemaVersion: 'ai-result-contract-v2:beverage_pairing:custom',
                        selectedCandidateId: candidate.variantId,
                        selectedName: candidate.name,
                        explanation: 'Подходит по подтверждённым каталожным признакам блюда.',
                        warningCodes: [],
                        recoveryCode: 'review_pairing',
                    }),
                };
            }
            return { kind: 'model' as const, shortlist };
        });
        if (boundary.kind === 'resolved') return boundary;
        if ((await this.quota.balance(userId)).available < 1) throw new ConflictException('Недостаточно AI-действий');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const shortlist = await this.resolveShortlist(tx, userId, input.shortlistId);
            if (JSON.stringify(shortlist) !== JSON.stringify(boundary.shortlist))
                throw new ConflictException('Подборка напитков изменилась');
            const entitlement = await this.entitlements.resolve(userId, tx);
            const now = new Date();
            const previewId = randomUUID();
            const normalizedRequest = {
                task: 'beverage_pairing' as const,
                mode: 'custom',
                input: { shortlistId: input.shortlistId, ...(preferences ? { preferences } : {}) },
            };
            const sourceSnapshotHash = createHash('sha256').update(JSON.stringify(shortlist)).digest('hex');
            const prepared = prepareAiV2Preview(normalizedRequest, {
                plan: entitlement.plan,
                offeredSources: [],
                readyProviderProfileVersions: new Set([aiV4ProviderProfiles.economy.version]),
                sourceSnapshotHash,
                now,
                previewId,
            });
            const snapshot = customSnapshotSchema.parse({
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
                    title: 'Подбор напитка',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.scopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: shortlist.recipeTitle,
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
                       and task.contract_version=2 and task.task_code='beverage_pairing'
                       and task.task_mode='custom' and task.status='preview' for update of task
                `.execute(tx)
            ).rows[0];
            if (!task) throw new ConflictException('AI-предпросмотр недоступен');
            const preview = customSnapshotSchema.parse(task.preview);
            if (preview.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            const shortlist = await this.resolveShortlist(tx, userId, preview.input.shortlistId);
            if (shortlist.alcoholBlocked || !shortlist.candidates.length)
                throw new ConflictException('Подборка напитков больше недоступна');
            if (JSON.stringify(shortlist) !== JSON.stringify(preview.shortlist))
                throw new ConflictException('Подборка напитков изменилась');
            const entitlement = await this.entitlements.resolve(userId, tx);
            prepareAiV2Preview(
                { task: 'beverage_pairing', mode: 'custom', input: preview.input },
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
                    body: preview.input.preferences ?? shortlist.recipeTitle,
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
                shortlist,
                preferences: preview.input.preferences,
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
                const result = aiV2BeveragePairingResultSchema.parse(row.result);
                await sql`
                    insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id)
                    values(
                        ${randomUUID()}::uuid,'assistant',${result.explanation ?? 'Подходящий напиток не найден'},
                        ${`${operationId}:assistant`},${row.conversationId}::uuid,${row.intervalId}::uuid
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
            ...(reserved.preferences ? { preferences: reserved.preferences } : {}),
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
