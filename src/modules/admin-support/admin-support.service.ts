import {
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { Principal } from '../auth/auth.service.js';
import {
    supportCreateSchema,
    supportManageSchema,
    supportManagedResultSchema,
    supportWorkspaceSchema,
} from './admin-support.contracts.js';

type Tx = Transaction<DatabaseSchema>;

@Injectable()
export class AdminSupportService {
    constructor(private readonly database: DatabaseService) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
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

    async workspace(ticketId: string, actor: Principal) {
        const db = await this.db();
        const ticket = await db
            .selectFrom('support_tickets')
            .select(['id', 'version', 'assignee_id'])
            .where('id', '=', ticketId)
            .executeTakeFirst();
        if (!ticket) throw new NotFoundException();
        const [staff, messages, events, attachments] = await Promise.all([
            db
                .selectFrom('staff_role_assignments')
                .innerJoin('users', 'users.id', 'staff_role_assignments.user_id')
                .select(['users.id', 'users.login'])
                .where('staff_role_assignments.revoked_at', 'is', null)
                .where('users.status', '=', 'active')
                .where('users.archived_at', 'is', null)
                .execute(),
            db
                .selectFrom('support_messages')
                .select(['id', 'body', 'author_id', 'internal', 'created_at'])
                .where('ticket_id', '=', ticketId)
                .orderBy('created_at', 'asc')
                .limit(500)
                .execute(),
            db
                .selectFrom('support_events')
                .select(['kind', 'before_snapshot', 'after_snapshot', 'recorded_at'])
                .where('ticket_id', '=', ticketId)
                .where('kind', '=', 'message_edited')
                .orderBy('recorded_at', 'asc')
                .limit(1000)
                .execute(),
            db
                .selectFrom('media_links')
                .innerJoin('media_assets', 'media_assets.id', 'media_links.asset_id')
                .innerJoin('support_messages', 'support_messages.id', 'media_links.support_message_id')
                .select([
                    'media_assets.id',
                    'media_assets.mime',
                    'media_assets.size_bytes',
                    'media_assets.status',
                    'media_links.support_message_id',
                ])
                .where('media_links.support_message_id', 'is not', null)
                .where('support_messages.ticket_id', '=', ticketId)
                .limit(100)
                .execute(),
        ]);
        const revisions = new Map<string, { body: string; createdAt: string }[]>();
        for (const event of events) {
            const before = event.before_snapshot as Record<string, unknown>;
            const messageId = typeof before.messageId === 'string' ? before.messageId : '';
            const body = typeof before.body === 'string' ? before.body : '';
            if (messageId && body)
                (revisions.get(messageId) ?? revisions.set(messageId, []).get(messageId)!).push({
                    body,
                    createdAt: new Date(event.recorded_at).toISOString(),
                });
        }
        return supportWorkspaceSchema.parse({
            version: String(ticket.version),
            assigneeId: ticket.assignee_id,
            staff: staff.map((row) => ({ id: row.id, label: row.login })),
            messages: messages.map((row) => ({
                id: row.id,
                body: row.body,
                authorId: row.author_id,
                internal: row.internal,
                edited: revisions.has(row.id),
                canEdit: row.author_id === actor.id,
                revisions: revisions.get(row.id) ?? [],
            })),
            attachments: attachments.map((row) => ({
                id: row.id,
                messageId: row.support_message_id!,
                name: 'Вложение поддержки',
                type: row.mime,
                size: Number(row.size_bytes),
                duration: null,
                status: ['uploading', 'pending', 'ready', 'rejected', 'hidden'].includes(row.status)
                    ? row.status
                    : 'pending',
                reason: row.status === 'pending' ? 'Ожидает проверки медиасканером' : null,
            })),
        });
    }

    create(raw: unknown, actor: Principal, requestId: string) {
        const input = supportCreateSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            return this.idempotent(
                tx,
                actor,
                input.idempotencyKey,
                'admin.support.create',
                input.requesterId,
                input,
                async () => {
                    const requester = await tx
                        .selectFrom('users')
                        .select('id')
                        .where('id', '=', input.requesterId)
                        .executeTakeFirst();
                    if (!requester) throw new NotFoundException();
                    const ticketId = randomUUID();
                    const count = await sql<{
                        value: string;
                    }>`select (coalesce(max(public_number::bigint) filter (where public_number ~ '^[0-9]+$'),1000)+1)::text value from meal.support_tickets`.execute(
                        tx,
                    );
                    await tx
                        .insertInto('support_tickets')
                        .values({
                            id: ticketId,
                            public_number: count.rows[0]!.value,
                            category: 'technical',
                            status: 'waiting_for_user',
                            subject: input.subject,
                            closed_at: null,
                            requester_id: input.requesterId,
                            assignee_id: actor.id,
                            thread_id: null,
                        })
                        .execute();
                    await tx
                        .insertInto('support_messages')
                        .values({
                            id: randomUUID(),
                            body: input.body,
                            internal: false,
                            ticket_id: ticketId,
                            author_id: actor.id,
                        })
                        .execute();
                    await this.event(tx, ticketId, actor.id, 'created', null, { subject: input.subject });
                    await this.audit(tx, actor, requestId, 'admin.support.create', ticketId, null);
                    return supportManagedResultSchema.parse({ ticketId, version: '1' });
                },
            );
        });
    }

    manage(ticketId: string, raw: unknown, actor: Principal, requestId: string) {
        const input = supportManageSchema.parse(raw);
        if (input.action === 'attach')
            throw new ServiceUnavailableException('Object storage and media scanner are not configured');
        if (input.action === 'hide')
            throw new ServiceUnavailableException('Media moderation requires configured object storage');
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            return this.idempotent(
                tx,
                actor,
                input.idempotencyKey,
                `admin.support.${input.action}`,
                ticketId,
                input,
                async () => {
                    const ticket = await tx
                        .selectFrom('support_tickets')
                        .select(['id', 'version', 'assignee_id'])
                        .where('id', '=', ticketId)
                        .forUpdate()
                        .executeTakeFirst();
                    if (!ticket) throw new NotFoundException();
                    if (String(ticket.version) !== input.version) throw new ConflictException('Ticket changed');
                    if (input.action === 'assign') {
                        if (input.targetId) {
                            const staff = await tx
                                .selectFrom('staff_role_assignments')
                                .select('id')
                                .where('user_id', '=', input.targetId)
                                .where('revoked_at', 'is', null)
                                .executeTakeFirst();
                            if (!staff) throw new ConflictException('Assignee is unavailable');
                        }
                        await tx
                            .updateTable('support_tickets')
                            .set({ assignee_id: input.targetId, version: Number(ticket.version) + 1 })
                            .where('id', '=', ticketId)
                            .execute();
                        await this.event(
                            tx,
                            ticketId,
                            actor.id,
                            'assigned',
                            { assigneeId: ticket.assignee_id },
                            { assigneeId: input.targetId },
                        );
                    } else if (input.action === 'note') {
                        if (!input.text) throw new ConflictException('Text required');
                        const messageId = randomUUID();
                        await tx
                            .insertInto('support_messages')
                            .values({
                                id: messageId,
                                body: input.text,
                                internal: true,
                                ticket_id: ticketId,
                                author_id: actor.id,
                            })
                            .execute();
                        await tx
                            .updateTable('support_tickets')
                            .set({ version: Number(ticket.version) + 1 })
                            .where('id', '=', ticketId)
                            .execute();
                        await this.event(tx, ticketId, actor.id, 'private_note', null, { messageId });
                    } else if (input.action === 'edit') {
                        if (!input.targetId || !input.text) throw new ConflictException('Message and text required');
                        const message = await tx
                            .selectFrom('support_messages')
                            .select(['id', 'body', 'author_id'])
                            .where('id', '=', input.targetId)
                            .where('ticket_id', '=', ticketId)
                            .forUpdate()
                            .executeTakeFirst();
                        if (!message) throw new NotFoundException();
                        if (message.author_id !== actor.id) throw new ForbiddenException();
                        await tx
                            .updateTable('support_messages')
                            .set({ body: input.text })
                            .where('id', '=', message.id)
                            .execute();
                        await tx
                            .updateTable('support_tickets')
                            .set({ version: Number(ticket.version) + 1 })
                            .where('id', '=', ticketId)
                            .execute();
                        await this.event(
                            tx,
                            ticketId,
                            actor.id,
                            'message_edited',
                            { messageId: message.id, body: message.body },
                            { messageId: message.id, body: input.text },
                        );
                    }
                    const version = String(Number(ticket.version) + 1);
                    await this.audit(
                        tx,
                        actor,
                        requestId,
                        `admin.support.${input.action}`,
                        ticketId,
                        input.text || null,
                    );
                    return supportManagedResultSchema.parse({ ticketId, version });
                },
            );
        });
    }

    private async idempotent<T>(
        tx: Tx,
        actor: Principal,
        key: string,
        operation: string,
        target: string,
        input: unknown,
        run: () => Promise<T>,
    ) {
        const namespace = `admin:${actor.id}`;
        const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const old = await tx
            .selectFrom('idempotency_records')
            .select(['request_hash', 'response_snapshot'])
            .where('actor_namespace', '=', namespace)
            .where('operation', '=', operation)
            .where('target_binding', '=', target)
            .where('key', '=', key)
            .executeTakeFirst();
        if (old) {
            if (old.request_hash !== hash) throw new ConflictException('Idempotency key already used');
            return old.response_snapshot as T;
        }
        const result = await run();
        await tx
            .insertInto('idempotency_records')
            .values({
                id: randomUUID(),
                operation,
                target_binding: target,
                key,
                request_hash: hash,
                status: 'completed',
                response_snapshot: JSON.parse(JSON.stringify(result)) as never,
                expires_at: sql`'infinity'::timestamptz`,
                user_id: actor.id,
                scope_id: null,
                actor_namespace: namespace,
            })
            .execute();
        return result;
    }

    private async event(tx: Tx, ticketId: string, actorId: string, kind: string, before: unknown, after: unknown) {
        await tx
            .insertInto('support_events')
            .values({
                id: randomUUID(),
                kind,
                before_snapshot: (before ?? {}) as never,
                after_snapshot: (after ?? {}) as never,
                reason: null,
                recorded_at: new Date(),
                ticket_id: ticketId,
                actor_id: actorId,
            })
            .execute();
    }

    private async audit(
        tx: Tx,
        actor: Principal,
        requestId: string,
        action: string,
        targetId: string,
        reason: string | null,
    ) {
        await tx
            .insertInto('audit_events')
            .values({
                id: randomUUID(),
                action,
                target_type: 'support_ticket',
                target_id: targetId,
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
