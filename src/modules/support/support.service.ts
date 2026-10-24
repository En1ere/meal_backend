import {
    ConflictException,
    HttpException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import {
    supportCategories,
    supportCreateSchema,
    supportDetailSchema,
    supportEditSchema,
    supportListQuerySchema,
    supportListSchema,
    supportMetaSchema,
    supportReplySchema,
    supportStateSchema,
} from './support.contracts.js';
type Tx = Transaction<DatabaseSchema>;
const labels: Record<string, string> = {
    open: 'Открыто',
    waiting_for_support: 'Ждёт ответа поддержки',
    waiting_for_user: 'Нужен ваш ответ',
    closed: 'Закрыто',
};
const category = Object.fromEntries(supportCategories);
@Injectable()
export class SupportService {
    constructor(private readonly database: DatabaseService) {}
    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    meta() {
        return supportMetaSchema.parse({
            categories: supportCategories.map(([code, label]) => ({ code, label })),
            uploadMode: 'unavailable',
            attachmentPolicy: {
                maxFiles: 5,
                maxBytes: 10485760,
                maxVideoSeconds: 10,
                mime: [
                    'image/jpeg',
                    'image/png',
                    'image/webp',
                    'application/pdf',
                    'video/mp4',
                    'video/webm',
                    'video/quicktime',
                ],
            },
        });
    }
    private ticket(row: {
        id: string;
        public_number: string;
        category: string;
        status: string;
        subject: string;
        created_at: Date;
        closed_at: Date | null;
        version: string | number;
    }) {
        return {
            id: row.id,
            number: row.public_number,
            category: row.category,
            categoryLabel: category[row.category] ?? row.category,
            status: row.status,
            statusLabel: labels[row.status] ?? row.status,
            subject: row.subject,
            createdAt: new Date(row.created_at).toISOString(),
            closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
            version: Number(row.version),
        };
    }
    async list(userId: string, raw: unknown) {
        const q = supportListQuerySchema.parse(raw),
            db = await this.db();
        let source = db.selectFrom('support_tickets').where('requester_id', '=', userId);
        if (q.category !== 'all') source = source.where('category', '=', q.category);
        if (q.status === 'active') source = source.where('status', '!=', 'closed');
        else if (q.status !== 'all') source = source.where('status', '=', q.status);
        const [rows, count] = await Promise.all([
            source.selectAll().orderBy('created_at', 'desc').limit(q.limit).offset(q.offset).execute(),
            source.select(sql<number>`count(*)::int`.as('total')).executeTakeFirst(),
        ]);
        return supportListSchema.parse({ items: rows.map((x) => this.ticket(x)), total: count?.total ?? 0 });
    }
    async detail(userId: string, id: string) {
        const db = await this.db(),
            ticket = await db
                .selectFrom('support_tickets')
                .selectAll()
                .where('id', '=', id)
                .where('requester_id', '=', userId)
                .executeTakeFirst();
        if (!ticket) throw new NotFoundException();
        const messages = await db
            .selectFrom('support_messages')
            .selectAll()
            .where('ticket_id', '=', id)
            .where('internal', '=', false)
            .orderBy('created_at')
            .execute();
        return supportDetailSchema.parse({
            ticket: this.ticket(ticket),
            messages: messages.map((m) => ({
                id: m.id,
                body: m.body,
                author: m.author_id === userId ? 'user' : 'support',
                authorLabel: m.author_id === userId ? 'Вы' : 'Поддержка',
                own: m.author_id === userId,
                createdAt: new Date(m.created_at).toISOString(),
                edited: Number(m.version) > 1,
                version: Number(m.version),
                attachments: [],
            })),
        });
    }
    private async detailTx(tx: Tx, userId: string, id: string) {
        const ticket = await tx
            .selectFrom('support_tickets')
            .selectAll()
            .where('id', '=', id)
            .where('requester_id', '=', userId)
            .executeTakeFirst();
        if (!ticket) throw new NotFoundException();
        const messages = await tx
            .selectFrom('support_messages')
            .selectAll()
            .where('ticket_id', '=', id)
            .where('internal', '=', false)
            .orderBy('created_at')
            .execute();
        return supportDetailSchema.parse({
            ticket: this.ticket(ticket),
            messages: messages.map((message) => ({
                id: message.id,
                body: message.body,
                author: message.author_id === userId ? 'user' : 'support',
                authorLabel: message.author_id === userId ? 'Вы' : 'Поддержка',
                own: message.author_id === userId,
                createdAt: new Date(message.created_at).toISOString(),
                edited: Number(message.version) > 1,
                version: Number(message.version),
                attachments: [],
            })),
        });
    }
    private async writable(tx: Tx, userId: string) {
        const user = await tx
            .selectFrom('users')
            .select('id')
            .where('id', '=', userId)
            .where('status', '=', 'active')
            .forUpdate()
            .executeTakeFirst();
        if (!user) throw new HttpException('Доступен только просмотр', 403);
        const banned =
            await sql`select id from meal.sanctions where user_id=${userId}::uuid and scope='account' and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                tx,
            );
        if (banned.rows.length) throw new HttpException('Доступен только просмотр', 403);
    }
    private async replay<T>(
        tx: Tx,
        userId: string,
        operation: string,
        target: string,
        input: { idempotencyKey: string },
        run: () => Promise<T>,
    ) {
        const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex'),
            prior = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', operation)
                .where('target_binding', '=', target)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
        if (prior) {
            if (prior.request_hash !== hash) throw new ConflictException();
            return prior.response_snapshot as T;
        }
        const result = await run();
        await tx
            .insertInto('idempotency_records')
            .values({
                id: randomUUID(),
                operation,
                target_binding: target,
                key: input.idempotencyKey,
                request_hash: hash,
                status: 'completed',
                response_snapshot: result as never,
                expires_at: sql`'infinity'::timestamptz`,
                user_id: userId,
                scope_id: null,
                actor_namespace: `user:${userId}`,
            })
            .execute();
        return result;
    }
    create(userId: string, raw: unknown) {
        const input = supportCreateSchema.parse(raw);
        if (input.attachments.length) throw new ConflictException('Загрузка вложений ещё не подключена');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            return this.replay(tx, userId, 'support.create', 'new', input, async () => {
                const id = randomUUID(),
                    messageId = randomUUID(),
                    number = `MP-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
                await tx
                    .insertInto('support_tickets')
                    .values({
                        id,
                        public_number: number,
                        category: input.category,
                        status: 'open',
                        subject: input.subject,
                        requester_id: userId,
                        assignee_id: null,
                        thread_id: null,
                        closed_at: null,
                    })
                    .execute();
                await tx
                    .insertInto('support_messages')
                    .values({ id: messageId, body: input.body, internal: false, ticket_id: id, author_id: userId })
                    .execute();
                return this.detailTx(tx, userId, id);
            });
        });
    }
    reply(userId: string, id: string, raw: unknown) {
        const input = supportReplySchema.parse(raw);
        if (input.attachments.length) throw new ConflictException('Загрузка вложений ещё не подключена');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            return this.replay(tx, userId, 'support.reply', id, input, async () => {
                const ticket = await tx
                    .selectFrom('support_tickets')
                    .select(['id', 'version', 'status'])
                    .where('id', '=', id)
                    .where('requester_id', '=', userId)
                    .forUpdate()
                    .executeTakeFirst();
                if (!ticket) throw new NotFoundException();
                if (Number(ticket.version) !== input.expectedVersion)
                    throw new HttpException('Обращение изменилось', 412);
                if (ticket.status === 'closed') throw new ConflictException('Сначала возобновите обращение');
                await tx
                    .insertInto('support_messages')
                    .values({ id: randomUUID(), body: input.body, internal: false, ticket_id: id, author_id: userId })
                    .execute();
                await tx
                    .updateTable('support_tickets')
                    .set({ status: 'waiting_for_support', version: sql`version+1` })
                    .where('id', '=', id)
                    .execute();
                return this.detailTx(tx, userId, id);
            });
        });
    }
    edit(userId: string, id: string, messageId: string, raw: unknown) {
        const input = supportEditSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            return this.replay(tx, userId, 'support.edit', messageId, input, async () => {
                const ticket = await tx
                    .selectFrom('support_tickets')
                    .select(['id', 'version'])
                    .where('id', '=', id)
                    .where('requester_id', '=', userId)
                    .forUpdate()
                    .executeTakeFirst();
                if (!ticket) throw new NotFoundException();
                if (Number(ticket.version) !== input.expectedVersion)
                    throw new HttpException('Обращение изменилось', 412);
                const message = await tx
                    .selectFrom('support_messages')
                    .selectAll()
                    .where('id', '=', messageId)
                    .where('ticket_id', '=', id)
                    .where('author_id', '=', userId)
                    .where('internal', '=', false)
                    .forUpdate()
                    .executeTakeFirst();
                if (!message) throw new NotFoundException();
                if (Number(message.version) !== input.messageVersion)
                    throw new HttpException('Сообщение изменилось', 412);
                await tx
                    .updateTable('support_messages')
                    .set({ body: input.body, version: sql`version+1` })
                    .where('id', '=', messageId)
                    .execute();
                await tx
                    .insertInto('support_events')
                    .values({
                        id: randomUUID(),
                        kind: 'message_edit',
                        before_snapshot: { messageId, body: message.body, version: String(message.version) },
                        after_snapshot: { messageId, body: input.body, version: String(Number(message.version) + 1) },
                        reason: null,
                        recorded_at: new Date(),
                        ticket_id: id,
                        actor_id: userId,
                    })
                    .execute();
                await tx
                    .updateTable('support_tickets')
                    .set({ version: sql`version+1` })
                    .where('id', '=', id)
                    .execute();
                return this.detailTx(tx, userId, id);
            });
        });
    }
    state(userId: string, id: string, kind: 'close' | 'reopen', raw: unknown) {
        const input = supportStateSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            return this.replay(tx, userId, `support.${kind}`, id, input, async () => {
                const ticket = await tx
                    .selectFrom('support_tickets')
                    .select(['id', 'version', 'status'])
                    .where('id', '=', id)
                    .where('requester_id', '=', userId)
                    .forUpdate()
                    .executeTakeFirst();
                if (!ticket) throw new NotFoundException();
                if (Number(ticket.version) !== input.expectedVersion)
                    throw new HttpException('Обращение изменилось', 412);
                if (
                    (kind === 'close' && ticket.status === 'closed') ||
                    (kind === 'reopen' && ticket.status !== 'closed')
                )
                    throw new ConflictException();
                await tx
                    .updateTable('support_tickets')
                    .set({
                        status: kind === 'close' ? 'closed' : 'waiting_for_support',
                        closed_at: kind === 'close' ? new Date() : null,
                        version: sql`version+1`,
                    })
                    .where('id', '=', id)
                    .execute();
                return this.detailTx(tx, userId, id);
            });
        });
    }
}
