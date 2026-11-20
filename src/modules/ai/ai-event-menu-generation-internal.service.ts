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
import { aiV2RunRequestSchema, parseAiV2PreviewRequest } from './ai-v2.contracts.js';
import { aiV4ProviderProfiles } from './ai-policy-v4.js';
import { AiService } from './ai.service.js';
import { AiV2EventMenuGenerationExecutor } from './ai-event-menu-generation-executor.js';
import {
    AI_V2_EVENT_MENU_CANDIDATE_LIMIT,
    aiV2EventMenuCandidateSchema,
    aiV2EventMenuShortlistSchema,
    buildEventMenuSlots,
    eventMenuCandidateRole,
    sanitizeEventMenuText,
    type AiV2EventMenuCandidate,
    type AiV2EventMenuShortlist,
} from './ai-event-menu-generation.js';
import { aiV2TaskContractColumns, aiV2TaskPreviewSnapshot, prepareAiV2Preview } from './ai-v2-preview.js';

type Tx = Transaction<DatabaseSchema>;
type Allocation = { bucketId: string; amount: number };

const inputSchema = z.strictObject({
    eventType: z.string().trim().min(1).max(500),
    guests: z.number().int().min(1).max(100),
    constraints: z.string().trim().min(1).max(500).optional(),
});

const snapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('event_menu'),
    task: z.literal('event_menu'),
    mode: z.literal('generate'),
    input: inputSchema,
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
    sourceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
    shortlist: aiV2EventMenuShortlistSchema,
});

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
export class AiV2EventMenuGenerationInternalService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly quota: AiService,
        private readonly executor: AiV2EventMenuGenerationExecutor,
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
        if (!rule || !scope) throw new ServiceUnavailableException('AI event-menu dependencies are not configured');
        return { ruleId: rule.id, scope };
    }

    private async assertAccess(tx: Tx, userId: string) {
        const entitlement = await this.entitlements.resolve(userId, tx);
        if (!entitlement.capabilities.planningRange)
            throw new ForbiddenException('Меню для события доступно на тарифах Plus и Pro');
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
                  from current order by published_at desc,"recipeId" limit 200
            `.execute(tx)
        ).rows;
        const classified = rows.flatMap((row) => {
            const tags = z.array(z.string().trim().min(1).max(80)).max(30).safeParse(row.tags);
            const boundedTags = tags.success ? tags.data.slice(0, 10) : [];
            const role = eventMenuCandidateRole({ title: row.title, category: row.category, tags: boundedTags });
            if (!role) return [];
            const timing = z
                .strictObject({ durationMinutes: z.number().int().nonnegative().max(1_440).nullable().optional() })
                .safeParse(row.timing);
            return [
                {
                    ...row,
                    tags: boundedTags,
                    durationMinutes: timing.success ? (timing.data.durationMinutes ?? null) : null,
                    roles: [role],
                },
            ];
        });
        const selected = (['starter', 'salad', 'main', 'dessert'] as const).flatMap((role) =>
            classified.filter((candidate) => candidate.roles.includes(role)).slice(0, 10),
        );
        return selected
            .slice(0, AI_V2_EVENT_MENU_CANDIDATE_LIMIT)
            .map((candidate, index) => aiV2EventMenuCandidateSchema.parse({ ...candidate, key: index + 1 }));
    }

    private assertCoverage(candidates: AiV2EventMenuCandidate[]) {
        for (const role of ['starter', 'salad', 'main', 'dessert'] as const)
            if (candidates.filter((candidate) => candidate.roles.includes(role)).length < 2)
                throw new ConflictException('Недостаточно опубликованных рецептов для одного из разделов меню');
    }

    private async assertShortlistCurrent(tx: Tx, userId: string, shortlist: AiV2EventMenuShortlist) {
        const dependencies = await this.dependencies(tx, userId);
        if (dependencies.scope.id !== shortlist.scopeId || dependencies.scope.version !== shortlist.scopeVersion)
            throw new ConflictException('Личная область меню изменилась');
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
                throw new ConflictException('Рецепт из меню изменился');
        }
    }

    async previewGenerate(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'event_menu' || request.mode !== 'generate')
            throw new ConflictException('Internal event-menu generation task expected');
        const parsed = inputSchema.parse(request.input);
        let eventType: string;
        let constraints: string | null;
        try {
            eventType = sanitizeEventMenuText(parsed.eventType) ?? '';
            constraints = sanitizeEventMenuText(parsed.constraints);
        } catch {
            throw new ConflictException('Параметры события содержат неподдерживаемые ограничения');
        }
        if ((await this.quota.balance(userId)).available < 3) throw new ConflictException('Недостаточно AI-действий');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const entitlement = await this.assertAccess(tx, userId);
            const dependency = await this.dependencies(tx, userId);
            const candidates = await this.candidates(tx);
            this.assertCoverage(candidates);
            const shortlist = aiV2EventMenuShortlistSchema.parse({
                id: randomUUID(),
                scopeId: dependency.scope.id,
                scopeVersion: dependency.scope.version,
                eventType,
                guests: parsed.guests,
                constraints,
                slots: buildEventMenuSlots(Array.from({ length: 4 }, () => randomUUID())),
                candidates,
            });
            const input = { eventType, guests: parsed.guests, ...(constraints ? { constraints } : {}) };
            const previewId = randomUUID();
            const sourceSnapshotHash = createHash('sha256').update(JSON.stringify(shortlist)).digest('hex');
            const prepared = prepareAiV2Preview(
                { task: 'event_menu', mode: 'generate', input },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set([aiV4ProviderProfiles.balanced.version]),
                    sourceSnapshotHash,
                    previewId,
                },
            );
            const snapshot = snapshotSchema.parse({
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
                    title: `Меню: ${eventType}`,
                    archived_at: null,
                    user_id: userId,
                    scope_id: dependency.scope.id,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: eventType,
                    status: 'preview',
                    preview: sql`${JSON.stringify(snapshot)}::jsonb`,
                    accepted_at: null,
                    agreement_snapshot: {
                        version: 'ai-v2-internal-event-menu-simulator',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: dependency.ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return { kind: 'preview' as const, eventMenuId: shortlist.id, preview: prepared.preview };
        });
    }

    private async taskForRun(tx: Tx, userId: string, previewId: string) {
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
                   and task.contract_version=2 and task.task_code='event_menu'
                   and task.task_mode='generate' and task.status='preview' for update of task
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

    private async reserve(userId: string, raw: unknown) {
        const run = aiV2RunRequestSchema.parse(raw);
        await this.quota.balance(userId);
        const requestHash = createHash('sha256')
            .update(JSON.stringify({ contractVersion: 2, previewId: run.previewId }))
            .digest('hex');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            await this.assertAccess(tx, userId);
            const existing = await this.existingOperation(tx, userId, run.idempotencyKey, requestHash);
            if (existing) return { replayed: true as const, operationId: existing.operationId };
            const task = await this.taskForRun(tx, userId, run.previewId);
            const snapshot = snapshotSchema.parse(task.preview);
            if (snapshot.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            await this.assertShortlistCurrent(tx, userId, snapshot.shortlist);
            const allocations = await this.reserveBuckets(tx, userId, 3);
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
                    cost: 3,
                    status: 'processing',
                    task_id: task.id,
                })
                .execute();
            await tx
                .insertInto('ai_messages')
                .values({
                    id: messageId,
                    role: 'user',
                    body: snapshot.shortlist.constraints
                        ? `${snapshot.shortlist.eventType}: ${snapshot.shortlist.constraints}`
                        : snapshot.shortlist.eventType,
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
                    provider_cost_currency,updated_at,expires_at
                ) values(
                    ${operationId}::uuid,'processing',${JSON.stringify({ allocations, charged: true, continuation: false })}::jsonb,
                    ${now},null,null,${run.idempotencyKey},${intervalId}::uuid,${messageId}::uuid,
                    ${userId}::uuid,${task.id}::uuid,2,'initial',${requestHash},'queued','reserved',${now},${now},
                    'simulator-balanced-v1',${task.taskPolicyVersion},${task.contextPolicyVersion},
                    ${task.providerProfileVersion},${task.route},${task.routingPolicyVersion},${task.pricePolicyVersion},
                    ${task.resultSchemaVersion},${task.safetyPolicyVersion},${task.cachePolicyVersion},'none','RUB',${now},
                    ${new Date(now.getTime() + 30 * 86_400_000)}
                )
            `.execute(tx);
            for (const allocation of allocations) {
                await sql`
                    insert into meal.ai_ledger(
                        id,kind,delta,reserved_delta,recorded_at,idempotency_key,bucket_id,operation_id,compensates_id
                    ) values(
                        ${randomUUID()}::uuid,'reserve',0,${allocation.amount},${now},
                        ${`${operationId}:reserve:${allocation.bucketId}`},${allocation.bucketId}::uuid,
                        ${operationId}::uuid,null
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
                    ${operationId}::uuid,${clientRequestId}::uuid,${task.providerProfileVersion},
                    'simulator-balanced-v1','prepared',7.00000000,${now},${now}
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
                clock: now,
                shortlist: snapshot.shortlist,
            };
        });
    }

    async runGenerateSimulator(userId: string, raw: unknown) {
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
        return { operationId: reserved.operationId, replayed: false as const };
    }
}
