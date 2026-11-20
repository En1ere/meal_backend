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
import {
    aiV2MealPlanGenerationResultSchema,
    aiV2MealPlanReplaceSlotResultSchema,
    aiV2RunRequestSchema,
    parseAiV2PreviewRequest,
    type AiV2MealPlanSlot,
} from './ai-v2.contracts.js';
import { aiV4ProviderProfiles } from './ai-policy-v4.js';
import { AiService } from './ai.service.js';
import { AiV2MealPlanGenerationExecutor } from './ai-meal-plan-generation-executor.js';
import {
    AI_V2_MEAL_PLAN_CANDIDATE_LIMIT,
    AI_V2_MEAL_PLAN_REPEAT_LIMIT,
    aiV2MealPlanCandidateSchema,
    aiV2MealPlanReplaceSnapshotSchema,
    aiV2MealPlanShortlistSchema,
    assertMealPlanMonday,
    buildMealPlanSlots,
    mealPlanCandidateMeals,
    sanitizeMealPlanText,
    type AiV2MealPlanCandidate,
    type AiV2MealPlanShortlist,
} from './ai-meal-plan-generation.js';
import { aiV2TaskContractColumns, aiV2TaskPreviewSnapshot, prepareAiV2Preview } from './ai-v2-preview.js';

type Tx = Transaction<DatabaseSchema>;
type Allocation = { bucketId: string; amount: number };

const generateInputSchema = z.strictObject({
    weekStartsOn: z.iso.date(),
    people: z.number().int().min(1).max(20),
    goal: z.string().trim().min(1).max(500).optional(),
});

const replaceInputSchema = z.strictObject({
    mealPlanId: z.uuid(),
    slotId: z.uuid(),
    reason: z.string().trim().min(1).max(500).optional(),
});

const generateSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('meal_plan_generation'),
    task: z.literal('meal_plan_generation'),
    mode: z.literal('generate'),
    input: generateInputSchema,
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
    sourceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
    shortlist: aiV2MealPlanShortlistSchema,
});

const replaceTaskSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('meal_plan_generation'),
    task: z.literal('meal_plan_generation'),
    mode: z.literal('replace_slot'),
    input: replaceInputSchema,
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
    replacement: aiV2MealPlanReplaceSnapshotSchema,
});

type GenerateSnapshot = z.infer<typeof generateSnapshotSchema>;

type ResolvedPlanArtifact = {
    task: { id: string; conversationId: string; preview: unknown };
    source: GenerateSnapshot;
    interval: { id: string; status: string; endsAt: Date; clarificationsUsed: number };
    slots: AiV2MealPlanSlot[];
    snapshotVersion: number;
};

type TaskRow = {
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
};

@Injectable()
export class AiV2MealPlanGenerationInternalService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly quota: AiService,
        private readonly executor: AiV2MealPlanGenerationExecutor,
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
            await sql<{ id: string; version: number }>`
                select id,version::integer from meal.data_scopes
                 where kind='private' and user_id=${userId}::uuid limit 1
            `.execute(tx)
        ).rows[0];
        if (!rule || !scope) throw new ServiceUnavailableException('AI meal-plan dependencies are not configured');
        return { ruleId: rule.id, scope };
    }

    private async assertPlanAccess(tx: Tx, userId: string) {
        const entitlement = await this.entitlements.resolve(userId, tx);
        if (!entitlement.capabilities.planningRange)
            throw new ForbiddenException('Генерация рациона доступна на тарифах Plus и Pro');
        return entitlement;
    }

    private async candidates(tx: Tx) {
        const rows = (
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
                timing: unknown;
            }>`
                with current as (
                    select distinct on(recipe.id)
                           recipe.id "recipeId",recipe.version::integer "recipeVersion",
                           revision.id "revisionId",revision.version::integer "revisionVersion",
                           publication.id "publicationId",publication.version::integer "publicationVersion",
                           revision.title,revision.category,revision.tags,revision.timing,publication.published_at
                      from meal.recipes recipe
                      join meal.recipe_revisions revision on revision.recipe_id=recipe.id
                      join meal.recipe_publications publication on publication.revision_id=revision.id
                     where publication.unpublished_at is null and publication.published_at<=now()
                       and recipe.archived_at is null
                       and recipe.status not in('hidden','unpublished','deleted','archived')
                     order by recipe.id,publication.published_at desc,publication.id desc
                )
                select "recipeId","recipeVersion","revisionId","revisionVersion","publicationId",
                       "publicationVersion",title,category,tags,timing
                  from current order by published_at desc,"recipeId" limit ${AI_V2_MEAL_PLAN_CANDIDATE_LIMIT}
            `.execute(tx)
        ).rows;
        return rows.map((row, index) => {
            const tags = z.array(z.string().trim().min(1).max(80)).max(30).safeParse(row.tags);
            const boundedTags = tags.success ? tags.data.slice(0, 10) : [];
            const timing = z
                .strictObject({ durationMinutes: z.number().int().nonnegative().max(1_440).nullable().optional() })
                .safeParse(row.timing);
            return aiV2MealPlanCandidateSchema.parse({
                ...row,
                key: index + 1,
                tags: boundedTags,
                durationMinutes: timing.success ? (timing.data.durationMinutes ?? null) : null,
                meals: mealPlanCandidateMeals({ title: row.title, category: row.category, tags: boundedTags }),
            });
        });
    }

    private assertCandidateCoverage(candidates: AiV2MealPlanCandidate[]) {
        if (candidates.length < 11) throw new ConflictException('Недостаточно опубликованных рецептов для рациона');
        for (const meal of ['breakfast', 'lunch', 'dinner'] as const)
            if (candidates.filter((candidate) => candidate.meals.includes(meal)).length < 4)
                throw new ConflictException('Недостаточно рецептов для одного из приёмов пищи');
    }

    private async assertShortlistCurrent(tx: Tx, userId: string, shortlist: AiV2MealPlanShortlist) {
        const dependencies = await this.dependencies(tx, userId);
        if (dependencies.scope.id !== shortlist.scopeId || dependencies.scope.version !== shortlist.scopeVersion)
            throw new ConflictException('Личная область планирования изменилась');
        const current = (
            await sql<{
                recipeId: string;
                recipeVersion: number;
                revisionId: string;
                revisionVersion: number;
                publicationId: string;
                publicationVersion: number;
            }>`
                select recipe.id "recipeId",recipe.version::integer "recipeVersion",
                       revision.id "revisionId",revision.version::integer "revisionVersion",
                       publication.id "publicationId",publication.version::integer "publicationVersion"
                  from meal.recipes recipe
                  join meal.recipe_revisions revision on revision.recipe_id=recipe.id
                  join meal.recipe_publications publication on publication.revision_id=revision.id
                 where recipe.id=any(${shortlist.candidates.map((candidate) => candidate.recipeId)}::uuid[])
                   and publication.unpublished_at is null and publication.published_at<=now()
                   and recipe.archived_at is null
                   and recipe.status not in('hidden','unpublished','deleted','archived')
            `.execute(tx)
        ).rows;
        for (const candidate of shortlist.candidates) {
            const row = current.find(
                (item) => item.recipeId === candidate.recipeId && item.publicationId === candidate.publicationId,
            );
            if (
                !row ||
                row.recipeVersion !== candidate.recipeVersion ||
                row.revisionId !== candidate.revisionId ||
                row.revisionVersion !== candidate.revisionVersion ||
                row.publicationVersion !== candidate.publicationVersion
            )
                throw new ConflictException('Рецепт из рациона изменился');
        }
    }

    async previewGenerate(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'meal_plan_generation' || request.mode !== 'generate')
            throw new ConflictException('Internal meal-plan generation task expected');
        const parsed = generateInputSchema.parse(request.input);
        try {
            assertMealPlanMonday(parsed.weekStartsOn);
        } catch {
            throw new ConflictException('Неделя должна начинаться в понедельник');
        }
        let goal: string | null;
        try {
            goal = sanitizeMealPlanText(parsed.goal);
        } catch {
            throw new ConflictException('Цель содержит неподдерживаемые инструкции или медицинские ограничения');
        }
        if ((await this.quota.balance(userId)).available < 4) throw new ConflictException('Недостаточно AI-действий');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const entitlement = await this.assertPlanAccess(tx, userId);
            const dependency = await this.dependencies(tx, userId);
            const candidates = await this.candidates(tx);
            this.assertCandidateCoverage(candidates);
            const shortlist = aiV2MealPlanShortlistSchema.parse({
                id: randomUUID(),
                scopeId: dependency.scope.id,
                scopeVersion: dependency.scope.version,
                weekStartsOn: parsed.weekStartsOn,
                people: parsed.people,
                goal,
                slots: buildMealPlanSlots(
                    parsed.weekStartsOn,
                    Array.from({ length: 21 }, () => randomUUID()),
                ),
                candidates,
            });
            const input = { weekStartsOn: parsed.weekStartsOn, people: parsed.people, ...(goal ? { goal } : {}) };
            const previewId = randomUUID();
            const sourceSnapshotHash = createHash('sha256').update(JSON.stringify(shortlist)).digest('hex');
            const prepared = prepareAiV2Preview(
                { task: 'meal_plan_generation', mode: 'generate', input },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set([aiV4ProviderProfiles.balanced.version]),
                    sourceSnapshotHash,
                    previewId,
                },
            );
            const snapshot = generateSnapshotSchema.parse({
                ...aiV2TaskPreviewSnapshot(prepared),
                requestHash: prepared.frozen.requestHash,
                sourceSnapshotHash,
                shortlist,
            });
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Рацион на неделю',
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.scope.id,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: goal ?? 'Рацион на неделю',
                    status: 'preview',
                    preview: sql`${JSON.stringify(snapshot)}::jsonb`,
                    accepted_at: null,
                    agreement_snapshot: {
                        version: 'ai-v2-internal-meal-plan-simulator',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: dependency.ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return { kind: 'preview' as const, mealPlanId: shortlist.id, preview: prepared.preview };
        });
    }

    private async resolvePlanArtifact(tx: Tx, userId: string, mealPlanId: string): Promise<ResolvedPlanArtifact> {
        const task = (
            await sql<{ id: string; conversationId: string; preview: unknown }>`
                select task.id,task.conversation_id "conversationId",task.preview
                  from meal.ai_tasks task join meal.ai_conversations conversation on conversation.id=task.conversation_id
                 where conversation.user_id=${userId}::uuid and task.contract_version=2
                   and task.task_code='meal_plan_generation' and task.task_mode='generate'
                   and task.status='completed' and task.preview->'shortlist'->>'id'=${mealPlanId}
                 order by task.created_at desc limit 1 for update of task
            `.execute(tx)
        ).rows[0];
        if (!task) throw new ConflictException('Предпросмотр рациона недоступен');
        const source = generateSnapshotSchema.parse(task.preview);
        await this.assertShortlistCurrent(tx, userId, source.shortlist);
        const generated = (
            await sql<{ result: unknown; intervalId: string }>`
                select operation.result_snapshot result,operation.interval_id "intervalId"
                  from meal.ai_operations operation
                 where operation.task_id=${task.id}::uuid and operation.contract_version=2
                   and operation.lifecycle_state='succeeded'
                 order by operation.created_at desc limit 1
            `.execute(tx)
        ).rows[0];
        if (!generated) throw new ConflictException('Генерация рациона не завершена');
        const initial = aiV2MealPlanGenerationResultSchema.parse(generated.result);
        const replacements = (
            await sql<{ result: unknown }>`
                select operation.result_snapshot result
                  from meal.ai_operations operation
                  join meal.ai_tasks replacement on replacement.id=operation.task_id
                 where replacement.conversation_id=${task.conversationId}::uuid
                   and replacement.task_code='meal_plan_generation' and replacement.task_mode='replace_slot'
                   and operation.contract_version=2 and operation.lifecycle_state='succeeded'
                 order by operation.created_at,operation.id limit 2
            `.execute(tx)
        ).rows.map((row) => aiV2MealPlanReplaceSlotResultSchema.parse(row.result));
        const slots = initial.slots.map((slot) => ({ ...slot }));
        let snapshotVersion = 1;
        for (const replacement of replacements) {
            if (replacement.mealPlanId !== mealPlanId || replacement.snapshotVersion !== snapshotVersion + 1)
                throw new ConflictException('История замен рациона повреждена');
            const index = slots.findIndex((slot) => slot.slotId === replacement.slot.slotId);
            if (index < 0) throw new ConflictException('Слот рациона недоступен');
            slots[index] = replacement.slot;
            snapshotVersion = replacement.snapshotVersion;
        }
        const interval = (
            await sql<{
                id: string;
                status: string;
                endsAt: Date;
                clarificationsUsed: number;
            }>`
                select id,status,ends_at "endsAt",clarifications_used::integer "clarificationsUsed"
                  from meal.ai_intervals where id=${generated.intervalId}::uuid for update
            `.execute(tx)
        ).rows[0];
        if (!interval) throw new ConflictException('Интервал генерации недоступен');
        return { task, source, interval, slots, snapshotVersion };
    }

    private replacementSnapshot(
        artifact: ResolvedPlanArtifact,
        input: z.infer<typeof replaceInputSchema>,
        reason: string | null,
    ) {
        const slot = artifact.slots.find((candidate) => candidate.slotId === input.slotId);
        if (!slot) throw new ConflictException('Слот рациона недоступен');
        const usage = new Map<string, number>();
        for (const item of artifact.slots) usage.set(item.recipeId, (usage.get(item.recipeId) ?? 0) + 1);
        const alternatives = artifact.source.shortlist.candidates
            .filter(
                (candidate) =>
                    candidate.recipeId !== slot.recipeId &&
                    candidate.meals.includes(slot.meal) &&
                    (usage.get(candidate.recipeId) ?? 0) < AI_V2_MEAL_PLAN_REPEAT_LIMIT,
            )
            .slice(0, 10);
        if (!alternatives.length) throw new ConflictException('Нет доступной замены для слота');
        const sourceSnapshotHash = createHash('sha256')
            .update(
                JSON.stringify({
                    mealPlanId: input.mealPlanId,
                    snapshotVersion: artifact.snapshotVersion,
                    slot,
                    alternatives,
                    parentSource: artifact.source.sourceSnapshotHash,
                }),
            )
            .digest('hex');
        return aiV2MealPlanReplaceSnapshotSchema.parse({
            mealPlanId: input.mealPlanId,
            snapshotVersion: artifact.snapshotVersion,
            parentTaskId: artifact.task.id,
            parentIntervalId: artifact.interval.id,
            slot,
            reason,
            alternatives,
            sourceSnapshotHash,
        });
    }

    async previewReplaceSlot(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'meal_plan_generation' || request.mode !== 'replace_slot')
            throw new ConflictException('Internal meal-plan replacement task expected');
        const input = replaceInputSchema.parse(request.input);
        let reason: string | null;
        try {
            reason = sanitizeMealPlanText(input.reason);
        } catch {
            throw new ConflictException('Причина замены содержит неподдерживаемые инструкции');
        }
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const entitlement = await this.assertPlanAccess(tx, userId);
            const artifact = await this.resolvePlanArtifact(tx, userId, input.mealPlanId);
            if (
                artifact.interval.status !== 'completed' ||
                artifact.interval.endsAt <= new Date() ||
                artifact.interval.clarificationsUsed >= 2
            )
                throw new ConflictException('Бесплатные замены этого интервала недоступны');
            const replacement = this.replacementSnapshot(artifact, input, reason);
            const normalizedInput = {
                mealPlanId: input.mealPlanId,
                slotId: input.slotId,
                ...(reason ? { reason } : {}),
            };
            const previewId = randomUUID();
            const prepared = prepareAiV2Preview(
                { task: 'meal_plan_generation', mode: 'replace_slot', input: normalizedInput },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set([aiV4ProviderProfiles.balanced.version]),
                    sourceSnapshotHash: replacement.sourceSnapshotHash,
                    previewId,
                },
            );
            const snapshot = replaceTaskSnapshotSchema.parse({
                ...aiV2TaskPreviewSnapshot(prepared),
                requestHash: prepared.frozen.requestHash,
                replacement,
            });
            const ruleId = await this.dependencies(tx, userId).then((item) => item.ruleId);
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: reason ?? 'Заменить слот рациона',
                    status: 'preview',
                    preview: sql`${JSON.stringify(snapshot)}::jsonb`,
                    accepted_at: null,
                    agreement_snapshot: {
                        version: 'ai-v2-internal-meal-plan-clarification',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: artifact.task.conversationId,
                    rule_id: ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return { kind: 'preview' as const, preview: prepared.preview };
        });
    }

    private async taskForRun(tx: Tx, userId: string, previewId: string, mode: 'generate' | 'replace_slot') {
        const task = (
            await sql<TaskRow>`
                select task.id,task.conversation_id "conversationId",task.preview,
                       task.execution_route route,task.task_policy_version "taskPolicyVersion",
                       task.context_policy_version "contextPolicyVersion",
                       task.routing_policy_version "routingPolicyVersion",
                       task.price_policy_version "pricePolicyVersion",task.result_schema_version "resultSchemaVersion",
                       task.safety_policy_version "safetyPolicyVersion",task.cache_policy_version "cachePolicyVersion",
                       task.provider_profile_version "providerProfileVersion"
                  from meal.ai_tasks task join meal.ai_conversations conversation on conversation.id=task.conversation_id
                 where task.id=${previewId}::uuid and conversation.user_id=${userId}::uuid
                   and task.contract_version=2 and task.task_code='meal_plan_generation'
                   and task.task_mode=${mode} and task.status='preview' for update of task
            `.execute(tx)
        ).rows[0];
        if (!task) throw new ConflictException('AI-предпросмотр недоступен');
        return task;
    }

    private async existingOperation(tx: Tx, userId: string, idempotencyKey: string, requestHash: string) {
        const existing = (
            await sql<{ operationId: string; requestHash: string }>`
                select id "operationId",request_hash "requestHash" from meal.ai_operations
                 where user_id=${userId}::uuid and idempotency_key=${idempotencyKey} and contract_version=2
                 for update
            `.execute(tx)
        ).rows[0];
        if (existing && existing.requestHash !== requestHash)
            throw new ConflictException('Ключ идемпотентности использован с другим запросом');
        return existing;
    }

    private async reserveBuckets(tx: Tx, userId: string, amount: number) {
        const buckets = (
            await sql<{ id: string; available: number }>`
                select id,(balance_projection-reserved_projection)::integer available
                  from meal.ai_buckets
                 where user_id=${userId}::uuid and kind<>'family_reserve'
                   and balance_projection-reserved_projection>0 and (expires_at is null or expires_at>now())
                 order by case kind when 'subscription' then 1 when 'transferred' then 2
                                    when 'trial' then 3 when 'purchased' then 4 else 5 end,
                          expires_at nulls last,created_at,id for update
            `.execute(tx)
        ).rows;
        let remaining = amount;
        const allocations: Allocation[] = [];
        for (const bucket of buckets) {
            const allocated = Math.min(remaining, bucket.available);
            if (allocated > 0) allocations.push({ bucketId: bucket.id, amount: allocated });
            remaining -= allocated;
            if (!remaining) break;
        }
        if (remaining) throw new ConflictException('Недостаточно AI-действий');
        return allocations;
    }

    private async persistOperation(
        tx: Tx,
        input: {
            userId: string;
            run: z.infer<typeof aiV2RunRequestSchema>;
            requestHash: string;
            task: TaskRow;
            intervalId: string;
            allocations: Allocation[];
            commandKind: 'initial' | 'continuation';
            message: string;
            providerCostRub: '9.50000000' | '1.25000000';
        },
    ) {
        const operationId = randomUUID();
        const messageId = randomUUID();
        const clientRequestId = randomUUID();
        const now = new Date();
        const charged = input.allocations.length > 0;
        await tx
            .insertInto('ai_messages')
            .values({
                id: messageId,
                role: 'user',
                body: input.message,
                client_message_key: input.run.idempotencyKey,
                conversation_id: input.task.conversationId,
                interval_id: input.intervalId,
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
                ${operationId}::uuid,'processing',${JSON.stringify({ allocations: input.allocations, charged, continuation: input.commandKind === 'continuation' })}::jsonb,
                ${now},null,null,${input.run.idempotencyKey},${input.intervalId}::uuid,${messageId}::uuid,
                ${input.userId}::uuid,${input.task.id}::uuid,2,${input.commandKind},${input.requestHash},'queued',
                ${charged ? 'reserved' : 'none'},${now},${now},'simulator-balanced-v1',${input.task.taskPolicyVersion},
                ${input.task.contextPolicyVersion},${input.task.providerProfileVersion},${input.task.route},
                ${input.task.routingPolicyVersion},${input.task.pricePolicyVersion},${input.task.resultSchemaVersion},
                ${input.task.safetyPolicyVersion},${input.task.cachePolicyVersion},'none','RUB',${now},
                ${new Date(now.getTime() + 30 * 86_400_000)}
            )
        `.execute(tx);
        for (const allocation of input.allocations) {
            await sql`
                insert into meal.ai_ledger(
                    id,kind,delta,reserved_delta,recorded_at,idempotency_key,bucket_id,operation_id,compensates_id
                ) values(
                    ${randomUUID()}::uuid,'reserve',0,${allocation.amount},${now},
                    ${`${operationId}:reserve:${allocation.bucketId}`},${allocation.bucketId}::uuid,${operationId}::uuid,null
                )
            `.execute(tx);
            const updated = await sql`
                update meal.ai_buckets set reserved_projection=reserved_projection+${allocation.amount},version=version+1
                 where id=${allocation.bucketId}::uuid
                   and balance_projection-reserved_projection>=${allocation.amount}
            `.execute(tx);
            if (!updated.numAffectedRows) throw new ConflictException('AI-баланс изменился');
        }
        await sql`
            insert into meal.ai_provider_dispatches(
                operation_id,client_request_id,profile_version,requested_model,state,
                estimated_cost_rub,created_at,updated_at
            ) values(
                ${operationId}::uuid,${clientRequestId}::uuid,${input.task.providerProfileVersion},
                'simulator-balanced-v1','prepared',${input.providerCostRub}::numeric,${now},${now}
            )
        `.execute(tx);
        await sql`
            update meal.ai_tasks set status='processing',accepted_at=${now},version=version+1
             where id=${input.task.id}::uuid and status='preview'
        `.execute(tx);
        return { operationId, clientRequestId, clock: now };
    }

    private async reserveGenerate(userId: string, raw: unknown) {
        const run = aiV2RunRequestSchema.parse(raw);
        await this.quota.balance(userId);
        const requestHash = createHash('sha256')
            .update(JSON.stringify({ contractVersion: 2, previewId: run.previewId }))
            .digest('hex');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            await this.assertPlanAccess(tx, userId);
            const existing = await this.existingOperation(tx, userId, run.idempotencyKey, requestHash);
            if (existing) return { replayed: true as const, operationId: existing.operationId };
            const task = await this.taskForRun(tx, userId, run.previewId, 'generate');
            const snapshot = generateSnapshotSchema.parse(task.preview);
            if (snapshot.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            await this.assertShortlistCurrent(tx, userId, snapshot.shortlist);
            const allocations = await this.reserveBuckets(tx, userId, 4);
            const intervalId = randomUUID();
            const now = new Date();
            await tx
                .insertInto('ai_intervals')
                .values({
                    id: intervalId,
                    starts_at: now,
                    ends_at: new Date(now.getTime() + 10 * 60_000),
                    clarifications_used: 0,
                    cost: 4,
                    status: 'processing',
                    task_id: task.id,
                })
                .execute();
            const operation = await this.persistOperation(tx, {
                userId,
                run,
                requestHash,
                task,
                intervalId,
                allocations,
                commandKind: 'initial',
                message: snapshot.shortlist.goal ?? 'Сформировать рацион на неделю',
                providerCostRub: '9.50000000',
            });
            return { replayed: false as const, ...operation, shortlist: snapshot.shortlist };
        });
    }

    private async reserveReplace(userId: string, raw: unknown) {
        const run = aiV2RunRequestSchema.parse(raw);
        const requestHash = createHash('sha256')
            .update(JSON.stringify({ contractVersion: 2, previewId: run.previewId }))
            .digest('hex');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            await this.assertPlanAccess(tx, userId);
            const existing = await this.existingOperation(tx, userId, run.idempotencyKey, requestHash);
            if (existing) return { replayed: true as const, operationId: existing.operationId };
            const task = await this.taskForRun(tx, userId, run.previewId, 'replace_slot');
            const snapshot = replaceTaskSnapshotSchema.parse(task.preview);
            if (snapshot.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            const artifact = await this.resolvePlanArtifact(tx, userId, snapshot.input.mealPlanId);
            const current = this.replacementSnapshot(artifact, snapshot.input, snapshot.replacement.reason);
            if (current.sourceSnapshotHash !== snapshot.replacement.sourceSnapshotHash)
                throw new ConflictException('Рацион или подборка замен изменились');
            const claimed = await sql`
                update meal.ai_intervals
                   set clarifications_used=clarifications_used+1,status='processing',version=version+1
                 where id=${snapshot.replacement.parentIntervalId}::uuid and status='completed'
                   and ends_at>now() and clarifications_used<2
            `.execute(tx);
            if (!claimed.numAffectedRows) throw new ConflictException('Бесплатные замены этого интервала недоступны');
            const operation = await this.persistOperation(tx, {
                userId,
                run,
                requestHash,
                task,
                intervalId: snapshot.replacement.parentIntervalId,
                allocations: [],
                commandKind: 'continuation',
                message: snapshot.replacement.reason ?? 'Заменить слот рациона',
                providerCostRub: '1.25000000',
            });
            return { replayed: false as const, ...operation, snapshot: current };
        });
    }

    async runGenerateSimulator(userId: string, raw: unknown) {
        const reserved = await this.reserveGenerate(userId, raw);
        if (reserved.replayed) return { operationId: reserved.operationId, replayed: true as const };
        const submitted = await this.executor.submit({
            operationId: reserved.operationId,
            dispatchVersion: 1,
            clientRequestId: reserved.clientRequestId,
            source: { mode: 'generate', shortlist: reserved.shortlist },
            clock: new Date(reserved.clock.getTime() + 1),
        });
        if (submitted?.outcome.kind === 'accepted')
            await this.executor.read({
                operationId: reserved.operationId,
                dispatchVersion: submitted.nextVersion,
                source: { mode: 'generate', shortlist: reserved.shortlist },
                clock: new Date(reserved.clock.getTime() + 4),
            });
        return { operationId: reserved.operationId, replayed: false as const };
    }

    async runReplaceSlotSimulator(userId: string, raw: unknown) {
        const reserved = await this.reserveReplace(userId, raw);
        if (reserved.replayed) return { operationId: reserved.operationId, replayed: true as const };
        const submitted = await this.executor.submit({
            operationId: reserved.operationId,
            dispatchVersion: 1,
            clientRequestId: reserved.clientRequestId,
            source: { mode: 'replace_slot', snapshot: reserved.snapshot },
            clock: new Date(reserved.clock.getTime() + 1),
        });
        if (submitted?.outcome.kind === 'accepted')
            await this.executor.read({
                operationId: reserved.operationId,
                dispatchVersion: submitted.nextVersion,
                source: { mode: 'replace_slot', snapshot: reserved.snapshot },
                clock: new Date(reserved.clock.getTime() + 4),
            });
        return { operationId: reserved.operationId, replayed: false as const };
    }
}
