import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { Principal } from '../auth/auth.service.js';
import { supportCommandResultSchema, type PreferenceChange, type SupportCommand } from './admin-actions.contracts.js';
type Tx = Transaction<DatabaseSchema>;
export function supportTransition(status: string, kind: 'reply' | 'reopen') {
    if (kind === 'reopen' ? status !== 'closed' : !['open', 'waiting_for_user', 'waiting_for_support'].includes(status))
        throw new ConflictException();
    return kind === 'reply' ? 'waiting_for_user' : 'waiting_for_support';
}
@Injectable()
export class AdminActionsService {
    constructor(private readonly database: DatabaseService) {}
    private async run<T>(
        actor: Principal,
        action: string,
        target: string,
        requestId: string,
        work: (tx: Tx) => Promise<T>,
    ) {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.transaction(async (tx) => {
            const allowed = await tx
                .selectFrom('sessions')
                .innerJoin('users', 'users.id', 'sessions.user_id')
                .select('sessions.id')
                .where('sessions.id', '=', actor.sessionId)
                .where('users.id', '=', actor.id)
                .where('sessions.kind', '=', 'staff')
                .where('sessions.auth_context', '=', 'admin')
                .where('sessions.revoked_at', 'is', null)
                .where('sessions.expires_at', '>', new Date())
                .where('sessions.mfa_verified_at', 'is not', null)
                .where('users.status', '=', 'active')
                .where('users.archived_at', 'is', null)
                .where('users.email_verified_at', 'is not', null)
                .where((eb) =>
                    eb.exists(
                        eb
                            .selectFrom('staff_role_assignments')
                            .select('id')
                            .whereRef('user_id', '=', 'users.id')
                            .where('role', '=', 'admin')
                            .where('revoked_at', 'is', null),
                    ),
                )
                .where((eb) =>
                    eb.exists(
                        eb
                            .selectFrom('mfa_factors')
                            .select('id')
                            .whereRef('user_id', '=', 'users.id')
                            .where('kind', '=', 'totp')
                            .where('revoked_at', 'is', null)
                            .where('verified_at', 'is not', null),
                    ),
                )
                .executeTakeFirst();
            if (!allowed || actor.context !== 'admin') throw new UnauthorizedException();
            // One actor lock also serializes first writes/idempotency across sessions.
            await tx.selectFrom('users').select('id').where('id', '=', actor.id).forUpdate().executeTakeFirstOrThrow();
            const result = await work(tx);
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action,
                    target_type: 'admin_action',
                    target_id: target,
                    actor_id: actor.id,
                    scope_id: null,
                    effective_at: new Date(),
                    recorded_at: new Date(),
                    request_id: requestId,
                    reason: null,
                    before_redacted: null,
                    after_redacted: null,
                })
                .execute();
            return result;
        });
    }
    preferences(actor: Principal, requestId: string, change?: PreferenceChange) {
        return this.run(
            actor,
            change ? 'admin.notifications.updated' : 'admin.notifications.read',
            actor.id,
            requestId,
            async (tx) => {
                const user = await tx
                    .selectFrom('users')
                    .select(['email_normalized', 'email_verified_at'])
                    .where('id', '=', actor.id)
                    .executeTakeFirstOrThrow();
                if (change) {
                    if (
                        change.channel === 'email' &&
                        change.enabled &&
                        (!user.email_normalized || !user.email_verified_at)
                    )
                        throw new ConflictException();
                    await tx
                        .insertInto('notification_preferences')
                        .values({
                            id: randomUUID(),
                            user_id: actor.id,
                            category: 'admin_operations',
                            channel: change.channel === 'mobilePush' ? 'mobile_push' : change.channel,
                            enabled: change.enabled,
                            quiet_hours: {},
                            timezone: 'UTC',
                            urgent_opt_in: false,
                        })
                        .onConflict((oc) =>
                            oc.columns(['user_id', 'category', 'channel']).doUpdateSet({
                                enabled: change.enabled,
                                version: sql`notification_preferences.version + 1`,
                            }),
                        )
                        .execute();
                }
                const rows = await tx
                    .selectFrom('notification_preferences')
                    .select(['channel', 'enabled'])
                    .where('user_id', '=', actor.id)
                    .where('category', '=', 'admin_operations')
                    .execute();
                const preferences = { browser: false, mobilePush: false, email: false };
                for (const row of rows) {
                    if (row.channel === 'browser' || row.channel === 'email') preferences[row.channel] = row.enabled;
                    if (row.channel === 'mobile_push') preferences.mobilePush = row.enabled;
                }
                return { preferences, verifiedEmail: user.email_verified_at ? user.email_normalized : null };
            },
        );
    }
    support(id: string, kind: 'reply' | 'reopen', input: SupportCommand, actor: Principal, requestId: string) {
        return this.run(actor, `admin.support.${kind}`, id, requestId, async (tx) => {
            const operation = `admin.support.${kind}`,
                namespace = `user:${actor.id}`;
            const hash = createHash('sha256')
                .update(JSON.stringify([id, kind, input.version, input.body ?? null]))
                .digest('hex');
            const prior = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', namespace)
                .where('operation', '=', operation)
                .where('target_binding', '=', id)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (prior) {
                if (prior.request_hash !== hash) throw new ConflictException();
                return supportCommandResultSchema.parse(prior.response_snapshot);
            }
            const ticket = await tx
                .selectFrom('support_tickets')
                .select(['id', 'version', 'status', 'assignee_id'])
                .where('id', '=', id)
                .forUpdate()
                .executeTakeFirst();
            if (!ticket) throw new NotFoundException();
            if (String(ticket.version) !== input.version) throw new ConflictException();
            const status = supportTransition(ticket.status, kind),
                messageId = kind === 'reply' ? randomUUID() : null;
            const assigneeId = kind === 'reply' ? actor.id : ticket.assignee_id;
            if (messageId)
                await tx
                    .insertInto('support_messages')
                    .values({ id: messageId, body: input.body!, internal: false, ticket_id: id, author_id: actor.id })
                    .execute();
            const updated = await tx
                .updateTable('support_tickets')
                .set({ status, assignee_id: assigneeId, closed_at: null, version: sql`version + 1` })
                .where('id', '=', id)
                .where('version', '=', input.version)
                .returning('version')
                .executeTakeFirst();
            if (!updated) throw new ConflictException();
            const result = { ticketId: id, version: String(updated.version), status, assigneeId, messageId };
            await tx
                .insertInto('support_events')
                .values({
                    id: randomUUID(),
                    ticket_id: id,
                    actor_id: actor.id,
                    kind,
                    before_snapshot: {
                        status: ticket.status,
                        version: String(ticket.version),
                        assigneeId: ticket.assignee_id,
                    },
                    after_snapshot: result,
                    reason: null,
                    recorded_at: new Date(),
                })
                .execute();
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation,
                    target_binding: id,
                    key: input.idempotencyKey,
                    request_hash: hash,
                    status: 'completed',
                    response_snapshot: result,
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: actor.id,
                    scope_id: null,
                    actor_namespace: namespace,
                })
                .execute();
            return result;
        });
    }
    messages(id: string, input: { cursor?: string | undefined; limit: number }, actor: Principal, requestId: string) {
        const binding = createHash('sha256')
            .update(JSON.stringify([id, actor.id, actor.sessionId]))
            .digest('hex');
        let cursor: { id: string; createdAt: string } | undefined;
        if (input.cursor) {
            try {
                cursor = z
                    .strictObject({
                        id: z.string().uuid(),
                        createdAt: z.string().datetime(),
                        binding: z.literal(binding),
                    })
                    .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
            } catch {
                throw new BadRequestException();
            }
        }
        return this.run(actor, 'admin.support.messages.read', id, requestId, async (tx) => {
            const ticket = await tx.selectFrom('support_tickets').select('id').where('id', '=', id).executeTakeFirst();
            if (!ticket) throw new NotFoundException();
            let query = tx
                .selectFrom('support_messages')
                .select(['id', 'body', 'author_id', 'created_at'])
                .select(
                    sql<string>`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
                        'cursor_time',
                    ),
                )
                .where('ticket_id', '=', id)
                .where('internal', '=', false);
            if (cursor)
                query = query.where(
                    sql<boolean>`(created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
                );
            const rows = await query
                .orderBy('created_at', 'desc')
                .orderBy('id', 'desc')
                .limit(input.limit + 1)
                .execute();
            const page = rows.slice(0, input.limit);
            return {
                items: page.map((row) => ({
                    id: row.id,
                    body: row.body,
                    authorId: row.author_id,
                    createdAt: row.created_at.toISOString(),
                    internal: false as const,
                })),
                nextCursor:
                    rows.length > input.limit
                        ? Buffer.from(
                              JSON.stringify({ id: page.at(-1)!.id, createdAt: page.at(-1)!.cursor_time, binding }),
                          ).toString('base64url')
                        : null,
            };
        });
    }
}
