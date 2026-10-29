import {
    ConflictException,
    ForbiddenException,
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
import type { Principal } from '../auth/auth.service.js';
import { ContentReleasesService } from '../content-releases/content-releases.service.js';
import { RecipeLifecycleService, sanitizePublicReviewReason } from '../recipe-lifecycle/recipe-lifecycle.service.js';
import {
    moderatorClaimSchema,
    moderatorDecisionSchema,
    moderatorItemSchema,
    moderatorOverviewSchema,
    moderatorQueuePageSchema,
    moderatorSupportReopenSchema,
    moderatorSupportReplySchema,
    moderatorSupportSchema,
    type moderatorQueueSchema,
} from './moderator.contracts.js';
import type { z } from 'zod';

type Queue = z.infer<typeof moderatorQueueSchema>;
type Tx = Transaction<DatabaseSchema>;
type Db = NonNullable<DatabaseService['db']>;
type QueueFilters = {
    status?: string | undefined;
    assignment?: string | undefined;
    priority?: string | undefined;
    cursor?: string | undefined;
};
type CaseRow = {
    id: string;
    kind: string;
    status: string;
    reason: string;
    submittedAt: Date;
    priority: number;
    evidence: unknown;
    assignedTo: string | null;
    version: string | number | bigint;
    revisionId: string | null;
    title: string | null;
    method: string | null;
};

const queueTitles: Record<Queue, string> = {
    recipes: 'Рецепты',
    recipe_variants: 'Варианты рецептов',
    products: 'Продукты',
    reports: 'Жалобы',
    support: 'Поддержка',
    authorship: 'Авторство',
};
const queueKinds: Record<Exclude<Queue, 'support'>, string[]> = {
    recipes: ['recipe'],
    recipe_variants: ['recipe_variant'],
    products: ['catalog_correction', 'product', 'product_image'],
    reports: ['report', 'recipe_image', 'image_improvement'],
    authorship: ['authorship'],
};
const financialCategories = new Set(['billing', 'payment', 'refund', 'subscription', 'finance']);

export type ModeratorDecisionAction = 'approve' | 'reject' | 'publish' | 'hide' | 'unpublish';

export function moderatorActionsForStatus(status: string): ModeratorDecisionAction[] {
    if (status === 'published') return ['hide', 'unpublish'];
    if (status === 'approved') return ['publish', 'reject'];
    if (['queued', 'pending', 'in_review'].includes(status)) return ['approve', 'reject'];
    return [];
}

@Injectable()
export class ModeratorService {
    constructor(
        private readonly database: DatabaseService,
        private readonly lifecycle: RecipeLifecycleService,
        @Optional() private readonly releases?: ContentReleasesService,
    ) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    private async assertAccess(
        db: Db | Tx,
        actor: Principal,
        permission: 'catalog.review' | 'catalog.publish' | 'support.reply',
    ) {
        if (actor.context !== 'moderator') throw new UnauthorizedException();
        const result = await sql<{ allowed: number }>`select 1 allowed
            from meal.sessions s join meal.users u on u.id=s.user_id
            where s.id=${actor.sessionId}::uuid and s.user_id=${actor.id}::uuid and s.auth_context='moderator'
              and s.mfa_verified_at is not null and s.revoked_at is null and s.expires_at>now()
              and u.status='active' and u.archived_at is null
              and exists(select 1 from meal.staff_role_assignments r where r.user_id=u.id and r.role='moderator' and r.revoked_at is null)
              and exists(select 1 from meal.staff_grants g where g.user_id=u.id and g.permission=${permission}
                  and g.revoked_at is null and (g.valid_until is null or g.valid_until>now()))
            limit 1`.execute(db);
        if (!result.rows.length) throw new ForbiddenException();
    }

    private async cases(
        db: Db,
        queues?: Exclude<Queue, 'support'>[],
        filters: QueueFilters = {},
        actorId?: string,
        page: { limit: number; offset: number } = { limit: 500, offset: 0 },
    ) {
        const kinds = (queues ?? Object.keys(queueKinds)).flatMap(
            (queue) => queueKinds[queue as Exclude<Queue, 'support'>],
        );
        const conditions = [sql`mc.kind=any(${sql.val(kinds)}::text[])`];
        if (filters.status && filters.status !== 'all') conditions.push(sql`mc.status=${filters.status}`);
        if (filters.assignment && filters.assignment !== 'all') {
            if (!actorId) conditions.push(sql`false`);
            else if (filters.assignment === 'mine') conditions.push(sql`mc.assigned_to=${actorId}::uuid`);
            else if (filters.assignment === 'other')
                conditions.push(sql`mc.assigned_to is not null and mc.assigned_to<>${actorId}::uuid`);
            else if (filters.assignment === 'unassigned') conditions.push(sql`mc.assigned_to is null`);
            else conditions.push(sql`false`);
        }
        if (filters.priority && filters.priority !== 'all') {
            if (filters.priority === 'critical') conditions.push(sql`mc.queue_priority>=100`);
            else if (filters.priority === 'high') conditions.push(sql`mc.queue_priority>0 and mc.queue_priority<100`);
            else if (filters.priority === 'normal') conditions.push(sql`mc.queue_priority<=0`);
            else conditions.push(sql`false`);
        }
        return (
            await sql<CaseRow>`select mc.id,mc.kind,mc.status,mc.reason,mc.submitted_at "submittedAt",
                mc.queue_priority priority,mc.evidence,mc.assigned_to "assignedTo",mc.version,
                rr.id "revisionId",rr.title,rr.method
                from meal.moderation_cases mc
                left join meal.recipe_revisions rr on rr.id=mc.recipe_revision_id
                where ${sql.join(conditions, sql` and `)}
                order by mc.queue_priority desc,mc.submitted_at asc,mc.id asc
                limit ${page.limit} offset ${page.offset}`.execute(db)
        ).rows;
    }

    private queueOf(kind: string): Exclude<Queue, 'support'> {
        return (Object.entries(queueKinds).find(([, kinds]) => kinds.includes(kind))?.[0] ?? 'reports') as Exclude<
            Queue,
            'support'
        >;
    }

    private itemRow(row: CaseRow, actorId: string) {
        const queue = this.queueOf(row.kind);
        const assignment = row.assignedTo === actorId ? 'mine' : row.assignedTo ? 'other' : 'unassigned';
        const dueAt = new Date(new Date(row.submittedAt).getTime() + 48 * 60 * 60 * 1000).toISOString();
        return {
            id: row.id,
            queue,
            title: row.title?.trim() || row.reason || `Материал ${row.id.slice(0, 8)}`,
            status: row.status,
            assignment,
            priority: row.priority >= 100 ? 'critical' : row.priority > 0 ? 'high' : 'normal',
            dueAt,
            version: Number(row.version),
            canClaim: !row.assignedTo && ['pending', 'queued'].includes(row.status),
            canSkip: !row.assignedTo && ['pending', 'queued'].includes(row.status),
            canOpen: !row.assignedTo || row.assignedTo === actorId,
        } as const;
    }

    async overview(actor: Principal) {
        const db = await this.db();
        await this.assertAccess(db, actor, 'catalog.review');
        const kinds = Object.values(queueKinds).flat();
        const [caseCounts, assigned, oldest, supportAllowed] = await Promise.all([
            sql<{ kind: string; count: number }>`select kind,count(*)::integer count
                from meal.moderation_cases
                where kind=any(${sql.val(kinds)}::text[]) and status not in ('closed','resolved')
                group by kind`.execute(db),
            this.cases(db, undefined, { assignment: 'mine' }, actor.id, { limit: 20, offset: 0 }),
            sql<{ submittedAt: Date }>`select submitted_at "submittedAt" from meal.moderation_cases
                where kind=any(${sql.val(kinds)}::text[])
                  and status not in ('closed','resolved','published','rejected')
                order by submitted_at,id limit 1`.execute(db),
            this.assertAccess(db, actor, 'support.reply').then(
                () => true,
                () => false,
            ),
        ]);
        const supportCount = supportAllowed
            ? Number(
                  (
                      await sql<{ count: string }>`select count(*)::text count from meal.support_tickets
                          where status not in ('closed','resolved') and category not in ('billing','payment','refund','subscription','finance')`.execute(
                          db,
                      )
                  ).rows[0]?.count ?? 0,
              )
            : null;
        const queues = (Object.keys(queueTitles) as Queue[]).map((key) => ({
            key,
            title: queueTitles[key],
            count:
                key === 'support'
                    ? supportCount
                    : caseCounts.rows
                          .filter((row) => this.queueOf(row.kind) === key)
                          .reduce((total, row) => total + Number(row.count), 0),
            available: key !== 'support' || supportAllowed,
        }));
        const assignedItems = assigned.map((row) => this.itemRow(row, actor.id));
        const oldestSubmittedAt = oldest.rows[0]?.submittedAt;
        const attention = !!oldestSubmittedAt && Date.now() - +new Date(oldestSubmittedAt) > 36 * 60 * 60 * 1000;
        return moderatorOverviewSchema.parse({
            queues,
            assigned: assignedItems,
            sla: {
                state: attention ? 'attention' : 'normal',
                label: attention ? 'Есть задачи, требующие внимания' : 'Сроки в норме',
            },
        });
    }

    async queue(queue: Queue, filters: QueueFilters, actor: Principal) {
        const db = await this.db();
        await this.assertAccess(db, actor, queue === 'support' ? 'support.reply' : 'catalog.review');
        const parsedOffset = Number.parseInt(filters.cursor ?? '0', 10) || 0;
        const offset = parsedOffset <= 0 ? 0 : Math.min(parsedOffset, Number.MAX_SAFE_INTEGER);
        let items;
        let hasMore;
        if (queue === 'support') {
            const conditions = [sql`category not in ('billing','payment','refund','subscription','finance')`];
            if (filters.status && filters.status !== 'all') conditions.push(sql`status=${filters.status}`);
            if (filters.assignment && filters.assignment !== 'all') {
                if (filters.assignment === 'mine') conditions.push(sql`assignee_id=${actor.id}::uuid`);
                else if (filters.assignment === 'other')
                    conditions.push(sql`assignee_id is not null and assignee_id<>${actor.id}::uuid`);
                else if (filters.assignment === 'unassigned') conditions.push(sql`assignee_id is null`);
                else conditions.push(sql`false`);
            }
            if (filters.priority && !['all', 'normal'].includes(filters.priority)) conditions.push(sql`false`);
            const rows = await sql<{
                id: string;
                subject: string;
                status: string;
                assigneeId: string | null;
                category: string;
                createdAt: Date;
                version: string | number | bigint;
            }>`select id,subject,status,assignee_id "assigneeId",category,created_at "createdAt",version
                from meal.support_tickets where ${sql.join(conditions, sql` and `)}
                order by created_at asc,id asc limit 51 offset ${offset}`.execute(db);
            hasMore = rows.rows.length > 50;
            items = rows.rows.slice(0, 50).map((row) => {
                const assignment = row.assigneeId === actor.id ? 'mine' : row.assigneeId ? 'other' : 'unassigned';
                return {
                    id: row.id,
                    queue,
                    title: row.subject,
                    status: row.status,
                    assignment,
                    priority: 'normal' as const,
                    dueAt: new Date(+new Date(row.createdAt) + 48 * 60 * 60 * 1000).toISOString(),
                    version: Number(row.version),
                    canClaim: false,
                    canSkip: false,
                    canOpen: !row.assigneeId || row.assigneeId === actor.id,
                };
            });
        } else {
            const rows = await this.cases(db, [queue], filters, actor.id, { limit: 51, offset });
            hasMore = rows.length > 50;
            items = rows.slice(0, 50).map((row) => this.itemRow(row, actor.id));
        }
        return moderatorQueuePageSchema.parse({
            queue,
            title: queueTitles[queue],
            items,
            nextCursor: hasMore ? String(offset + items.length) : null,
        });
    }

    async item(id: string, actor: Principal) {
        const db = await this.db();
        await this.assertAccess(db, actor, 'catalog.review');
        const result = await sql<CaseRow>`select mc.id,mc.kind,mc.status,mc.reason,mc.submitted_at "submittedAt",
            mc.queue_priority priority,mc.evidence,mc.assigned_to "assignedTo",mc.version,
            rr.id "revisionId",rr.title,rr.method
            from meal.moderation_cases mc left join meal.recipe_revisions rr on rr.id=mc.recipe_revision_id
            where mc.id=${id}::uuid limit 1`.execute(db);
        const row = result.rows[0];
        if (!row) throw new NotFoundException();
        if (row.assignedTo && row.assignedTo !== actor.id) throw new ForbiddenException();
        const evidence =
            row.evidence && typeof row.evidence === 'object' && !Array.isArray(row.evidence)
                ? (row.evidence as Record<string, unknown>)
                : {};
        const publicContent =
            typeof evidence.publicContent === 'string' ? evidence.publicContent : (row.method ?? row.reason);
        const originalContent =
            typeof evidence.originalContent === 'string' ? evidence.originalContent : (row.method ?? row.reason);
        const related = await sql<{ id: string; title: string }>`select mc.id,coalesce(rr.title,mc.reason) title
            from meal.moderation_cases mc left join meal.recipe_revisions rr on rr.id=mc.recipe_revision_id
            where mc.id<>${id}::uuid and mc.kind=${row.kind} order by mc.submitted_at desc limit 5`.execute(db);
        const actions = row.assignedTo === actor.id ? moderatorActionsForStatus(row.status) : [];
        return moderatorItemSchema.parse({
            id: row.id,
            queue: this.queueOf(row.kind),
            title: row.title?.trim() || row.reason || `Материал ${row.id.slice(0, 8)}`,
            status: row.status,
            version: Number(row.version),
            assignment: row.assignedTo === actor.id ? 'mine' : 'unassigned',
            publicView: { title: row.title ?? row.reason, content: publicContent },
            original: { title: row.title ?? row.reason, content: originalContent },
            context: [row.reason, `Тип: ${row.kind}`].filter(Boolean),
            signals: Array.isArray(evidence.signals)
                ? evidence.signals.filter((value): value is string => typeof value === 'string')
                : [],
            related: related.rows,
            actions,
        });
    }

    async claim(id: string, raw: unknown, actor: Principal, requestId: string) {
        const input = moderatorClaimSchema.parse(raw);
        await this.database.transaction(async (tx) => {
            await this.assertAccess(tx, actor, 'catalog.review');
            if (await this.replayed(tx, actor, id, 'moderator.claim', input.idempotencyKey, input)) return;
            const item = await tx
                .selectFrom('moderation_cases')
                .select(['id', 'version', 'status', 'assigned_to'])
                .where('id', '=', id)
                .forUpdate()
                .executeTakeFirst();
            if (!item) throw new NotFoundException();
            if (Number(item.version) !== input.version) throw new ConflictException('Case changed');
            if (item.assigned_to && item.assigned_to !== actor.id) throw new ConflictException('Already assigned');
            if (!['pending', 'queued', 'in_review'].includes(item.status))
                throw new ConflictException('Case cannot be claimed');
            if (!item.assigned_to) {
                await tx
                    .insertInto('moderation_claims')
                    .values({
                        id: randomUUID(),
                        claimed_at: new Date(),
                        lease_until: sql`now()+interval '8 hours'`,
                        released_at: null,
                        outcome: null,
                        case_id: id,
                        staff_id: actor.id,
                    })
                    .execute();
                await tx
                    .updateTable('moderation_cases')
                    .set({ assigned_to: actor.id, status: 'in_review', version: Number(item.version) + 1 })
                    .where('id', '=', id)
                    .execute();
            }
            await this.record(tx, actor, id, 'moderator.claim', input.idempotencyKey, input, requestId, null);
        });
        return this.item(id, actor);
    }

    async skip(id: string, raw: unknown, actor: Principal, requestId: string) {
        const input = moderatorClaimSchema.parse(raw);
        await this.database.transaction(async (tx) => {
            await this.assertAccess(tx, actor, 'catalog.review');
            if (await this.replayed(tx, actor, id, 'moderator.skip', input.idempotencyKey, input)) return;
            const item = await tx
                .selectFrom('moderation_cases')
                .select(['id', 'version', 'status', 'assigned_to'])
                .where('id', '=', id)
                .forUpdate()
                .executeTakeFirst();
            if (!item) throw new NotFoundException();
            if (Number(item.version) !== input.version) throw new ConflictException('Case changed');
            if (item.assigned_to || !['pending', 'queued'].includes(item.status))
                throw new ConflictException('Case cannot be skipped');
            await tx
                .insertInto('moderation_claims')
                .values({
                    id: randomUUID(),
                    claimed_at: new Date(),
                    lease_until: new Date(),
                    released_at: new Date(),
                    outcome: 'notification_skipped',
                    case_id: id,
                    staff_id: actor.id,
                })
                .execute();
            await this.record(
                tx,
                actor,
                id,
                'moderator.skip',
                input.idempotencyKey,
                input,
                requestId,
                'Пропущено уведомление; материал остался в очереди.',
            );
        });
        return this.item(id, actor);
    }

    async decision(id: string, raw: unknown, actor: Principal, requestId: string) {
        const input = moderatorDecisionSchema.parse(raw);
        await this.database.transaction(async (tx) => {
            await this.assertAccess(
                tx,
                actor,
                ['publish', 'hide', 'unpublish'].includes(input.action) ? 'catalog.publish' : 'catalog.review',
            );
            if (await this.replayed(tx, actor, id, `moderator.${input.action}`, input.idempotencyKey, input)) return;
            const item = await tx
                .selectFrom('moderation_cases')
                .select(['id', 'kind', 'version', 'status', 'assigned_to', 'recipe_revision_id'])
                .where('id', '=', id)
                .forUpdate()
                .executeTakeFirst();
            if (!item) throw new NotFoundException();
            if (Number(item.version) !== input.version) throw new ConflictException('Case changed');
            if (item.assigned_to !== actor.id) throw new ForbiddenException('Claim the case first');
            if (!moderatorActionsForStatus(item.status).includes(input.action))
                throw new ConflictException('Action is not available for the current case state');
            if (input.action === 'publish' && item.kind !== 'recipe')
                throw new ConflictException('Only recipe submission cases can be published');
            const nextStatus =
                input.action === 'approve'
                    ? 'approved'
                    : input.action === 'reject'
                      ? 'rejected'
                      : input.action === 'publish'
                        ? 'published'
                        : input.action === 'hide'
                          ? 'hidden'
                          : 'unpublished';
            const decisionId = randomUUID();
            const publicReason = sanitizePublicReviewReason(
                input.publicReason,
                input.action === 'reject'
                    ? 'rejected'
                    : input.action === 'hide'
                      ? 'hidden'
                      : input.action === 'unpublish'
                        ? 'unpublished'
                        : 'pending',
            );
            await tx
                .insertInto('moderation_decisions')
                .values({
                    id: decisionId,
                    action: input.action,
                    reason: `[${input.category}] ${input.reason}`,
                    decided_at: new Date(),
                    before_snapshot: { status: item.status },
                    after_snapshot: { status: nextStatus, publicReason },
                    case_id: id,
                    actor_id: actor.id,
                })
                .execute();
            if (item.recipe_revision_id && item.kind === 'recipe') {
                if (input.action === 'publish') {
                    const published = await this.lifecycle.publish(tx, {
                        caseId: id,
                        revisionId: item.recipe_revision_id,
                        decisionId,
                        actorId: actor.id,
                    });
                    if (published.publicationCreated) {
                        await this.releases?.recordReputationEventIn(
                            tx,
                            published.authorId,
                            'published-own-recipe',
                            published.recipeId,
                            `recipe-published:${published.recipeId}`,
                            { recipeId: published.recipeId, decisionId },
                        );
                        await this.releases?.processAchievementEventIn(tx, published.authorId, 'recipe.published', {
                            recipeId: published.recipeId,
                            decisionId,
                        });
                    }
                } else if (input.action === 'approve')
                    await this.lifecycle.markReview(tx, {
                        caseId: id,
                        revisionId: item.recipe_revision_id,
                        status: 'pending',
                    });
                else if (input.action === 'reject')
                    await this.lifecycle.markReview(tx, {
                        caseId: id,
                        revisionId: item.recipe_revision_id,
                        status: 'rejected',
                        publicReason,
                    });
                else if (input.action === 'hide' || input.action === 'unpublish') {
                    const status = input.action === 'hide' ? 'hidden' : 'unpublished';
                    const closed = await this.lifecycle.closeActive(tx, {
                        revisionId: item.recipe_revision_id,
                        status,
                        publicReason,
                        sourceCaseId: id,
                        actorId: actor.id,
                    });
                    await this.releases?.reverseReputationEventByKeyIn(
                        tx,
                        closed.authorId,
                        `recipe-published:${closed.recipeId}`,
                        'published-own-recipe-reversed',
                    );
                }
            } else if (item.recipe_revision_id && (input.action === 'hide' || input.action === 'unpublish')) {
                const status = input.action === 'hide' ? 'hidden' : 'unpublished';
                await this.lifecycle.closeActive(tx, {
                    revisionId: item.recipe_revision_id,
                    status,
                    publicReason,
                    sourceCaseId: id,
                    actorId: actor.id,
                });
            }
            await tx
                .updateTable('moderation_cases')
                .set({
                    status: nextStatus,
                    assigned_to: input.action === 'approve' ? actor.id : null,
                    version: Number(item.version) + 1,
                })
                .where('id', '=', id)
                .execute();
            await tx
                .updateTable('moderation_claims')
                .set({ released_at: new Date(), outcome: input.action })
                .where('case_id', '=', id)
                .where('staff_id', '=', actor.id)
                .where('released_at', 'is', null)
                .execute();
            await this.record(
                tx,
                actor,
                id,
                `moderator.${input.action}`,
                input.idempotencyKey,
                input,
                requestId,
                input.reason,
            );
        });
        return this.item(id, actor);
    }

    async support(id: string, actor: Principal) {
        const db = await this.db();
        await this.assertAccess(db, actor, 'support.reply');
        const ticket = await db
            .selectFrom('support_tickets')
            .select(['id', 'version', 'subject', 'status', 'category', 'assignee_id', 'thread_id'])
            .where('id', '=', id)
            .executeTakeFirst();
        if (!ticket) throw new NotFoundException();
        if (financialCategories.has(ticket.category)) throw new ForbiddenException();
        if (ticket.assignee_id && ticket.assignee_id !== actor.id) throw new ForbiddenException();
        const messages = await db
            .selectFrom('support_messages')
            .select(['id', 'body', 'author_id', 'created_at'])
            .where('ticket_id', '=', id)
            .where('internal', '=', false)
            .orderBy('created_at', 'asc')
            .limit(500)
            .execute();
        return moderatorSupportSchema.parse({
            id: ticket.id,
            version: Number(ticket.version),
            subject: ticket.subject,
            status: ticket.status,
            category: ticket.category,
            assignment: ticket.assignee_id === actor.id ? 'mine' : 'unassigned',
            context: [`Категория: ${ticket.category}`, 'Внутренние заметки и финансовые данные скрыты.'],
            related: ticket.thread_id
                ? { id: ticket.thread_id, title: 'Связанный материал', href: `/community` }
                : null,
            messages: messages.map((message) => ({
                id: message.id,
                author: message.author_id === actor.id ? 'support' : 'user',
                body: message.body,
                createdAt: new Date(message.created_at).toISOString(),
            })),
            canReply: ticket.status !== 'closed',
            canReopen: ticket.status === 'closed',
        });
    }

    async reply(id: string, raw: unknown, actor: Principal, requestId: string) {
        const input = moderatorSupportReplySchema.parse(raw);
        await this.database.transaction(async (tx) => {
            await this.assertAccess(tx, actor, 'support.reply');
            if (await this.replayed(tx, actor, id, 'moderator.support.reply', input.idempotencyKey, input)) return;
            const ticket = await tx
                .selectFrom('support_tickets')
                .select(['id', 'version', 'status', 'category', 'assignee_id'])
                .where('id', '=', id)
                .forUpdate()
                .executeTakeFirst();
            if (!ticket) throw new NotFoundException();
            if (financialCategories.has(ticket.category)) throw new ForbiddenException();
            if (Number(ticket.version) !== input.version) throw new ConflictException('Ticket changed');
            if (ticket.status === 'closed' || (ticket.assignee_id && ticket.assignee_id !== actor.id))
                throw new ConflictException('Ticket is unavailable');
            const messageId = randomUUID();
            await tx
                .insertInto('support_messages')
                .values({ id: messageId, body: input.message, internal: false, ticket_id: id, author_id: actor.id })
                .execute();
            await tx
                .updateTable('support_tickets')
                .set({ status: 'waiting_for_user', assignee_id: actor.id, version: Number(ticket.version) + 1 })
                .where('id', '=', id)
                .execute();
            await tx
                .insertInto('support_events')
                .values({
                    id: randomUUID(),
                    kind: 'moderator_reply',
                    before_snapshot: { status: ticket.status },
                    after_snapshot: { status: 'waiting_for_user', messageId },
                    reason: null,
                    recorded_at: new Date(),
                    ticket_id: id,
                    actor_id: actor.id,
                })
                .execute();
            await this.record(tx, actor, id, 'moderator.support.reply', input.idempotencyKey, input, requestId, null);
        });
        return this.support(id, actor);
    }

    async reopen(id: string, raw: unknown, actor: Principal, requestId: string) {
        const input = moderatorSupportReopenSchema.parse(raw);
        await this.database.transaction(async (tx) => {
            await this.assertAccess(tx, actor, 'support.reply');
            if (await this.replayed(tx, actor, id, 'moderator.support.reopen', input.idempotencyKey, input)) return;
            const ticket = await tx
                .selectFrom('support_tickets')
                .select(['id', 'version', 'status', 'category'])
                .where('id', '=', id)
                .forUpdate()
                .executeTakeFirst();
            if (!ticket) throw new NotFoundException();
            if (financialCategories.has(ticket.category)) throw new ForbiddenException();
            if (Number(ticket.version) !== input.version || ticket.status !== 'closed')
                throw new ConflictException('Ticket cannot be reopened');
            await tx
                .updateTable('support_tickets')
                .set({
                    status: 'waiting_for_support',
                    assignee_id: actor.id,
                    closed_at: null,
                    version: Number(ticket.version) + 1,
                })
                .where('id', '=', id)
                .execute();
            await tx
                .insertInto('support_events')
                .values({
                    id: randomUUID(),
                    kind: 'reopened',
                    before_snapshot: { status: 'closed' },
                    after_snapshot: { status: 'waiting_for_support' },
                    reason: null,
                    recorded_at: new Date(),
                    ticket_id: id,
                    actor_id: actor.id,
                })
                .execute();
            await this.record(tx, actor, id, 'moderator.support.reopen', input.idempotencyKey, input, requestId, null);
        });
        return this.support(id, actor);
    }

    private async replayed(tx: Tx, actor: Principal, target: string, operation: string, key: string, input: unknown) {
        const old = await tx
            .selectFrom('idempotency_records')
            .select('request_hash')
            .where('actor_namespace', '=', `moderator:${actor.id}`)
            .where('operation', '=', operation)
            .where('target_binding', '=', target)
            .where('key', '=', key)
            .executeTakeFirst();
        if (!old) return false;
        const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        if (old.request_hash !== hash) throw new ConflictException('Idempotency key already used');
        return true;
    }

    private async record(
        tx: Tx,
        actor: Principal,
        target: string,
        operation: string,
        key: string,
        input: unknown,
        requestId: string,
        reason: string | null,
    ) {
        await tx
            .insertInto('idempotency_records')
            .values({
                id: randomUUID(),
                operation,
                target_binding: target,
                key,
                request_hash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
                status: 'completed',
                response_snapshot: null,
                expires_at: sql`'infinity'::timestamptz`,
                user_id: actor.id,
                scope_id: null,
                actor_namespace: `moderator:${actor.id}`,
            })
            .execute();
        await tx
            .insertInto('audit_events')
            .values({
                id: randomUUID(),
                action: operation,
                target_type: operation.startsWith('moderator.support') ? 'support_ticket' : 'moderation_case',
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
