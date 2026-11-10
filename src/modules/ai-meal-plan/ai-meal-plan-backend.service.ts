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
import { MealPlanService } from '../meal-plan/public.js';
import {
    aiV2BackendOperationSchema,
    aiV2RunRequestSchema,
    aiV2ShoppingListFromMealPlanInputSchema,
    aiV2TaskContractColumns,
    aiV2TaskPreviewSnapshot,
    prepareAiV2Preview,
    type AiV2BackendOperation,
} from '../ai/public.js';
import { aiV2ShoppingListFromMealPlanResultSchema } from './ai-meal-plan.contracts.js';

type Tx = Transaction<DatabaseSchema>;

const shoppingTaskPreviewSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('shopping_list_generation'),
    task: z.literal('shopping_list_generation'),
    mode: z.literal('from_meal_plan'),
    input: aiV2ShoppingListFromMealPlanInputSchema,
    sourceIds: z.array(z.uuid()).max(16),
    expiresAt: z.iso.datetime(),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
    sourceEvidence: z.strictObject({
        scopeId: z.uuid(),
        revisionId: z.uuid(),
        sourceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
    result: aiV2ShoppingListFromMealPlanResultSchema,
});

type ShoppingTaskPreview = z.infer<typeof shoppingTaskPreviewSchema>;

@Injectable()
export class AiMealPlanBackendService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly mealPlans: MealPlanService,
    ) {}

    private async writable(tx: Tx, userId: string) {
        const user =
            await sql`select id from meal.users where id=${userId}::uuid and status='active' and archived_at is null for update`.execute(
                tx,
            );
        if (!user.rows.length) throw new HttpException('Аккаунт недоступен', 403);
        const sanction =
            await sql`select id from meal.sanctions where user_id=${userId}::uuid and scope in('account','ai') and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                tx,
            );
        if (sanction.rows.length) throw new HttpException('Доступен только просмотр', 403);
    }

    private async assertResolvedSource(tx: Tx, userId: string, preview: ShoppingTaskPreview) {
        const source = (
            await sql<{
                version: number;
                revisionId: string;
            }>`select plan.version::integer version,revision.id as "revisionId"
                 from meal.meal_plans plan
                 join meal.data_scopes scope on scope.id=plan.scope_id
                 join meal.plan_revisions revision on revision.plan_id=plan.id and revision.status='active'
                where plan.id=${preview.input.mealPlanId}::uuid
                  and plan.scope_id=${preview.sourceEvidence.scopeId}::uuid
                  and plan.archived_at is null
                  and ((scope.kind='private' and scope.user_id=${userId}::uuid)
                    or (scope.kind='family' and exists(
                        select 1 from meal.family_memberships membership
                         where membership.family_id=scope.family_id and membership.user_id=${userId}::uuid
                           and membership.left_at is null)))
                order by revision.revision desc,revision.id limit 1`.execute(tx)
        ).rows[0];
        if (!source) throw new HttpException('План питания недоступен', 404);
        if (source.version !== preview.input.version || source.revisionId !== preview.sourceEvidence.revisionId)
            throw new ConflictException('План питания изменился; создайте новый предпросмотр');
    }

    private result(preview: ShoppingTaskPreview) {
        return aiV2ShoppingListFromMealPlanResultSchema.parse(preview.result);
    }

    async previewShoppingList(userId: string, raw: unknown) {
        const parsed = z
            .strictObject({
                task: z.literal('shopping_list_generation'),
                mode: z.literal('from_meal_plan'),
                input: aiV2ShoppingListFromMealPlanInputSchema,
            })
            .parse(raw);
        const resolved = await this.mealPlans.aiShoppingPreview(userId, {
            mealPlanId: parsed.input.mealPlanId,
            version: parsed.input.version,
            selection: parsed.input.selection,
        });
        const sourceSnapshotHash = createHash('sha256')
            .update(
                JSON.stringify({
                    scopeId: resolved.scopeId,
                    revisionId: resolved.revisionId,
                    input: resolved.input,
                    preview: resolved.preview,
                }),
            )
            .digest('hex');
        const warningCodes = [
            ...(resolved.preview.priceComplete ? [] : (['price_incomplete'] as const)),
            ...(resolved.preview.items.some((item) => item.needsQuantityCheck)
                ? (['quantity_check_required'] as const)
                : []),
        ];
        const result = aiV2ShoppingListFromMealPlanResultSchema.parse({
            schemaVersion: 'ai-result-contract-v2:shopping_list_generation:from_meal_plan',
            data: {
                mealPlanId: parsed.input.mealPlanId,
                version: parsed.input.version,
                selection: parsed.input.selection,
                preview: resolved.preview,
            },
            warningCodes,
        });
        const previewId = randomUUID();
        const now = new Date();
        const initialEntitlement = await this.entitlements.resolve(userId);
        const prepared = prepareAiV2Preview(parsed, {
            plan: initialEntitlement.plan,
            offeredSources: [],
            readyProviderProfileVersions: new Set(),
            sourceSnapshotHash,
            previewId,
            now,
        });
        const taskSnapshot = shoppingTaskPreviewSchema.parse({
            ...aiV2TaskPreviewSnapshot(prepared),
            requestHash: prepared.frozen.requestHash,
            sourceEvidence: { scopeId: resolved.scopeId, revisionId: resolved.revisionId, sourceSnapshotHash },
            result,
        });

        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const entitlement = await this.entitlements.resolve(userId, tx);
            if (!entitlement.capabilities.smartShopping)
                throw new ForbiddenException('Умное планирование доступно на тарифах Plus и Pro');
            prepareAiV2Preview(parsed, {
                plan: entitlement.plan,
                offeredSources: [],
                readyProviderProfileVersions: new Set(),
                sourceSnapshotHash,
                previewId,
                now,
            });
            await this.assertResolvedSource(tx, userId, taskSnapshot);
            const rules = (
                await sql<{
                    id: string;
                    kind: string;
                    version: number;
                }>`select id,kind,version::integer from meal.ai_rule_versions
                    where (kind,version) in(('cost',4),('context',2),('routing',1),('price',1),('result',2),('safety',1),('cache',1))
                      and effective_at<=now()`.execute(tx)
            ).rows;
            if (rules.length !== 7) throw new ServiceUnavailableException('AI v2 policies are not configured');
            const ruleId = rules.find((rule) => rule.kind === 'cost')?.id;
            if (!ruleId) throw new ServiceUnavailableException('AI task policy is not configured');

            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Список покупок по плану',
                    archived_at: null,
                    user_id: userId,
                    scope_id: resolved.scopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: '',
                    status: 'preview',
                    preview: JSON.parse(JSON.stringify(taskSnapshot)) as never,
                    accepted_at: null,
                    agreement_snapshot: {
                        version: 'ai-backend-v2',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return prepared.preview;
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
            }>`select operation.id,operation.task_id as "taskId",task.task_code task,task.task_mode mode,
                       operation.lifecycle_state state,operation.financial_state as "financialState",
                       operation.provider_cost_state as "providerCostState",operation.result_snapshot result,
                       operation.created_at as "createdAt",operation.updated_at as "updatedAt",
                       operation.expires_at as "expiresAt",operation.version::integer version
                  from meal.ai_operations operation
                  join meal.ai_tasks task on task.id=operation.task_id
                 where operation.id=${operationId}::uuid and operation.user_id=${userId}::uuid
                   and operation.contract_version=2
                   and task.task_code='shopping_list_generation' and task.task_mode='from_meal_plan'`.execute(tx)
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
                await sql<{
                    id: string;
                    requestHash: string;
                }>`select id,request_hash as "requestHash" from meal.ai_operations
                    where user_id=${userId}::uuid and idempotency_key=${input.idempotencyKey} and contract_version=2
                    for update`.execute(tx)
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
                }>`select task.id,task.conversation_id as "conversationId",task.status,task.preview,
                           task.execution_route route,task.task_policy_version as "taskPolicyVersion",
                           task.context_policy_version as "contextPolicyVersion",
                           task.routing_policy_version as "routingPolicyVersion",
                           task.price_policy_version as "pricePolicyVersion",
                           task.result_schema_version as "resultSchemaVersion",
                           task.safety_policy_version as "safetyPolicyVersion",
                           task.cache_policy_version as "cachePolicyVersion",
                           task.source_snapshot_hash as "sourceSnapshotHash"
                      from meal.ai_tasks task join meal.ai_conversations conversation on conversation.id=task.conversation_id
                     where task.id=${input.previewId}::uuid and conversation.user_id=${userId}::uuid
                       and task.contract_version=2 and task.task_code='shopping_list_generation'
                       and task.task_mode='from_meal_plan' for update of task`.execute(tx)
            ).rows[0];
            if (!task) throw new HttpException('AI-предпросмотр не найден', 404);
            if (task.status !== 'preview') throw new ConflictException('AI-предпросмотр уже использован');
            const preview = shoppingTaskPreviewSchema.parse(task.preview);
            if (preview.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            if (preview.sourceEvidence.sourceSnapshotHash !== task.sourceSnapshotHash)
                throw new ConflictException('Источник AI-предпросмотра изменился');
            const entitlement = await this.entitlements.resolve(userId, tx);
            if (!entitlement.capabilities.smartShopping)
                throw new ForbiddenException('Умное планирование доступно на тарифах Plus и Pro');
            await this.assertResolvedSource(tx, userId, preview);

            const operationId = randomUUID();
            const intervalId = randomUUID();
            const userMessageId = randomUUID();
            const assistantMessageId = randomUUID();
            const startedAt = new Date();
            const intervalEndsAt = new Date(startedAt.getTime() + 10 * 60_000);
            const expiresAt = new Date(startedAt.getTime() + 30 * 86_400_000);
            const result = this.result(preview);
            await sql`insert into meal.ai_intervals(id,starts_at,ends_at,clarifications_used,cost,status,task_id)
                      values(${intervalId}::uuid,${startedAt},${intervalEndsAt},0,0,'completed',${task.id}::uuid)`.execute(
                tx,
            );
            await sql`insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id)
                      values(${userMessageId}::uuid,'user','Сформировать список покупок по плану',${input.idempotencyKey},${task.conversationId}::uuid,${intervalId}::uuid),
                            (${assistantMessageId}::uuid,'assistant',${`Список покупок подготовлен: ${result.data.preview.items.length} позиций.`},${assistantMessageId},${task.conversationId}::uuid,${intervalId}::uuid)`.execute(
                tx,
            );
            await sql`insert into meal.ai_operations(
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
                        ${startedAt},${expiresAt})`.execute(tx);
            await sql`update meal.ai_tasks set status='completed',accepted_at=${startedAt},version=version+1
                       where id=${task.id}::uuid and status='preview'`.execute(tx);
            return this.readback(tx, userId, operationId);
        });
    }

    async operation(userId: string, rawOperationId: string) {
        const operationId = z.uuid().parse(rawOperationId);
        return this.database.transaction((tx) => this.readback(tx, userId, operationId));
    }
}
