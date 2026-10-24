import {
    ConflictException,
    HttpException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import {
    aiAppealCreateSchema,
    aiAppealDetailSchema,
    aiAppealsListSchema,
    aiRestrictionSchema,
} from './ai-appeals.contracts.js';

type Db = Kysely<DatabaseSchema>;
type Tx = Transaction<DatabaseSchema>;
const ticketStatuses: Record<string, string> = {
    open: 'Открыто',
    waiting_for_support: 'Ждёт ответа поддержки',
    waiting_for_user: 'Нужен ваш ответ',
    closed: 'Закрыто',
};

type RestrictionRow = {
    id: string;
    startsAt: Date;
    endsAt: Date | null;
    revokedAt: Date | null;
};
type AppealRow = {
    id: string;
    sanctionId: string;
    status: string;
    submittedAt: Date;
    resolvedAt: Date | null;
    decision: unknown;
    version: string | number;
    ticketId: string;
    publicNumber: string;
    ticketStatus: string;
    subject: string;
    ticketCreatedAt: Date;
    ticketClosedAt: Date | null;
    ticketVersion: string | number;
};

@Injectable()
export class AiAppealsService {
    constructor(private readonly database: DatabaseService) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    private restriction(row: RestrictionRow) {
        const now = Date.now();
        return aiRestrictionSchema.parse({
            id: row.id,
            status: row.revokedAt
                ? 'revoked'
                : new Date(row.startsAt).getTime() > now
                  ? 'scheduled'
                  : row.endsAt && new Date(row.endsAt).getTime() <= now
                    ? 'expired'
                    : 'active',
            startsAt: new Date(row.startsAt).toISOString(),
            endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
            reasonCategory: 'safety_policy',
            reasonLabel: 'Ограничение по правилам безопасного использования AI',
        });
    }

    private appeal(row: AppealRow) {
        const decision = row.decision as Record<string, unknown> | null;
        return {
            id: row.id,
            sanctionId: row.sanctionId,
            status: row.status,
            submittedAt: new Date(row.submittedAt).toISOString(),
            resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
            response: typeof decision?.response === 'string' ? decision.response : null,
            version: Number(row.version),
            ticket: {
                id: row.ticketId,
                number: row.publicNumber,
                category: 'ai_appeal',
                categoryLabel: 'Обращение по AI',
                status: row.ticketStatus,
                statusLabel: ticketStatuses[row.ticketStatus] ?? row.ticketStatus,
                subject: row.subject,
                createdAt: new Date(row.ticketCreatedAt).toISOString(),
                closedAt: row.ticketClosedAt ? new Date(row.ticketClosedAt).toISOString() : null,
                version: Number(row.ticketVersion),
            },
        };
    }

    private appealRows(db: Db | Tx, userId: string, appealId?: string) {
        let query = db
            .selectFrom('appeals as appeal')
            .innerJoin('sanctions as sanction', 'sanction.id', 'appeal.sanction_id')
            .innerJoin('support_tickets as ticket', 'ticket.id', 'appeal.ticket_id')
            .select([
                'appeal.id',
                'appeal.sanction_id as sanctionId',
                'appeal.status',
                'appeal.submitted_at as submittedAt',
                'appeal.resolved_at as resolvedAt',
                'appeal.decision',
                'appeal.version',
                'ticket.id as ticketId',
                'ticket.public_number as publicNumber',
                'ticket.status as ticketStatus',
                'ticket.subject',
                'ticket.created_at as ticketCreatedAt',
                'ticket.closed_at as ticketClosedAt',
                'ticket.version as ticketVersion',
            ])
            .where('appeal.user_id', '=', userId)
            .where('sanction.user_id', '=', userId)
            .where('sanction.scope', '=', 'ai')
            .where('ticket.requester_id', '=', userId)
            .where('ticket.category', '=', 'ai_appeal')
            .orderBy('appeal.submitted_at', 'desc');
        if (appealId) query = query.where('appeal.id', '=', appealId);
        return query.execute() as Promise<AppealRow[]>;
    }

    async list(userId: string) {
        const db = await this.db();
        const [restriction, appeals] = await Promise.all([
            db
                .selectFrom('sanctions')
                .select(['id', 'starts_at as startsAt', 'ends_at as endsAt', 'revoked_at as revokedAt'])
                .where('user_id', '=', userId)
                .where('scope', '=', 'ai')
                .where('revoked_at', 'is', null)
                .where('starts_at', '<=', new Date())
                .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', new Date())]))
                .orderBy('starts_at', 'desc')
                .executeTakeFirst(),
            this.appealRows(db, userId),
        ]);
        return aiAppealsListSchema.parse({
            restriction: restriction ? this.restriction(restriction) : null,
            items: appeals.map((row) => this.appeal(row)),
        });
    }

    async detail(userId: string, appealId: string, txOrDb?: Db | Tx) {
        const db = txOrDb ?? (await this.db());
        const row = (await this.appealRows(db, userId, appealId))[0];
        if (!row) throw new NotFoundException();
        const [restriction, messages] = await Promise.all([
            db
                .selectFrom('sanctions')
                .select(['id', 'starts_at as startsAt', 'ends_at as endsAt', 'revoked_at as revokedAt'])
                .where('id', '=', row.sanctionId)
                .where('user_id', '=', userId)
                .executeTakeFirstOrThrow(),
            db
                .selectFrom('support_messages')
                .selectAll()
                .where('ticket_id', '=', row.ticketId)
                .where('internal', '=', false)
                .orderBy('created_at')
                .execute(),
        ]);
        return aiAppealDetailSchema.parse({
            restriction: this.restriction(restriction),
            appeal: this.appeal(row),
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

    async create(userId: string, raw: unknown) {
        const input = aiAppealCreateSchema.parse(raw);
        const requestHash = createHash('sha256')
            .update(JSON.stringify({ sanctionId: input.sanctionId, body: input.body }))
            .digest('hex');
        return this.database.transaction(async (tx) => {
            const user = await tx
                .selectFrom('users')
                .select('id')
                .where('id', '=', userId)
                .where('status', '=', 'active')
                .where('archived_at', 'is', null)
                .forUpdate()
                .executeTakeFirst();
            if (!user) throw new HttpException('Аккаунт недоступен', 403);
            const sanction = await tx
                .selectFrom('sanctions')
                .select('id')
                .where('id', '=', input.sanctionId)
                .where('user_id', '=', userId)
                .where('scope', '=', 'ai')
                .where('revoked_at', 'is', null)
                .where('starts_at', '<=', new Date())
                .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', new Date())]))
                .forUpdate()
                .executeTakeFirst();
            if (!sanction) throw new ConflictException('Активное AI-ограничение недоступно');
            const previous = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', 'ai-appeal-create')
                .where('target_binding', '=', sanction.id)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (previous) {
                if (previous.request_hash !== requestHash) throw new ConflictException('Idempotency key already used');
                return aiAppealDetailSchema.parse(previous.response_snapshot);
            }
            const pending = await tx
                .selectFrom('appeals')
                .select('id')
                .where('sanction_id', '=', sanction.id)
                .where('user_id', '=', userId)
                .where('status', '=', 'pending')
                .executeTakeFirst();
            if (pending) throw new ConflictException('Апелляция уже рассматривается');
            const ticketId = randomUUID();
            const appealId = randomUUID();
            const submittedAt = new Date();
            await tx
                .insertInto('support_tickets')
                .values({
                    id: ticketId,
                    public_number: `MP-${ticketId.replaceAll('-', '').slice(0, 12).toUpperCase()}`,
                    category: 'ai_appeal',
                    status: 'open',
                    subject: 'Апелляция по ограничению AI',
                    requester_id: userId,
                    assignee_id: null,
                    thread_id: null,
                    closed_at: null,
                })
                .execute();
            await tx
                .insertInto('support_messages')
                .values({
                    id: randomUUID(),
                    body: input.body,
                    internal: false,
                    ticket_id: ticketId,
                    author_id: userId,
                })
                .execute();
            await tx
                .insertInto('appeals')
                .values({
                    id: appealId,
                    body: input.body,
                    status: 'pending',
                    submitted_at: submittedAt,
                    resolved_at: null,
                    decision: null,
                    user_id: userId,
                    sanction_id: sanction.id,
                    moderation_decision_id: null,
                    ticket_id: ticketId,
                })
                .execute();
            const response = await this.detail(userId, appealId, tx);
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'ai-appeal-create',
                    target_binding: sanction.id,
                    key: input.idempotencyKey,
                    request_hash: requestHash,
                    status: 'completed',
                    response_snapshot: response,
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: userId,
                    scope_id: null,
                    actor_namespace: `user:${userId}`,
                })
                .execute();
            return response;
        });
    }
}
