import { ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/public.js';
import { classifyIngredientExtractionText, sanitizeIngredientExtractionText } from './ai-ingredient-extraction.js';
import { aiV4ProviderProfiles } from './ai-policy-v4.js';
import { AiV2RecipeFromStockExecutor } from './ai-recipe-from-stock-executor.js';
import { aiV2RecipeFromStockShortlistSchema, type AiV2RecipeFromStockShortlist } from './ai-recipe-from-stock.js';
import { AiService } from './ai.service.js';
import { aiV2RecipeFromStockResultSchema, aiV2RunRequestSchema, parseAiV2PreviewRequest } from './ai-v2.contracts.js';
import { aiV2TaskContractColumns, aiV2TaskPreviewSnapshot, prepareAiV2Preview } from './ai-v2-preview.js';

type Tx = Transaction<DatabaseSchema>;
type Allocation = { bucketId: string; amount: number };

const selectSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('recipe_from_stock'),
    task: z.literal('recipe_from_stock'),
    mode: z.literal('select_existing'),
    input: z.strictObject({
        inventoryScope: z.enum(['personal', 'family']),
        goal: z.string().trim().min(1).max(500).optional(),
        maxResults: z.number().int().min(1).max(10),
    }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    activeBatchCount: z.number().int().nonnegative(),
    shortlist: aiV2RecipeFromStockShortlistSchema,
});

const generateSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('recipe_from_stock'),
    task: z.literal('recipe_from_stock'),
    mode: z.literal('generate_new'),
    input: z.strictObject({ shortlistId: z.uuid(), servings: z.number().int().min(1).max(20) }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    shortlist: aiV2RecipeFromStockShortlistSchema,
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

@Injectable()
export class AiV2RecipeFromStockInternalService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly quota: AiService,
        private readonly executor: AiV2RecipeFromStockExecutor,
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
        const rule = (
            await sql<{ id: string }>`
                select id from meal.ai_rule_versions where kind='cost' and version=4 and effective_at<=now() limit 1
            `.execute(tx)
        ).rows[0];
        if (!rule) throw new ServiceUnavailableException('AI v2 policies are not configured');
        const personal = (
            await sql<{
                id: string;
            }>`select id from meal.data_scopes where kind='private' and user_id=${userId}::uuid limit 1`.execute(tx)
        ).rows[0];
        if (!personal) throw new ServiceUnavailableException('Personal data scope is not configured');
        return { ruleId: rule.id, conversationScopeId: personal.id };
    }

    private async inventoryScope(tx: Tx, userId: string, kind: 'personal' | 'family') {
        if (kind === 'personal') {
            const scope = (
                await sql<{ id: string }>`
                    select id from meal.data_scopes where kind='private' and user_id=${userId}::uuid limit 1
                `.execute(tx)
            ).rows[0];
            if (!scope) throw new ConflictException('Личные запасы недоступны');
            return scope.id;
        }
        const family = (
            await sql<{ scopeId: string; familyId: string }>`
                select scope.id "scopeId",family.id "familyId"
                  from meal.family_memberships membership
                  join meal.families family on family.id=membership.family_id
                  join meal.data_scopes scope on scope.kind='family' and scope.family_id=family.id
                 where membership.user_id=${userId}::uuid and membership.left_at is null
                   and family.status='active' and family.archived_at is null
                 order by membership.joined_at,scope.id limit 1
            `.execute(tx)
        ).rows[0];
        if (!family) throw new ConflictException('Семейные запасы недоступны');
        const entitlement = await this.entitlements.resolveFamily(userId, family.familyId, tx);
        if (!entitlement.capabilities.family) throw new HttpException('Семейный доступ приостановлен', 403);
        return family.scopeId;
    }

    private async inventorySnapshot(tx: Tx, scopeId: string) {
        const count =
            (
                await sql<{ count: number }>`
                select count(*)::integer count from meal.inventory_batches
                 where scope_id=${scopeId}::uuid and archived_at is null and (quantity is null or quantity>0)
            `.execute(tx)
            ).rows[0]?.count ?? 0;
        const rows = (
            await sql<{
                batchId: string;
                batchVersion: number;
                ingredientId: string;
                ingredientVersion: number;
                name: string;
                quantityKnown: boolean;
                quantity: string | null;
                unit: string | null;
            }>`
                select batch.id "batchId",batch.version::integer "batchVersion",
                       ingredient.id "ingredientId",ingredient.version::integer "ingredientVersion",
                       ingredient.name,batch.quantity_known "quantityKnown",batch.quantity::text,
                       unit.code unit
                  from meal.inventory_batches batch
                  left join meal.brand_products product on product.id=batch.product_id
                  left join meal.ingredient_variants direct_variant on direct_variant.id=batch.variant_id
                  left join meal.ingredient_variants product_variant on product_variant.id=product.variant_id
                  join meal.ingredients ingredient on ingredient.id=coalesce(
                       batch.ingredient_id,direct_variant.ingredient_id,product_variant.ingredient_id
                  )
                  left join meal.units unit on unit.id=batch.unit_id
                 where batch.scope_id=${scopeId}::uuid and batch.archived_at is null
                   and (batch.quantity is null or batch.quantity>0)
                   and ingredient.status in('active','approved','published')
                 order by batch.expiry_on nulls last,batch.created_at,batch.id limit 40
            `.execute(tx)
        ).rows;
        const grouped = new Map<
            string,
            {
                ingredientId: string;
                ingredientVersion: number;
                name: string;
                quantityKnown: boolean;
                quantity: number;
                unit: string | null;
            }
        >();
        for (const row of rows) {
            const key = `${row.ingredientId}:${row.unit ?? ''}`;
            const current = grouped.get(key) ?? {
                ingredientId: row.ingredientId,
                ingredientVersion: row.ingredientVersion,
                name: row.name,
                quantityKnown: true,
                quantity: 0,
                unit: row.unit,
            };
            if (!row.quantityKnown || row.quantity === null) current.quantityKnown = false;
            else current.quantity += Number(row.quantity);
            grouped.set(key, current);
        }
        const stockItems = [...grouped.values()].slice(0, 40).map((item, index) => ({
            key: index + 1,
            ingredientId: item.ingredientId,
            ingredientVersion: item.ingredientVersion,
            name: item.name,
            quantityKnown: item.quantityKnown,
            quantity: item.quantityKnown ? item.quantity.toFixed(6).replace(/\.?0+$/u, '') : null,
            unit: item.unit,
        }));
        return {
            activeBatchCount: count,
            inventoryTruncated: count > rows.length,
            stockItems,
            stockRefs: rows.map((row) => ({ batchId: row.batchId, batchVersion: row.batchVersion })),
        };
    }

    private async candidatesFor(tx: Tx, scopeId: string, goal: string | null, maxResults: number) {
        return (
            await sql<{
                recipeId: string;
                recipeVersion: number;
                revisionId: string;
                revisionVersion: number;
                title: string;
                requiredCount: number;
                matchedRequiredCount: number;
            }>`
                with published as (
                    select distinct on(recipe.id)
                           recipe.id "recipeId",recipe.version::integer "recipeVersion",
                           revision.id "revisionId",revision.version::integer "revisionVersion",
                           revision.title,revision.description,revision.category,revision.tags,
                           publication.published_at
                      from meal.recipes recipe
                      join meal.recipe_revisions revision on revision.recipe_id=recipe.id
                      join meal.recipe_publications publication on publication.revision_id=revision.id
                     where publication.unpublished_at is null and publication.published_at<=now()
                       and recipe.archived_at is null
                       and recipe.status not in('hidden','unpublished','deleted','archived')
                     order by recipe.id,publication.published_at desc,publication.id desc
                ), ranked as (
                    select published.*,
                           (select count(*)::integer from meal.recipe_ingredients line
                             where line.revision_id=published."revisionId" and not line.optional) "requiredCount",
                           (select count(*)::integer from meal.recipe_ingredients line
                             where line.revision_id=published."revisionId" and not line.optional
                               and exists(
                                   select 1 from meal.inventory_batches batch
                                   left join meal.brand_products product on product.id=batch.product_id
                                   left join meal.ingredient_variants direct_variant on direct_variant.id=batch.variant_id
                                   left join meal.ingredient_variants product_variant on product_variant.id=product.variant_id
                                  where batch.scope_id=${scopeId}::uuid and batch.archived_at is null
                                    and (batch.quantity is null or batch.quantity>0)
                                    and (
                                        (line.product_id is not null and batch.product_id=line.product_id)
                                        or (line.product_id is null and line.variant_id is not null
                                            and coalesce(batch.variant_id,product.variant_id)=line.variant_id)
                                        or (line.product_id is null and line.variant_id is null
                                            and line.ingredient_id is not null
                                            and coalesce(batch.ingredient_id,direct_variant.ingredient_id,product_variant.ingredient_id)=line.ingredient_id)
                                    )
                               )) "matchedRequiredCount"
                      from published
                     where (${goal}::text is null or position(lower(${goal}) in lower(
                           published.title||' '||coalesce(published.description,'')||' '||
                           coalesce(published.category,'')||' '||array_to_string(coalesce(published.tags,'{}'::text[]),' ')
                     ))>0)
                )
                select "recipeId","recipeVersion","revisionId","revisionVersion",title,
                       "requiredCount","matchedRequiredCount"
                  from ranked where "requiredCount">0 and "matchedRequiredCount">0
                 order by case when "matchedRequiredCount"="requiredCount" then 0 else 1 end,
                          "matchedRequiredCount"::numeric/"requiredCount" desc,published_at desc,"recipeId"
                 limit ${maxResults}
            `.execute(tx)
        ).rows;
    }

    async selectExisting(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'recipe_from_stock' || request.mode !== 'select_existing')
            throw new ConflictException('Internal recipe selection task expected');
        const parsed = z
            .strictObject({
                inventoryScope: z.enum(['personal', 'family']),
                goal: z.string().trim().min(1).max(500).optional(),
                maxResults: z.number().int().min(1).max(10),
            })
            .parse(request.input);
        const sanitizedGoal = parsed.goal ? sanitizeIngredientExtractionText(parsed.goal).text : null;
        if (sanitizedGoal && classifyIngredientExtractionText(sanitizedGoal) !== 'safe')
            throw new ConflictException('Цель должна быть коротким текстом без ссылок и инструкций');
        const normalizedRequest = {
            task: 'recipe_from_stock' as const,
            mode: 'select_existing',
            input: {
                inventoryScope: parsed.inventoryScope,
                ...(sanitizedGoal ? { goal: sanitizedGoal } : {}),
                maxResults: parsed.maxResults,
            },
        };
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const entitlement = await this.entitlements.resolve(userId, tx);
            const scopeId = await this.inventoryScope(tx, userId, parsed.inventoryScope);
            const inventory = await this.inventorySnapshot(tx, scopeId);
            const candidates = await this.candidatesFor(tx, scopeId, sanitizedGoal, parsed.maxResults);
            const shortlist = aiV2RecipeFromStockShortlistSchema.parse({
                id: randomUUID(),
                inventoryScope: parsed.inventoryScope,
                scopeId,
                goal: sanitizedGoal,
                inventoryTruncated: inventory.inventoryTruncated,
                stockItems: inventory.stockItems,
                stockRefs: inventory.stockRefs,
                candidates,
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
            const snapshot = selectSnapshotSchema.parse({
                ...aiV2TaskPreviewSnapshot(prepared),
                activeBatchCount: inventory.activeBatchCount,
                shortlist,
            });
            const dependency = await this.dependencies(tx, userId);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Рецепты из запасов',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.conversationScopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: sanitizedGoal ?? 'Рецепты из запасов',
                    status: 'completed',
                    preview: sql`${JSON.stringify(snapshot)}::jsonb`,
                    accepted_at: now,
                    agreement_snapshot: {
                        version: 'ai-v2-backend-recipe-from-stock-selection',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: dependency.ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            const coversRequest = shortlist.candidates.some(
                (candidate) => candidate.matchedRequiredCount === candidate.requiredCount,
            );
            return {
                schemaVersion: 'ai-result-contract-v2:recipe_from_stock:select_existing' as const,
                shortlistId: shortlist.id,
                candidates: shortlist.candidates.map((candidate) => ({
                    recipeId: candidate.recipeId,
                    revisionId: candidate.revisionId,
                    title: candidate.title,
                    coveragePercent: Math.floor((candidate.matchedRequiredCount * 100) / candidate.requiredCount),
                    missingRequiredCount: candidate.requiredCount - candidate.matchedRequiredCount,
                })),
                generationAllowed: !coversRequest && shortlist.stockItems.length > 0,
                inventoryTruncated: shortlist.inventoryTruncated,
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
                   and task.task_code='recipe_from_stock' and task.task_mode='select_existing'
                   and task.status='completed' and (task.preview->>'expiresAt')::timestamptz>now()
                 order by task.created_at desc limit 20
            `.execute(tx)
        ).rows;
        const found = tasks
            .map((task) => selectSnapshotSchema.parse(task.preview))
            .find((snapshot) => snapshot.shortlist.id === shortlistId);
        if (!found) throw new ConflictException('Подборка рецептов недоступна');
        const shortlist = found.shortlist;
        const scopeId = await this.inventoryScope(tx, userId, shortlist.inventoryScope);
        if (scopeId !== shortlist.scopeId) throw new ConflictException('Подборка рецептов устарела');
        const count =
            (
                await sql<{ count: number }>`
                select count(*)::integer count from meal.inventory_batches
                 where scope_id=${scopeId}::uuid and archived_at is null and (quantity is null or quantity>0)
            `.execute(tx)
            ).rows[0]?.count ?? 0;
        if (count !== found.activeBatchCount) throw new ConflictException('Запасы изменились');
        if (shortlist.stockRefs.length) {
            const batches = (
                await sql<{ id: string; version: number }>`
                    select id,version::integer from meal.inventory_batches
                     where scope_id=${scopeId}::uuid and id=any(${shortlist.stockRefs.map((item) => item.batchId)}::uuid[])
                       and archived_at is null and (quantity is null or quantity>0)
                `.execute(tx)
            ).rows;
            for (const reference of shortlist.stockRefs) {
                const row = batches.find((batch) => batch.id === reference.batchId);
                if (!row || row.version !== reference.batchVersion) throw new ConflictException('Запасы изменились');
            }
        }
        if (shortlist.stockItems.length) {
            const ingredients = (
                await sql<{ id: string; version: number }>`
                    select id,version::integer from meal.ingredients
                     where id=any(${shortlist.stockItems.map((item) => item.ingredientId)}::uuid[])
                       and status in('active','approved','published')
                `.execute(tx)
            ).rows;
            for (const item of shortlist.stockItems) {
                const row = ingredients.find((ingredient) => ingredient.id === item.ingredientId);
                if (!row || row.version !== item.ingredientVersion)
                    throw new ConflictException('Каталог запасов изменился');
            }
        }
        if (shortlist.candidates.length) {
            const candidates = (
                await sql<{
                    recipeId: string;
                    recipeVersion: number;
                    revisionId: string;
                    revisionVersion: number;
                }>`
                    with current as (
                        select distinct on(recipe.id)
                               recipe.id "recipeId",recipe.version::integer "recipeVersion",
                               revision.id "revisionId",revision.version::integer "revisionVersion"
                          from meal.recipes recipe
                          join meal.recipe_revisions revision on revision.recipe_id=recipe.id
                          join meal.recipe_publications publication on publication.revision_id=revision.id
                         where recipe.id=any(${shortlist.candidates.map((item) => item.recipeId)}::uuid[])
                           and publication.unpublished_at is null and publication.published_at<=now()
                           and recipe.archived_at is null
                           and recipe.status not in('hidden','unpublished','deleted','archived')
                         order by recipe.id,publication.published_at desc,publication.id desc
                    ) select * from current
                `.execute(tx)
            ).rows;
            for (const candidate of shortlist.candidates) {
                const row = candidates.find(
                    (item) => item.recipeId === candidate.recipeId && item.revisionId === candidate.revisionId,
                );
                if (
                    !row ||
                    row.recipeVersion !== candidate.recipeVersion ||
                    row.revisionVersion !== candidate.revisionVersion
                )
                    throw new ConflictException('Рецепт из подборки изменился');
            }
        }
        return shortlist;
    }

    private assertGenerationAllowed(shortlist: AiV2RecipeFromStockShortlist) {
        if (!shortlist.stockItems.length) throw new ConflictException('Недостаточно запасов для генерации рецепта');
        if (shortlist.candidates.some((candidate) => candidate.matchedRequiredCount === candidate.requiredCount))
            throw new ConflictException('Сначала выберите подходящий готовый рецепт');
    }

    async previewGenerate(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'recipe_from_stock' || request.mode !== 'generate_new')
            throw new ConflictException('Internal recipe generation task expected');
        const input = z
            .strictObject({ shortlistId: z.uuid(), servings: z.number().int().min(1).max(20) })
            .parse(request.input);
        if ((await this.quota.balance(userId)).available < 2) throw new ConflictException('Недостаточно AI-действий');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const shortlist = await this.resolveShortlist(tx, userId, input.shortlistId);
            this.assertGenerationAllowed(shortlist);
            const entitlement = await this.entitlements.resolve(userId, tx);
            const now = new Date();
            const previewId = randomUUID();
            const sourceSnapshotHash = createHash('sha256').update(JSON.stringify(shortlist)).digest('hex');
            const prepared = prepareAiV2Preview(raw, {
                plan: entitlement.plan,
                offeredSources: [],
                readyProviderProfileVersions: new Set([aiV4ProviderProfiles.balanced.version]),
                sourceSnapshotHash,
                now,
                previewId,
            });
            const snapshot = generateSnapshotSchema.parse({
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
                    title: 'Новый рецепт из запасов',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.conversationScopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: shortlist.goal ?? 'Новый рецепт из запасов',
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
                       and task.contract_version=2 and task.task_code='recipe_from_stock'
                       and task.task_mode='generate_new' and task.status='preview' for update of task
                `.execute(tx)
            ).rows[0];
            if (!task) throw new ConflictException('AI-предпросмотр недоступен');
            const preview = generateSnapshotSchema.parse(task.preview);
            if (preview.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            const shortlist = await this.resolveShortlist(tx, userId, preview.input.shortlistId);
            this.assertGenerationAllowed(shortlist);
            if (JSON.stringify(shortlist) !== JSON.stringify(preview.shortlist))
                throw new ConflictException('Запасы или подборка рецептов изменились');
            const entitlement = await this.entitlements.resolve(userId, tx);
            prepareAiV2Preview(
                { task: 'recipe_from_stock', mode: 'generate_new', input: preview.input },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set([aiV4ProviderProfiles.balanced.version]),
                    sourceSnapshotHash: createHash('sha256').update(JSON.stringify(shortlist)).digest('hex'),
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
                    body: shortlist.goal ?? `Рецепт на ${preview.input.servings} порции`,
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
                shortlist,
                servings: preview.input.servings,
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
                const result = aiV2RecipeFromStockResultSchema.parse(row.result);
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
            shortlist: reserved.shortlist,
            servings: reserved.servings,
            clock: new Date(reserved.clock.getTime() + 1),
        });
        if (submitted?.outcome.kind === 'accepted')
            await this.executor.read({
                operationId: reserved.operationId,
                dispatchVersion: submitted.nextVersion,
                shortlist: reserved.shortlist,
                servings: reserved.servings,
                clock: new Date(reserved.clock.getTime() + 4),
            });
        await this.projectOperation(reserved.operationId);
        return { operationId: reserved.operationId, replayed: false as const };
    }
}
