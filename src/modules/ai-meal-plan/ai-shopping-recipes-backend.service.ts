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
import {
    aiV2BackendOperationSchema,
    aiV2RunRequestSchema,
    aiV2ShoppingListFromRecipesInputSchema,
    aiV2TaskContractColumns,
    aiV2TaskPreviewSnapshot,
    parseAiV2PreviewRequest,
    prepareAiV2Preview,
    type AiV2BackendOperation,
} from '../ai/public.js';
import { EntitlementsService } from '../entitlements/public.js';
import { aggregateRecipeShoppingLines, type RecipeShoppingSourceLine } from '../shopping/public.js';
import { aiV2ShoppingListFromRecipesResultSchema } from './ai-meal-plan.contracts.js';

type Tx = Transaction<DatabaseSchema>;

const sourceRecipeSchema = z.strictObject({
    recipeId: z.uuid(),
    recipeVersion: z.number().int().positive(),
    revisionId: z.uuid(),
    revisionVersion: z.number().int().positive(),
    publicationId: z.uuid(),
    publicationVersion: z.number().int().positive(),
    portions: z.number().int().min(1).max(1000),
});

const shoppingRecipesSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('shopping_list_generation'),
    task: z.literal('shopping_list_generation'),
    mode: z.literal('from_recipes'),
    input: aiV2ShoppingListFromRecipesInputSchema,
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
    sourceEvidence: z.strictObject({
        scopeId: z.uuid(),
        scopeVersion: z.number().int().positive(),
        recipes: z.array(sourceRecipeSchema).min(1).max(20),
        sourceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
    result: aiV2ShoppingListFromRecipesResultSchema,
});

type ShoppingRecipesSnapshot = z.infer<typeof shoppingRecipesSnapshotSchema>;

type RecipeSource = z.infer<typeof sourceRecipeSchema>;

type SourceLineRow = RecipeShoppingSourceLine & {
    lineVersion: number;
    ingredientVersion: number | null;
    variantVersion: number | null;
    productVersion: number | null;
    productVariantVersion: number | null;
    sourceRecipeVersion: number | null;
    sourceRevisionId: string | null;
    sourceRevisionVersion: number | null;
    sourcePublicationId: string | null;
    sourcePublicationVersion: number | null;
    unitVersion: number | null;
    baseUnitId: string | null;
    baseUnitVersion: number | null;
};

@Injectable()
export class AiShoppingRecipesBackendService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
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

    private async ruleId(tx: Tx) {
        const rule = (
            await sql<{ id: string }>`
                select id from meal.ai_rule_versions
                 where kind='cost' and version=4 and effective_at<=now() limit 1
            `.execute(tx)
        ).rows[0];
        if (!rule) throw new ServiceUnavailableException('AI v2 policies are not configured');
        return rule.id;
    }

    private async resolveScope(tx: Tx, userId: string) {
        const scope = (
            await sql<{ id: string; version: number }>`
                select id,version::integer from meal.data_scopes
                 where kind='private' and user_id=${userId}::uuid limit 1
            `.execute(tx)
        ).rows[0];
        if (!scope) throw new ConflictException('Личная область покупок недоступна');
        return scope;
    }

    private async resolveSource(tx: Tx, recipeIds: string[], scope: { id: string; version: number }) {
        const recipes = (
            await sql<RecipeSource>`
                select distinct on(recipe.id)
                       recipe.id "recipeId",recipe.version::integer "recipeVersion",
                       revision.id "revisionId",revision.version::integer "revisionVersion",
                       publication.id "publicationId",publication.version::integer "publicationVersion",
                       revision.portions::integer portions
                  from meal.recipes recipe
                  join meal.recipe_revisions revision on revision.recipe_id=recipe.id
                  join meal.recipe_publications publication on publication.revision_id=revision.id
                 where recipe.id=any(${recipeIds}::uuid[])
                   and publication.unpublished_at is null and publication.published_at<=now()
                   and recipe.archived_at is null
                   and recipe.status not in('hidden','unpublished','deleted','archived')
                 order by recipe.id,publication.published_at desc,publication.id desc
            `.execute(tx)
        ).rows.map((row) => sourceRecipeSchema.parse(row));
        if (recipes.length !== recipeIds.length)
            throw new HttpException('Один или несколько рецептов не опубликованы', 404);

        const revisionIds = recipes.map((recipe) => recipe.revisionId);
        const rows = (
            await sql<SourceLineRow>`
                select line.id "lineId",line.version::integer "lineVersion",line.position,
                       coalesce(product.name,variant.name,ingredient.name,source_revision.title,'Ингредиент') name,
                       line.quantity::text quantity,
                       coalesce(line.ingredient_id,variant.ingredient_id,product_variant.ingredient_id) "ingredientId",
                       line.variant_id "variantId",line.product_id "productId",line.source_recipe_id "sourceRecipeId",
                       ingredient.version::integer "ingredientVersion",
                       variant.version::integer "variantVersion",
                       product.version::integer "productVersion",
                       product_variant.version::integer "productVariantVersion",
                       source_recipe.version::integer "sourceRecipeVersion",
                       unit.id "unitId",unit.code unit,unit.dimension "unitDimension",unit.factor::text "unitFactor",
                       unit.approximate "unitApproximate",unit.version::integer "unitVersion",
                       base_unit.id "baseUnitId",base_unit.code "baseUnit",
                       base_unit.version::integer "baseUnitVersion",
                       source_revision.id "sourceRevisionId",
                       source_revision.version::integer "sourceRevisionVersion",
                       source_revision."publicationId" "sourcePublicationId",
                       source_revision."publicationVersion" "sourcePublicationVersion",
                       line.revision_id "revisionId",revision.portions::integer portions
                  from meal.recipe_ingredients line
                  join meal.recipe_revisions revision on revision.id=line.revision_id
                  left join meal.ingredients ingredient on ingredient.id=line.ingredient_id
                  left join meal.ingredient_variants variant on variant.id=line.variant_id
                  left join meal.brand_products product on product.id=line.product_id
                  left join meal.ingredient_variants product_variant on product_variant.id=product.variant_id
                  left join meal.recipes source_recipe on source_recipe.id=line.source_recipe_id
                  left join lateral(
                       select source_revision.id,source_revision.version,source_revision.title,
                              source_publication.id "publicationId",
                              source_publication.version::integer "publicationVersion"
                         from meal.recipe_revisions source_revision
                         join meal.recipe_publications source_publication on source_publication.revision_id=source_revision.id
                        where source_revision.recipe_id=line.source_recipe_id
                          and source_publication.unpublished_at is null and source_publication.published_at<=now()
                        order by source_publication.published_at desc,source_publication.id desc limit 1
                  ) source_revision on true
                  left join meal.units unit on unit.id=line.unit_id
                  left join lateral(
                       select candidate.id,candidate.code,candidate.version
                        where candidate.dimension=unit.dimension and candidate.factor=1 and not candidate.approximate
                        order by candidate.code,candidate.id limit 1
                  ) base_unit on true
                 where line.revision_id=any(${revisionIds}::uuid[]) and not line.optional
                 order by line.revision_id,line.position,line.id
                 limit 801
            `.execute(tx)
        ).rows;
        if (rows.length > 800) throw new HttpException('Слишком много ингредиентов для одного предпросмотра', 422);

        const aggregation = aggregateRecipeShoppingLines(rows);
        if (aggregation.items.length > 200) throw new HttpException('Список покупок слишком большой', 422);
        const sourceSnapshotHash = createHash('sha256')
            .update(JSON.stringify({ recipeIds, scope, recipes, lines: rows }))
            .digest('hex');
        const warningCodes = [
            ...(aggregation.quantityCheckRequired ? (['quantity_check_required'] as const) : []),
            ...(aggregation.incompatibleUnitsPreserved ? (['incompatible_units_preserved'] as const) : []),
        ];
        const result = aiV2ShoppingListFromRecipesResultSchema.parse({
            schemaVersion: 'ai-result-contract-v2:shopping_list_generation:from_recipes',
            data: { recipeIds, items: aggregation.items },
            warningCodes,
        });
        return { recipes, sourceSnapshotHash, result };
    }

    private result(snapshot: ShoppingRecipesSnapshot) {
        return aiV2ShoppingListFromRecipesResultSchema.parse(snapshot.result);
    }

    async preview(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'shopping_list_generation' || request.mode !== 'from_recipes')
            throw new ConflictException('Internal recipe shopping task expected');
        const parsedInput = aiV2ShoppingListFromRecipesInputSchema.parse(request.input);
        const input = { recipeIds: [...parsedInput.recipeIds].sort() };
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            await sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${input.recipeIds.join(':')}`},0))`.execute(
                tx,
            );
            const entitlement = await this.entitlements.resolve(userId, tx);
            if (!entitlement.capabilities.smartShopping)
                throw new ForbiddenException('Умное планирование доступно на тарифах Plus и Pro');
            const scope = await this.resolveScope(tx, userId);
            const source = await this.resolveSource(tx, input.recipeIds, scope);
            const previewId = randomUUID();
            const now = new Date();
            const prepared = prepareAiV2Preview(
                { task: 'shopping_list_generation', mode: 'from_recipes', input },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set(),
                    sourceSnapshotHash: source.sourceSnapshotHash,
                    previewId,
                    now,
                },
            );
            const cached = (
                await sql<{ id: string; preview: unknown }>`
                    select task.id,task.preview from meal.ai_tasks task
                    join meal.ai_conversations conversation on conversation.id=task.conversation_id
                     where conversation.user_id=${userId}::uuid and task.contract_version=2
                       and task.task_code='shopping_list_generation' and task.task_mode='from_recipes'
                       and task.status='preview' and task.source_snapshot_hash=${source.sourceSnapshotHash}
                       and task.preview->>'requestHash'=${prepared.frozen.requestHash}
                       and (task.preview->>'expiresAt')::timestamptz>now()
                     order by task.created_at desc limit 1
                `.execute(tx)
            ).rows[0];
            if (cached) {
                const snapshot = shoppingRecipesSnapshotSchema.parse(cached.preview);
                return {
                    cacheHit: true as const,
                    preview: { ...prepared.preview, id: cached.id, expiresAt: snapshot.expiresAt },
                    result: this.result(snapshot),
                };
            }
            const snapshot = shoppingRecipesSnapshotSchema.parse({
                ...aiV2TaskPreviewSnapshot(prepared),
                requestHash: prepared.frozen.requestHash,
                sourceEvidence: {
                    scopeId: scope.id,
                    scopeVersion: scope.version,
                    recipes: source.recipes,
                    sourceSnapshotHash: source.sourceSnapshotHash,
                },
                result: source.result,
            });
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Список покупок по рецептам',
                    archived_at: null,
                    user_id: userId,
                    scope_id: scope.id,
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
                        version: 'ai-v2-backend-recipe-shopping',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: await this.ruleId(tx),
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return { cacheHit: false as const, preview: prepared.preview, result: source.result };
        });
    }

    private async readback(tx: Tx, userId: string, operationId: string): Promise<AiV2BackendOperation> {
        const row = (
            await sql<{
                id: string;
                taskId: string;
                task: string;
                mode: string;
                state: string;
                financialState: string;
                providerCostState: string;
                result: unknown;
                createdAt: Date;
                updatedAt: Date;
                expiresAt: Date;
                version: number;
            }>`
                select operation.id,operation.task_id "taskId",task.task_code task,task.task_mode mode,
                       operation.lifecycle_state state,operation.financial_state "financialState",
                       operation.provider_cost_state "providerCostState",operation.result_snapshot result,
                       operation.created_at "createdAt",operation.updated_at "updatedAt",
                       operation.expires_at "expiresAt",operation.version::integer version
                  from meal.ai_operations operation join meal.ai_tasks task on task.id=operation.task_id
                 where operation.id=${operationId}::uuid and operation.user_id=${userId}::uuid
                   and operation.contract_version=2 and task.task_code='shopping_list_generation'
                   and task.task_mode='from_recipes'
            `.execute(tx)
        ).rows[0];
        if (!row) throw new HttpException('AI-операция не найдена', 404);
        return aiV2BackendOperationSchema.parse({
            item: {
                ...row,
                createdAt: row.createdAt.toISOString(),
                updatedAt: row.updatedAt.toISOString(),
                expiresAt: row.expiresAt.toISOString(),
            },
        });
    }

    async run(userId: string, raw: unknown) {
        const input = aiV2RunRequestSchema.parse(raw);
        const requestHash = createHash('sha256')
            .update(JSON.stringify({ contractVersion: 2, previewId: input.previewId }))
            .digest('hex');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const existing = (
                await sql<{ id: string; requestHash: string }>`
                    select id,request_hash "requestHash" from meal.ai_operations
                     where user_id=${userId}::uuid and idempotency_key=${input.idempotencyKey} and contract_version=2
                     for update
                `.execute(tx)
            ).rows[0];
            if (existing) {
                if (existing.requestHash !== requestHash)
                    throw new ConflictException('Ключ идемпотентности использован с другим запросом');
                return this.readback(tx, userId, existing.id);
            }
            const task = (
                await sql<{
                    id: string;
                    conversationId: string;
                    status: string;
                    preview: unknown;
                    route: string;
                    taskPolicyVersion: string;
                    contextPolicyVersion: string;
                    routingPolicyVersion: string;
                    pricePolicyVersion: string;
                    resultSchemaVersion: string;
                    safetyPolicyVersion: string;
                    cachePolicyVersion: string;
                    sourceSnapshotHash: string;
                }>`
                    select task.id,task.conversation_id "conversationId",task.status,task.preview,
                           task.execution_route route,task.task_policy_version "taskPolicyVersion",
                           task.context_policy_version "contextPolicyVersion",
                           task.routing_policy_version "routingPolicyVersion",
                           task.price_policy_version "pricePolicyVersion",
                           task.result_schema_version "resultSchemaVersion",
                           task.safety_policy_version "safetyPolicyVersion",
                           task.cache_policy_version "cachePolicyVersion",
                           task.source_snapshot_hash "sourceSnapshotHash"
                      from meal.ai_tasks task join meal.ai_conversations conversation on conversation.id=task.conversation_id
                     where task.id=${input.previewId}::uuid and conversation.user_id=${userId}::uuid
                       and task.contract_version=2 and task.task_code='shopping_list_generation'
                       and task.task_mode='from_recipes' for update of task
                `.execute(tx)
            ).rows[0];
            if (!task) throw new HttpException('AI-предпросмотр не найден', 404);
            if (task.status !== 'preview') throw new ConflictException('AI-предпросмотр уже использован');
            const snapshot = shoppingRecipesSnapshotSchema.parse(task.preview);
            if (snapshot.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            if (snapshot.sourceEvidence.sourceSnapshotHash !== task.sourceSnapshotHash)
                throw new ConflictException('Источник AI-предпросмотра изменился');
            const entitlement = await this.entitlements.resolve(userId, tx);
            if (!entitlement.capabilities.smartShopping)
                throw new ForbiddenException('Умное планирование доступно на тарифах Plus и Pro');
            const scope = await this.resolveScope(tx, userId);
            if (scope.id !== snapshot.sourceEvidence.scopeId || scope.version !== snapshot.sourceEvidence.scopeVersion)
                throw new ConflictException('Область покупок изменилась; создайте новый предпросмотр');
            const source = await this.resolveSource(tx, snapshot.input.recipeIds, scope);
            if (source.sourceSnapshotHash !== snapshot.sourceEvidence.sourceSnapshotHash)
                throw new ConflictException('Рецепты изменились; создайте новый предпросмотр');

            const operationId = randomUUID();
            const intervalId = randomUUID();
            const userMessageId = randomUUID();
            const assistantMessageId = randomUUID();
            const startedAt = new Date();
            const intervalEndsAt = new Date(startedAt.getTime() + 10 * 60_000);
            const expiresAt = new Date(startedAt.getTime() + 30 * 86_400_000);
            const result = this.result(snapshot);
            await sql`
                insert into meal.ai_intervals(id,starts_at,ends_at,clarifications_used,cost,status,task_id)
                values(${intervalId}::uuid,${startedAt},${intervalEndsAt},0,0,'completed',${task.id}::uuid)
            `.execute(tx);
            await sql`
                insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id)
                values(${userMessageId}::uuid,'user','Сформировать список покупок по рецептам',${input.idempotencyKey},${task.conversationId}::uuid,${intervalId}::uuid),
                      (${assistantMessageId}::uuid,'assistant',${`Список покупок подготовлен: ${result.data.items.length} позиций.`},${assistantMessageId},${task.conversationId}::uuid,${intervalId}::uuid)
            `.execute(tx);
            await sql`
                insert into meal.ai_operations(
                    id,status,result_snapshot,started_at,finished_at,provider_cost,idempotency_key,interval_id,message_id,
                    user_id,task_id,contract_version,command_kind,request_hash,lifecycle_state,financial_state,
                    queued_at,next_attempt_at,task_policy_version,context_manifest_version,provider_profile_version,
                    execution_route,routing_policy_version,price_policy_version,result_schema_version,
                    safety_policy_version,cache_policy_version,provider_cost_state,provider_cost_currency,updated_at,expires_at)
                values(
                    ${operationId}::uuid,'succeeded',${JSON.stringify(result)}::jsonb,${startedAt},${startedAt},null,
                    ${input.idempotencyKey},${intervalId}::uuid,${userMessageId}::uuid,${userId}::uuid,${task.id}::uuid,
                    2,'initial',${requestHash},'succeeded','none',${startedAt},${startedAt},${task.taskPolicyVersion},
                    ${task.contextPolicyVersion},null,${task.route},${task.routingPolicyVersion},${task.pricePolicyVersion},
                    ${task.resultSchemaVersion},${task.safetyPolicyVersion},${task.cachePolicyVersion},'none',null,
                    ${startedAt},${expiresAt})
            `.execute(tx);
            await sql`
                update meal.ai_tasks set status='completed',accepted_at=${startedAt},version=version+1
                 where id=${task.id}::uuid and status='preview'
            `.execute(tx);
            return this.readback(tx, userId, operationId);
        });
    }

    async operation(userId: string, rawOperationId: string) {
        const operationId = z.uuid().parse(rawOperationId);
        return this.database.transaction((tx) => this.readback(tx, userId, operationId));
    }
}
