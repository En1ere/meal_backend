import { ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/public.js';
import { aiV4ProviderProfiles } from './ai-policy-v4.js';
import {
    aiV2ReviewSummarySnapshotSchema,
    deterministicReviewSummarySample,
    parseReviewSummarySourceRelease,
    reviewSummaryWarningCodes,
    reviewSummaryWithoutModel,
    sanitizePublicReviewExcerpt,
    type AiV2ReviewSummarySnapshot,
} from './ai-review-summary.js';
import { AiV2ReviewSummaryExecutor } from './ai-review-summary-executor.js';
import {
    aiV2ReviewSummaryResultSchema,
    aiV2ReviewSummarySourceReleaseSchema,
    aiV2RunRequestSchema,
    parseAiV2PreviewRequest,
    type AiV2ReviewSummaryResult,
} from './ai-v2.contracts.js';
import { aiV2TaskContractColumns, aiV2TaskPreviewSnapshot, prepareAiV2Preview } from './ai-v2-preview.js';

type Tx = Transaction<DatabaseSchema>;

const reviewTaskSnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('review_summary'),
    task: z.literal('review_summary'),
    mode: z.literal('public_summary'),
    input: z.strictObject({ subjectId: z.uuid(), sourceRelease: aiV2ReviewSummarySourceReleaseSchema }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    artifactExpiresAt: z.iso.datetime(),
    snapshot: aiV2ReviewSummarySnapshotSchema,
    result: aiV2ReviewSummaryResultSchema.nullable(),
});

@Injectable()
export class AiV2ReviewSummaryInternalService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly executor: AiV2ReviewSummaryExecutor,
    ) {}

    private async readable(tx: Tx, userId: string) {
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
        if (sanction.rows.length) throw new HttpException('AI-функции временно недоступны', 403);
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
        input: { subjectId: string; sourceRelease: string },
    ): Promise<AiV2ReviewSummarySnapshot> {
        const release = parseReviewSummarySourceRelease(input.sourceRelease);
        const subject = (
            await sql<{
                subjectId: string;
                recipeVersion: number;
                revisionId: string;
                revisionVersion: number;
                publicationId: string;
                publicationVersion: number;
            }>`
                select recipe.id "subjectId",recipe.version::integer "recipeVersion",
                       revision.id "revisionId",revision.version::integer "revisionVersion",
                       publication.id "publicationId",publication.version::integer "publicationVersion"
                  from meal.recipes recipe
                  join meal.recipe_revisions revision on revision.recipe_id=recipe.id
                  join meal.recipe_publications publication
                    on publication.recipe_id=recipe.id and publication.revision_id=revision.id
                  join meal.users author on author.id=recipe.author_id and author.status='active'
                    and author.archived_at is null and author.email_verified_at is not null
                 where recipe.id=${input.subjectId}::uuid and publication.id=${release.publicationId}::uuid
                   and publication.version=${release.publicationVersion}
                   and publication.unpublished_at is null and publication.published_at<=now()
                   and recipe.archived_at is null
                   and recipe.status not in('hidden','unpublished','deleted','archived')
                   and not exists(
                       select 1 from meal.sanctions sanction where sanction.user_id=author.id
                         and sanction.scope='account' and sanction.revoked_at is null and sanction.starts_at<=now()
                         and (sanction.ends_at is null or sanction.ends_at>now())
                   )
                 limit 1
            `.execute(tx)
        ).rows[0];
        if (!subject) throw new ConflictException('Публичная версия рецепта недоступна');

        const ratings = (
            await sql<{ id: string; version: number; value: number }>`
                select id,version::integer,value::integer from meal.recipe_ratings
                 where recipe_id=${input.subjectId}::uuid order by id limit 5001
            `.execute(tx)
        ).rows;
        if (ratings.length > 5_000) throw new ConflictException('Слишком много оценок для безопасной сводки');

        const reviews = (
            await sql<{ id: string; version: number; body: string; createdAt: Date }>`
                select comment.id,comment.version::integer,comment.body,comment.created_at "createdAt"
                  from meal.recipe_comments comment
                  join meal.users author on author.id=comment.author_id and author.status='active'
                    and author.archived_at is null and author.email_verified_at is not null
                 where comment.recipe_id=${input.subjectId}::uuid and comment.removed_at is null
                   and not exists(
                       select 1 from meal.sanctions sanction where sanction.user_id=author.id
                         and sanction.scope='account' and sanction.revoked_at is null and sanction.starts_at<=now()
                         and (sanction.ends_at is null or sanction.ends_at>now())
                   )
                 order by comment.created_at desc,comment.id desc limit 5001
            `.execute(tx)
        ).rows;
        if (reviews.length > 5_000) throw new ConflictException('Слишком много отзывов для безопасной сводки');

        const safeReviews = reviews
            .map((review) => sanitizePublicReviewExcerpt(review.body))
            .filter((review): review is { text: string } => review !== null);
        const excerpts = deterministicReviewSummarySample(safeReviews);
        const ratingTotal = ratings.reduce((total, rating) => total + rating.value, 0);
        const facts = {
            averageRating: ratings.length ? Number((ratingTotal / ratings.length).toFixed(2)) : null,
            ratingCount: ratings.length,
            publicReviewCount: reviews.length,
        };
        const warningCodes = reviewSummaryWarningCodes({
            ratingCount: ratings.length,
            publicReviewCount: reviews.length,
            safeReviewCount: safeReviews.length,
            unsafeReviewCount: reviews.length - safeReviews.length,
            sampled: safeReviews.length > excerpts.length,
        });
        const sourceHash = createHash('sha256')
            .update(
                JSON.stringify({
                    snapshotVersion: 'review-summary-public-source-v1',
                    subject,
                    sourceRelease: release.sourceRelease,
                    ratings,
                    reviews: reviews.map((review) => ({
                        id: review.id,
                        version: review.version,
                        createdAt: review.createdAt,
                        bodyHash: createHash('sha256').update(review.body.normalize('NFKC')).digest('hex'),
                    })),
                }),
            )
            .digest('hex');
        return aiV2ReviewSummarySnapshotSchema.parse({
            subjectId: subject.subjectId,
            sourceRelease: release.sourceRelease,
            publicationId: subject.publicationId,
            publicationVersion: subject.publicationVersion,
            revisionId: subject.revisionId,
            revisionVersion: subject.revisionVersion,
            recipeVersion: subject.recipeVersion,
            sourceHash,
            ratingSourceCount: ratings.length,
            reviewSourceCount: reviews.length,
            facts,
            excerpts,
            warningCodes,
        });
    }

    private async cached(tx: Tx, input: { subjectId: string; sourceRelease: string }, sourceHash: string) {
        const row = (
            await sql<{ preview: unknown }>`
                select task.preview from meal.ai_tasks task
                 where task.contract_version=2 and task.task_code='review_summary'
                   and task.task_mode='public_summary' and task.status='completed'
                   and task.source_snapshot_hash=${sourceHash}
                   and task.preview->'input'->>'subjectId'=${input.subjectId}
                   and task.preview->'input'->>'sourceRelease'=${input.sourceRelease}
                   and (task.preview->>'artifactExpiresAt')::timestamptz>now()
                 order by task.created_at desc limit 1
            `.execute(tx)
        ).rows[0];
        if (!row) return null;
        const cached = reviewTaskSnapshotSchema.parse(row.preview);
        return cached.result ? { artifactExpiresAt: cached.artifactExpiresAt, result: cached.result } : null;
    }

    private async inFlight(tx: Tx, input: { subjectId: string; sourceRelease: string }, sourceHash: string) {
        const row = (
            await sql<{ present: boolean }>`
                select true present from meal.ai_tasks task
                 where task.contract_version=2 and task.task_code='review_summary'
                   and task.task_mode='public_summary'
                   and task.source_snapshot_hash=${sourceHash}
                   and task.preview->'input'->>'subjectId'=${input.subjectId}
                   and task.preview->'input'->>'sourceRelease'=${input.sourceRelease}
                   and (task.status='processing' or (
                       task.status='preview' and (task.preview->>'expiresAt')::timestamptz>now()
                   ))
                 limit 1
            `.execute(tx)
        ).rows[0];
        return Boolean(row?.present);
    }

    private async createTask(
        tx: Tx,
        userId: string,
        prepared: ReturnType<typeof prepareAiV2Preview>,
        snapshot: AiV2ReviewSummarySnapshot,
        result: AiV2ReviewSummaryResult | null,
        now: Date,
    ) {
        const dependency = await this.dependencies(tx, userId);
        const conversationId = randomUUID();
        const artifactExpiresAt = new Date(now.getTime() + 7 * 86_400_000).toISOString();
        const stored = reviewTaskSnapshotSchema.parse({
            ...aiV2TaskPreviewSnapshot(prepared),
            artifactExpiresAt,
            snapshot,
            result,
        });
        await tx
            .insertInto('ai_conversations')
            .values({
                id: conversationId,
                title: 'Публичная сводка отзывов',
                archived_at: null,
                user_id: userId,
                scope_id: dependency.scopeId,
            })
            .execute();
        await tx
            .insertInto('ai_tasks')
            .values({
                id: prepared.preview.id,
                goal: 'Публичная сводка отзывов',
                status: result ? 'completed' : 'preview',
                preview: sql`${JSON.stringify(stored)}::jsonb`,
                accepted_at: result ? now : null,
                agreement_snapshot: {
                    version: result ? 'ai-v2-backend-public-review-summary' : 'ai-v2-internal-simulator',
                    externalProviderUsed: false,
                    consentEvidence: [],
                },
                conversation_id: conversationId,
                rule_id: dependency.ruleId,
                ...aiV2TaskContractColumns(prepared.frozen),
            })
            .execute();
        return { artifactExpiresAt, stored };
    }

    async previewPublicSummary(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'review_summary' || request.mode !== 'public_summary')
            throw new ConflictException('Internal public review summary task expected');
        const input = z
            .strictObject({ subjectId: z.uuid(), sourceRelease: aiV2ReviewSummarySourceReleaseSchema })
            .parse(request.input);
        return this.database.transaction(async (tx) => {
            await this.readable(tx, userId);
            await sql`select pg_advisory_xact_lock(hashtextextended(${`review-summary:${input.subjectId}:${input.sourceRelease}`},0))`.execute(
                tx,
            );
            const snapshot = await this.buildSnapshot(tx, input);
            const cached = await this.cached(tx, input, snapshot.sourceHash);
            if (cached)
                return {
                    kind: 'artifact' as const,
                    cacheHit: true as const,
                    artifactExpiresAt: cached.artifactExpiresAt,
                    result: cached.result,
                };
            if (await this.inFlight(tx, input, snapshot.sourceHash))
                return { kind: 'pending' as const, retryAfterSeconds: 5 as const };

            const entitlement = await this.entitlements.resolve(userId, tx);
            const now = new Date();
            const previewId = randomUUID();
            const prepared = prepareAiV2Preview(
                { task: 'review_summary', mode: 'public_summary', input },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set([aiV4ProviderProfiles.economy.version]),
                    sourceSnapshotHash: snapshot.sourceHash,
                    now,
                    previewId,
                },
            );
            const useModel = snapshot.excerpts.length >= 3;
            const result = useModel ? null : reviewSummaryWithoutModel(snapshot);
            const created = await this.createTask(tx, userId, prepared, snapshot, result, now);
            if (result)
                return {
                    kind: 'artifact' as const,
                    cacheHit: false as const,
                    artifactExpiresAt: created.artifactExpiresAt,
                    result,
                };
            return { kind: 'preview' as const, preview: prepared.preview };
        });
    }

    private async reserve(userId: string, raw: unknown) {
        const input = aiV2RunRequestSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.readable(tx, userId);
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
                       and task.contract_version=2 and task.task_code='review_summary'
                       and task.task_mode='public_summary' and task.status='preview' for update of task
                `.execute(tx)
            ).rows[0];
            if (!task) throw new ConflictException('AI-предпросмотр недоступен');
            const preview = reviewTaskSnapshotSchema.parse(task.preview);
            if (preview.expiresAt <= new Date().toISOString()) throw new ConflictException('AI-предпросмотр устарел');
            const current = await this.buildSnapshot(tx, preview.input);
            if (JSON.stringify(current) !== JSON.stringify(preview.snapshot))
                throw new ConflictException('Публичные отзывы изменились');
            const entitlement = await this.entitlements.resolve(userId, tx);
            prepareAiV2Preview(
                { task: 'review_summary', mode: 'public_summary', input: preview.input },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set([aiV4ProviderProfiles.economy.version]),
                    sourceSnapshotHash: current.sourceHash,
                },
            );

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
                    cost: 0,
                    status: 'processing',
                    task_id: task.id,
                })
                .execute();
            await tx
                .insertInto('ai_messages')
                .values({
                    id: messageId,
                    role: 'user',
                    body: 'Публичная сводка отзывов',
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
                    ${operationId}::uuid,'processing',${JSON.stringify({ allocations: [] })}::jsonb,${now},null,null,
                    ${input.idempotencyKey},${intervalId}::uuid,${messageId}::uuid,${userId}::uuid,${task.id}::uuid,
                    2,'initial',${requestHash},'queued','none',${now},${now},'simulator-economy-v1',
                    ${task.taskPolicyVersion},${task.contextPolicyVersion},${task.providerProfileVersion},${task.route},
                    ${task.routingPolicyVersion},${task.pricePolicyVersion},${task.resultSchemaVersion},
                    ${task.safetyPolicyVersion},${task.cachePolicyVersion},'none','RUB',${now},
                    ${new Date(now.getTime() + 30 * 86_400_000)}
                )
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
            return { replayed: false as const, operationId, clientRequestId, snapshot: current, clock: now };
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
                    preview: unknown;
                }>`
                    select operation.lifecycle_state state,operation.result_snapshot result,
                           operation.interval_id "intervalId",operation.task_id "taskId",task.preview
                      from meal.ai_operations operation join meal.ai_tasks task on task.id=operation.task_id
                     where operation.id=${operationId}::uuid and operation.contract_version=2
                     for update of operation,task
                `.execute(tx)
            ).rows[0];
            if (!row) throw new ConflictException('AI-операция недоступна');
            if (row.state === 'succeeded') {
                const result = aiV2ReviewSummaryResultSchema.parse(row.result);
                const preview = reviewTaskSnapshotSchema.parse(row.preview);
                const completed = reviewTaskSnapshotSchema.parse({ ...preview, result });
                await sql`
                    update meal.ai_tasks
                       set status='completed',preview=${JSON.stringify(completed)}::jsonb,version=version+1
                     where id=${row.taskId}::uuid and status='processing'
                `.execute(tx);
                await sql`
                    update meal.ai_intervals set status='completed',version=version+1
                     where id=${row.intervalId}::uuid and status='processing'
                `.execute(tx);
            } else if (['failed', 'cancelled'].includes(row.state)) {
                await sql`
                    update meal.ai_tasks set status='failed',version=version+1
                     where id=${row.taskId}::uuid and status='processing'
                `.execute(tx);
                await sql`
                    update meal.ai_intervals set status='refunded',version=version+1
                     where id=${row.intervalId}::uuid and status='processing'
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
