import {
    ConflictException,
    Injectable,
    NotFoundException,
    Optional,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { AdminAccessService } from '../admin-auth/admin-access.service.js';
import type { Principal } from '../auth/auth.service.js';
import { ContentReleasesService } from '../content-releases/content-releases.service.js';
import {
    contentCompareSchema,
    contentMergeSchema,
    contentModerateSchema,
    contentNotDuplicateSchema,
    contentParamsSchema,
    contentResultSchema,
    type ContentCard,
} from './admin-content.contracts.js';

type Tx = Transaction<DatabaseSchema>;

export function compareContentCards(
    left: ContentCard,
    right: ContentCard,
    input: ReturnType<typeof contentCompareSchema.parse>,
) {
    if (left.id === right.id || left.aliasOf || right.aliasOf) throw new ConflictException('Select active cards');
    if (left.version !== input.leftVersion || right.version !== input.rightVersion)
        throw new ConflictException('Cards changed');
    if (![left.id, right.id].includes(input.canonicalId)) throw new ConflictException('Invalid canonical card');
    const conflicts = [...new Set([...Object.keys(left.fields), ...Object.keys(right.fields)])].filter(
        (key) => left.fields[key] !== right.fields[key],
    );
    const resolved: Record<string, string | null> = {};
    for (const key of new Set([...Object.keys(left.fields), ...Object.keys(right.fields)])) {
        if (!conflicts.includes(key)) resolved[key] = left.fields[key] ?? null;
        else if (input.choices[key]) resolved[key] = (input.choices[key] === 'left' ? left : right).fields[key] ?? null;
    }
    const blockedReason =
        left.fields.composition !== right.fields.composition || !left.fields.composition
            ? 'Составы отличаются или не подтверждены. Объединение недоступно до проверки состава.'
            : null;
    const previewKey = createHash('sha256')
        .update(
            JSON.stringify({
                left: left.id,
                right: right.id,
                versions: [left.version, right.version],
                canonicalId: input.canonicalId,
                resolved,
            }),
        )
        .digest('hex');
    return { left, right, conflicts, blockedReason, resolved, canonicalId: input.canonicalId, previewKey };
}

@Injectable()
export class AdminContentService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: AdminAccessService,
        @Optional() private readonly releases?: ContentReleasesService,
    ) {}
    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    private async cards(db: NonNullable<DatabaseService['db']>): Promise<ContentCard[]> {
        const rows = await db
            .selectFrom('brand_products')
            .select([
                'brand_products.id',
                'brand_products.version',
                'brand_products.name',
                'brand_products.status',
                'brand_products.brand_id',
                'brand_products.variant_id',
                'brand_products.package_quantity',
                'brand_products.package_unit_id',
            ])
            .orderBy('brand_products.created_at', 'desc')
            .limit(200)
            .execute();
        const compositions = rows.length
            ? await db
                  .selectFrom('composition_versions')
                  .select(['product_id', 'composition_text', 'kcal', 'protein', 'fat', 'carbs', 'source'])
                  .where(
                      'product_id',
                      'in',
                      rows.map((row) => row.id),
                  )
                  .orderBy('created_at', 'desc')
                  .orderBy('id', 'desc')
                  .execute()
            : [];
        const latestComposition = new Map<string, (typeof compositions)[number]>();
        for (const composition of compositions)
            if (composition.product_id && !latestComposition.has(composition.product_id))
                latestComposition.set(composition.product_id, composition);
        const merges = await db
            .selectFrom('catalog_merges')
            .select(['source_product_id', 'target_product_id'])
            .where('status', '=', 'applied')
            .execute();
        return rows.map((row) => {
            const composition = latestComposition.get(row.id);
            return {
                id: row.id,
                version: Number(row.version),
                name: row.name,
                fields: {
                    name: row.name,
                    brand: row.brand_id,
                    composition: composition?.composition_text ?? null,
                    kcal: composition?.kcal ?? null,
                    protein: composition?.protein ?? null,
                    fat: composition?.fat ?? null,
                    carbs: composition?.carbs ?? null,
                },
                variants: [
                    JSON.stringify({
                        quantity: row.package_quantity,
                        unit: row.package_unit_id,
                        variant: row.variant_id,
                    }),
                ],
                authors: [],
                sources: composition?.source ? [composition.source] : [],
                aliasOf: merges.find((merge) => merge.source_product_id === row.id)?.target_product_id ?? null,
            };
        });
    }
    async load(raw: unknown) {
        const params = contentParamsSchema.parse(raw);
        const db = await this.db();
        const cards = await this.cards(db);
        if (params.section === 'catalog') {
            const card = cards.find((item) => item.id === params.id);
            if (!card) throw new NotFoundException();
            return contentResultSchema.parse({
                section: params.section,
                id: params.id,
                version: card.version,
                current: null,
                pending: null,
                status: card.aliasOf ? 'merged' : 'active',
                history: [],
                cards,
                comparison: null,
                message: '',
            });
        }
        const row = await db
            .selectFrom('moderation_cases')
            .leftJoin('recipe_revisions', 'recipe_revisions.id', 'moderation_cases.recipe_revision_id')
            .leftJoin('recipes', 'recipes.id', 'recipe_revisions.recipe_id')
            .select([
                'moderation_cases.id',
                'moderation_cases.version',
                'moderation_cases.status',
                'recipe_revisions.id as revision_id',
                'recipe_revisions.revision',
                'recipe_revisions.title',
                'recipe_revisions.portions',
                'recipe_revisions.method',
                'recipes.author_id',
            ])
            .where('moderation_cases.id', '=', params.id)
            .executeTakeFirst();
        if (!row) throw new NotFoundException();
        const history = await db
            .selectFrom('moderation_decisions')
            .select(['action', 'reason', 'actor_id', 'decided_at'])
            .where('case_id', '=', params.id)
            .orderBy('decided_at', 'desc')
            .limit(100)
            .execute();
        const revision = row.revision_id
            ? {
                  id: row.revision_id,
                  version: row.revision ?? 1,
                  fields: {
                      title: row.title ?? '',
                      portions: String(row.portions ?? ''),
                      method: row.method ?? '',
                      author: row.author_id,
                  },
              }
            : null;
        return contentResultSchema.parse({
            section: params.section,
            id: params.id,
            version: Number(row.version),
            current: row.status === 'approved' ? revision : null,
            pending: ['pending', 'in_review'].includes(row.status) ? revision : null,
            status: row.status,
            history: history.map((item) => ({
                action: item.action,
                reason: item.reason,
                actor: item.actor_id ?? 'system',
                at: new Date(item.decided_at).toISOString(),
            })),
            cards,
            comparison: null,
            message: '',
        });
    }
    async compare(rawParams: unknown, raw: unknown) {
        const params = contentParamsSchema.parse(rawParams);
        const input = contentCompareSchema.parse(raw);
        if (params.section !== 'catalog') throw new ConflictException();
        const view = await this.load(params);
        const left = view.cards.find((card) => card.id === input.leftId);
        const right = view.cards.find((card) => card.id === input.rightId);
        if (!left || !right || left.id === right.id || left.aliasOf || right.aliasOf)
            throw new ConflictException('Select active cards');
        return contentResultSchema.parse({ ...view, comparison: compareContentCards(left, right, input) });
    }
    async moderate(rawParams: unknown, raw: unknown, actor: Principal, requestId: string) {
        const params = contentParamsSchema.parse(rawParams);
        const input = contentModerateSchema.parse(raw);
        if (params.section !== 'queues') throw new ConflictException();
        const replayed = await this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            if (await this.replay(tx, actor, params.id, `admin.content.${input.action}`, input.idempotencyKey, input))
                return true;
            const item = await tx
                .selectFrom('moderation_cases')
                .select([
                    'id',
                    'version',
                    'status',
                    'kind',
                    'evidence',
                    'reporter_id',
                    'recipe_revision_id',
                    'catalog_proposal_revision_id',
                ])
                .where('id', '=', params.id)
                .forUpdate()
                .executeTakeFirst();
            if (!item) throw new NotFoundException();
            if (Number(item.version) !== input.version) throw new ConflictException('Case changed');
            const isRecipeReview = item.recipe_revision_id !== null;
            const isSubstantiveCorrection =
                item.kind === 'catalog_correction' &&
                item.catalog_proposal_revision_id !== null &&
                typeof item.evidence === 'object' &&
                item.evidence !== null &&
                !Array.isArray(item.evidence) &&
                item.evidence.substantive === true;
            if (!isRecipeReview && !isSubstantiveCorrection)
                throw new ConflictException('Recipe revision or substantive catalog correction required');
            const decisionId = randomUUID();
            await tx
                .insertInto('moderation_decisions')
                .values({
                    id: decisionId,
                    action: input.action,
                    reason: input.reason,
                    decided_at: new Date(),
                    before_snapshot: { status: item.status },
                    after_snapshot: {
                        status: input.action,
                        transition: isSubstantiveCorrection
                            ? input.action === 'approve'
                                ? 'catalog.correction.accepted'
                                : 'catalog.correction.reversed'
                            : null,
                    },
                    case_id: item.id,
                    actor_id: actor.id,
                })
                .execute();
            if (input.action === 'approve' && item.recipe_revision_id)
                await tx
                    .insertInto('recipe_publications')
                    .values({
                        id: randomUUID(),
                        published_at: new Date(),
                        unpublished_at: null,
                        revision_id: item.recipe_revision_id,
                        decision_id: decisionId,
                    })
                    .execute();
            if (input.action === 'approve' && item.recipe_revision_id) {
                const recipe = await sql<{
                    recipeId: string;
                    authorId: string;
                }>`select rr.recipe_id as "recipeId",r.author_id as "authorId" from meal.recipe_revisions rr join meal.recipes r on r.id=rr.recipe_id where rr.id=${item.recipe_revision_id}::uuid`.execute(
                    tx,
                );
                const value = recipe.rows[0];
                if (value) {
                    await this.releases?.recordReputationEventIn(
                        tx,
                        value.authorId,
                        'published-own-recipe',
                        value.recipeId,
                        `recipe-published:${value.recipeId}`,
                        { recipeId: value.recipeId, decisionId },
                    );
                    await this.releases?.processAchievementEventIn(tx, value.authorId, 'recipe.published', {
                        recipeId: value.recipeId,
                        decisionId,
                    });
                }
            }
            if (isSubstantiveCorrection) {
                const author = await sql<{
                    userId: string;
                    proposalId: string;
                }>`select coalesce(mc.reporter_id,cpr.author_id,cp.author_id) "userId",cp.id "proposalId"
                    from meal.moderation_cases mc join meal.catalog_proposal_revisions cpr on cpr.id=mc.catalog_proposal_revision_id
                    join meal.catalog_proposals cp on cp.id=cpr.proposal_id where mc.id=${item.id}::uuid`.execute(tx);
                const contributorId = author.rows[0]?.userId;
                const proposalId = author.rows[0]?.proposalId;
                if (contributorId && input.action === 'approve') {
                    if (proposalId)
                        await sql`update meal.catalog_proposals set status='approved',version=version+1 where id=${proposalId}::uuid`.execute(
                            tx,
                        );
                    await this.releases?.recordReputationEventIn(
                        tx,
                        contributorId,
                        'accepted-content-correction',
                        item.id,
                        `catalog-correction:${item.id}`,
                        { caseId: item.id, proposalRevisionId: item.catalog_proposal_revision_id, decisionId },
                    );
                    await this.releases?.processAchievementEventIn(tx, contributorId, 'catalog.correction.accepted', {
                        caseId: item.id,
                        proposalRevisionId: item.catalog_proposal_revision_id,
                        decisionId,
                    });
                } else if (contributorId && ['reject', 'hide', 'unpublish'].includes(input.action)) {
                    if (proposalId)
                        await sql`update meal.catalog_proposals set status='rejected',version=version+1 where id=${proposalId}::uuid`.execute(
                            tx,
                        );
                    await this.releases?.reverseReputationEventByKeyIn(
                        tx,
                        contributorId,
                        `catalog-correction:${item.id}`,
                        'accepted-content-correction-reversed',
                    );
                    await this.releases?.evaluateAchievementsIn(tx, contributorId, {
                        trigger: 'catalog.correction.reversed',
                        caseId: item.id,
                        decisionId,
                    });
                }
            }
            if ((input.action === 'hide' || input.action === 'unpublish') && item.recipe_revision_id)
                await tx
                    .updateTable('recipe_publications')
                    .set({ unpublished_at: new Date() })
                    .where('revision_id', '=', item.recipe_revision_id)
                    .where('unpublished_at', 'is', null)
                    .execute();
            if ((input.action === 'hide' || input.action === 'unpublish') && item.recipe_revision_id) {
                const recipe = await sql<{
                    recipeId: string;
                    authorId: string;
                }>`select rr.recipe_id "recipeId",r.author_id "authorId"
                    from meal.recipe_revisions rr join meal.recipes r on r.id=rr.recipe_id where rr.id=${item.recipe_revision_id}::uuid`.execute(
                    tx,
                );
                const value = recipe.rows[0];
                if (value)
                    await this.releases?.reverseReputationEventByKeyIn(
                        tx,
                        value.authorId,
                        `recipe-published:${value.recipeId}`,
                        'published-own-recipe-reversed',
                    );
            }
            await tx
                .updateTable('moderation_cases')
                .set({
                    status:
                        input.action === 'approve' ? 'approved' : input.action === 'reject' ? 'rejected' : input.action,
                    version: Number(item.version) + 1,
                })
                .where('id', '=', item.id)
                .execute();
            await this.record(
                tx,
                actor,
                requestId,
                params.id,
                `admin.content.${input.action}`,
                input.reason,
                input.idempotencyKey,
                input,
            );
            return false;
        });
        if (replayed)
            return contentResultSchema.parse({ ...(await this.load(params)), message: 'Запрос уже выполнен.' });
        return contentResultSchema.parse({ ...(await this.load(params)), message: '' });
    }
    async merge(rawParams: unknown, raw: unknown, actor: Principal, requestId: string) {
        const params = contentParamsSchema.parse(rawParams);
        const input = contentMergeSchema.parse(raw);
        const alreadyApplied = await this.database.transaction(async (tx) => {
            await this.access.assertCritical(tx, actor);
            return this.replay(tx, actor, params.id, 'admin.content.merge', input.idempotencyKey, input);
        });
        if (alreadyApplied)
            return contentResultSchema.parse({ ...(await this.load(params)), message: 'Запрос уже выполнен.' });
        const preview = await this.compare(params, {
            leftId: input.leftId,
            rightId: input.rightId,
            leftVersion: input.leftVersion,
            rightVersion: input.rightVersion,
            canonicalId: input.canonicalId,
            choices: input.choices,
        });
        const replayed = await this.database.transaction(async (tx) => {
            await this.access.assertCritical(tx, actor);
            if (await this.replay(tx, actor, params.id, 'admin.content.merge', input.idempotencyKey, input))
                return true;
            if (
                !preview.comparison ||
                preview.comparison.blockedReason ||
                preview.comparison.conflicts.some((key) => !input.choices[key]) ||
                preview.comparison.previewKey !== input.previewKey
            )
                throw new ConflictException('Refresh preview');
            const sourceId = input.canonicalId === input.leftId ? input.rightId : input.leftId;
            const canonical = preview.comparison.resolved;
            await tx
                .updateTable('brand_products')
                .set({ name: canonical.name ?? preview.comparison.left.name, version: sql`version+1` })
                .where('id', '=', input.canonicalId)
                .execute();
            await tx
                .updateTable('brand_products')
                .set({ status: 'merged', version: sql`version+1` })
                .where('id', '=', sourceId)
                .execute();
            await tx
                .insertInto('catalog_merges')
                .values({
                    id: randomUUID(),
                    kind: 'product_duplicate',
                    status: 'applied',
                    preview: preview.comparison,
                    applied_at: new Date(),
                    reason: input.reason,
                    source_ingredient_id: null,
                    target_ingredient_id: null,
                    source_product_id: sourceId,
                    target_product_id: input.canonicalId,
                    actor_id: actor.id,
                })
                .execute();
            await this.record(
                tx,
                actor,
                requestId,
                params.id,
                'admin.content.merge',
                input.reason,
                input.idempotencyKey,
                input,
            );
            return false;
        });
        return contentResultSchema.parse({
            ...(await this.load(params)),
            message: replayed ? 'Запрос уже выполнен.' : 'Карточки объединены; исходный ID сохранён в истории слияния.',
        });
    }
    async notDuplicate(rawParams: unknown, raw: unknown, actor: Principal, requestId: string) {
        const params = contentParamsSchema.parse(rawParams);
        const input = contentNotDuplicateSchema.parse(raw);
        const replayed = await this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            if (await this.replay(tx, actor, params.id, 'admin.content.not-duplicate', input.idempotencyKey, input))
                return true;
            const products = await tx
                .selectFrom('brand_products')
                .select(['id', 'version', 'status'])
                .where('id', 'in', [input.leftId, input.rightId])
                .forUpdate()
                .execute();
            const left = products.find((product) => product.id === input.leftId);
            const right = products.find((product) => product.id === input.rightId);
            if (!left || !right || left.id === right.id) throw new ConflictException('Select two active cards');
            if (left.status === 'merged' || right.status === 'merged')
                throw new ConflictException('Select active cards');
            if (Number(left.version) !== input.leftVersion || Number(right.version) !== input.rightVersion)
                throw new ConflictException('Cards changed');
            await tx
                .insertInto('catalog_merges')
                .values({
                    id: randomUUID(),
                    kind: 'not_duplicate',
                    status: 'closed',
                    preview: { leftVersion: input.leftVersion, rightVersion: input.rightVersion },
                    applied_at: new Date(),
                    reason: input.reason,
                    source_ingredient_id: null,
                    target_ingredient_id: null,
                    source_product_id: input.leftId,
                    target_product_id: input.rightId,
                    actor_id: actor.id,
                })
                .execute();
            await this.record(
                tx,
                actor,
                requestId,
                params.id,
                'admin.content.not-duplicate',
                input.reason,
                input.idempotencyKey,
                input,
            );
            return false;
        });
        return contentResultSchema.parse({
            ...(await this.load(params)),
            message: replayed ? 'Запрос уже выполнен.' : 'Пара закрыта до изменения данных карточек.',
        });
    }
    private async assertActor(tx: Tx, actor: Principal) {
        const row = await tx
            .selectFrom('sessions')
            .innerJoin('users', 'users.id', 'sessions.user_id')
            .select('sessions.id')
            .where('sessions.id', '=', actor.sessionId)
            .where('sessions.user_id', '=', actor.id)
            .where('sessions.auth_context', '=', 'admin')
            .where('sessions.revoked_at', 'is', null)
            .where('sessions.expires_at', '>', new Date())
            .where('users.status', '=', 'active')
            .where('users.archived_at', 'is', null)
            .executeTakeFirst();
        if (!row || actor.context !== 'admin') throw new UnauthorizedException();
    }
    private async replay(tx: Tx, actor: Principal, target: string, action: string, key: string, input: unknown) {
        const previous = await tx
            .selectFrom('idempotency_records')
            .select('request_hash')
            .where('actor_namespace', '=', `admin:${actor.id}`)
            .where('operation', '=', action)
            .where('target_binding', '=', target)
            .where('key', '=', key)
            .executeTakeFirst();
        if (!previous) return false;
        const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        if (previous.request_hash !== hash) throw new ConflictException('Idempotency key already used');
        return true;
    }
    private async record(
        tx: Tx,
        actor: Principal,
        requestId: string,
        target: string,
        action: string,
        reason: string,
        key: string,
        input: unknown,
    ) {
        await tx
            .insertInto('idempotency_records')
            .values({
                id: randomUUID(),
                operation: action,
                target_binding: target,
                key,
                request_hash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
                status: 'completed',
                response_snapshot: null,
                expires_at: sql`'infinity'::timestamptz`,
                user_id: actor.id,
                scope_id: null,
                actor_namespace: `admin:${actor.id}`,
            })
            .execute();
        await tx
            .insertInto('audit_events')
            .values({
                id: randomUUID(),
                action,
                target_type: 'content',
                target_id: target,
                actor_id: actor.id,
                scope_id: null,
                effective_at: new Date(),
                recorded_at: new Date(),
                request_id: requestId,
                reason,
                before_redacted: null,
                after_redacted: null,
            })
            .execute();
    }
}
