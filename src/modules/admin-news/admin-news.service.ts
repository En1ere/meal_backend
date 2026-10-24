import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { AdminAccessService } from '../admin-auth/admin-access.service.js';
import type { Principal } from '../auth/auth.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { LegalConsentService } from '../legal-consents/legal-consent.service.js';
import {
    newsCommandSchema,
    newsContentSchema,
    newsItemSchema,
    newsResultSchema,
    type NewsItem,
} from './admin-news.contracts.js';
import { deliverNewsInApp, resolveNewsAudience } from './news-delivery.js';

type Tx = Transaction<DatabaseSchema>;
const iso = (value: Date | string) => new Date(value).toISOString();

@Injectable()
export class AdminNewsService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: AdminAccessService,
        private readonly entitlements: EntitlementsService,
        private readonly legalConsents: LegalConsentService,
    ) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    private async items(db: NonNullable<DatabaseService['db']> | Tx): Promise<NewsItem[]> {
        const rows = await sql<{
            id: string;
            version: number;
            revision: number;
            status: string;
            publishAt: Date | null;
            content: unknown;
        }>`select a.id,a.version::int,a.revision,a.status,a.publish_at as "publishAt",v.content
             from meal.announcements a join meal.announcement_versions v on v.announcement_id=a.id and v.revision=a.revision
             order by a.created_at desc,a.id desc`.execute(db);
        const history = rows.rows.length
            ? await sql<{ announcementId: string; revision: number; at: Date; content: unknown }>`
                select announcement_id as "announcementId",revision,created_at as at,content
                from meal.announcement_versions where announcement_id=any(${rows.rows.map((row) => row.id)}::uuid[])
                order by announcement_id,revision`.execute(db)
            : { rows: [] };
        return rows.rows.flatMap((row): NewsItem[] => {
            const content = newsContentSchema.safeParse(row.content);
            if (!content.success || !['draft', 'scheduled', 'published', 'cancelled'].includes(row.status)) return [];
            return [
                newsItemSchema.parse({
                    id: row.id,
                    version: row.version,
                    content: content.data,
                    status: row.status,
                    scheduledAt: row.status === 'scheduled' && row.publishAt ? iso(row.publishAt) : null,
                    history: history.rows
                        .filter((entry) => entry.announcementId === row.id && entry.revision < row.revision)
                        .flatMap((entry) => {
                            const parsed = newsContentSchema.safeParse(entry.content);
                            return parsed.success
                                ? [{ version: entry.revision, at: iso(entry.at), content: parsed.data }]
                                : [];
                        }),
                }),
            ];
        });
    }

    async list() {
        return newsResultSchema.parse({ items: await this.items(await this.db()), preview: null, message: '' });
    }

    private async audit(tx: Tx, actor: Principal, action: string, id: string, requestId: string, details: unknown) {
        await tx
            .insertInto('audit_events')
            .values({
                id: randomUUID(),
                action,
                target_type: 'announcement',
                target_id: id,
                effective_at: new Date(),
                recorded_at: new Date(),
                reason: null,
                before_redacted: null,
                after_redacted: JSON.parse(JSON.stringify(details)) as never,
                request_id: requestId,
                actor_id: actor.id,
                scope_id: null,
            })
            .execute();
    }

    async command(actor: Principal, raw: unknown) {
        const command = newsCommandSchema.parse(raw);
        if (command.action === 'list') return this.list();
        if (command.action === 'preview') {
            const db = await this.db();
            const item = (await this.items(db)).find((entry) => entry.id === command.id);
            if (!item) throw new NotFoundException('Новость не найдена');
            if (item.version !== command.version) throw new ConflictException('Новость изменилась');
            const recipients = (await resolveNewsAudience(item.content, db, this.entitlements, this.legalConsents))
                .length;
            return newsResultSchema.parse({
                items: await this.items(db),
                preview: { id: item.id, version: item.version, recipients, preliminary: true, mock: false },
                message: 'Предварительная аудитория рассчитана по текущим данным.',
            });
        }
        return this.database.transaction(async (tx) => {
            const idempotencyKey = 'idempotencyKey' in command ? command.idempotencyKey : null;
            const operation = `admin.news.${command.action}`;
            const requestHash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
            if (idempotencyKey) {
                const prior = await tx
                    .selectFrom('idempotency_records')
                    .select(['request_hash', 'response_snapshot'])
                    .where('actor_namespace', '=', `admin:${actor.id}`)
                    .where('operation', '=', operation)
                    .where('key', '=', idempotencyKey)
                    .executeTakeFirst();
                if (prior) {
                    if (prior.request_hash !== requestHash) throw new ConflictException('Ключ команды уже использован');
                    return newsResultSchema.parse(prior.response_snapshot);
                }
            }
            if (command.action === 'save') {
                const current = await tx
                    .selectFrom('announcements')
                    .select(['version', 'revision', 'status'])
                    .where('id', '=', command.id)
                    .forUpdate()
                    .executeTakeFirst();
                if (Number(current?.version ?? 0) !== command.version)
                    throw new ConflictException('Новость изменилась');
                if (current?.status === 'scheduled') throw new ConflictException('Сначала отмените отправку');
                const content = newsContentSchema.parse(command.content);
                const revision = (current?.revision ?? 0) + 1;
                if (!current)
                    await tx
                        .insertInto('announcements')
                        .values({
                            id: command.id,
                            kind: content.type,
                            revision,
                            pages: JSON.stringify(content.pages) as never,
                            status: 'draft',
                            publish_at: null,
                            author_id: actor.id,
                        })
                        .execute();
                else
                    await tx
                        .updateTable('announcements')
                        .set({
                            kind: content.type,
                            revision,
                            pages: JSON.stringify(content.pages) as never,
                            status: current.status === 'published' ? 'published' : 'draft',
                            version: sql`version+1`,
                        })
                        .where('id', '=', command.id)
                        .execute();
                await tx
                    .insertInto('announcement_versions')
                    .values({
                        id: randomUUID(),
                        announcement_id: command.id,
                        revision,
                        content: content as never,
                        created_by: actor.id,
                    })
                    .execute();
                await this.audit(tx, actor, 'admin.news.save', command.id, command.idempotencyKey, { revision });
            } else {
                const item = (await this.items(tx)).find((entry) => entry.id === command.id);
                if (!item) throw new NotFoundException('Новость не найдена');
                if (item.version !== command.version) throw new ConflictException('Новость изменилась');
                if (command.action === 'launch') {
                    await this.access.assertCritical(tx, actor);
                    if (item.content.channels.some((channel) => channel !== 'in_app'))
                        throw new ServiceUnavailableException({
                            code: 'NEWS_EXTERNAL_DELIVERY_UNAVAILABLE',
                            message: 'Email и push недоступны до подключения провайдеров.',
                        });
                    if (command.scheduledAt) {
                        const scheduledAt = new Date(command.scheduledAt);
                        if (scheduledAt <= new Date())
                            throw new ConflictException('Время публикации должно быть в будущем');
                        await tx
                            .updateTable('announcements')
                            .set({ status: 'scheduled', publish_at: scheduledAt, version: sql`version+1` })
                            .where('id', '=', item.id)
                            .execute();
                        await this.audit(tx, actor, 'admin.news.schedule', item.id, command.idempotencyKey, {
                            revision: item.history.length + 1,
                            scheduledAt: scheduledAt.toISOString(),
                            channels: ['in_app'],
                        });
                    } else {
                        const recipients = await resolveNewsAudience(
                            item.content,
                            tx,
                            this.entitlements,
                            this.legalConsents,
                        );
                        await deliverNewsInApp(tx, item.id, item.history.length + 1, item.content, recipients);
                        await tx
                            .updateTable('announcements')
                            .set({ status: 'published', publish_at: new Date(), version: sql`version+1` })
                            .where('id', '=', item.id)
                            .execute();
                        await this.audit(tx, actor, 'admin.news.publish', item.id, command.idempotencyKey, {
                            revision: item.history.length + 1,
                            recipients: recipients.length,
                            channels: ['in_app'],
                        });
                    }
                } else if (command.action === 'cancel') {
                    if (item.status !== 'scheduled' || !item.scheduledAt || new Date(item.scheduledAt) <= new Date())
                        throw new ConflictException('Отменить можно только будущую публикацию');
                    await tx
                        .updateTable('announcements')
                        .set({ status: 'cancelled', publish_at: null, version: sql`version+1` })
                        .where('id', '=', item.id)
                        .execute();
                    await this.audit(tx, actor, 'admin.news.cancel', item.id, command.idempotencyKey, {});
                } else {
                    if (item.content.channels.some((channel) => channel !== 'in_app'))
                        throw new ServiceUnavailableException({
                            code: 'NEWS_EXTERNAL_DELIVERY_UNAVAILABLE',
                            message: 'Тест email/push недоступен до подключения провайдеров.',
                        });
                    const recipients = new Set<string>();
                    if (command.recipients.includes('admin')) recipients.add(actor.id);
                    if (command.recipients.includes('moderator')) {
                        const moderators = await sql<{
                            id: string;
                        }>`select distinct u.id from meal.users u join meal.staff_role_assignments r on r.user_id=u.id where r.role='moderator' and r.revoked_at is null and u.status='active'`.execute(
                            tx,
                        );
                        moderators.rows.forEach((row) => recipients.add(row.id));
                    }
                    for (const userId of recipients)
                        await tx
                            .insertInto('notifications')
                            .values({
                                id: randomUUID(),
                                category: 'news',
                                priority: 'informational',
                                payload_minimized: { type: 'news-test', newsId: item.id, title: item.content.title },
                                dedup_key: `news-test:${command.idempotencyKey}:${userId}`,
                                available_at: new Date(),
                                read_at: null,
                                fullscreen_seen_at: null,
                                user_id: userId,
                                ownership_transfer_id: null,
                                announcement_id: item.id,
                            })
                            .execute();
                    await this.audit(tx, actor, 'admin.news.test', item.id, command.idempotencyKey, {
                        recipients: recipients.size,
                        channels: ['in_app'],
                    });
                }
            }
            const response = newsResultSchema.parse({
                items: await this.items(tx),
                preview: null,
                message:
                    command.action === 'launch'
                        ? command.scheduledAt
                            ? 'Публикация внутри приложения запланирована.'
                            : 'Новость опубликована внутри приложения.'
                        : command.action === 'test'
                          ? 'Тестовое сообщение доставлено внутри приложения.'
                          : 'Изменения сохранены.',
            });
            if (idempotencyKey)
                await tx
                    .insertInto('idempotency_records')
                    .values({
                        id: randomUUID(),
                        operation,
                        target_binding: command.id,
                        key: idempotencyKey,
                        request_hash: requestHash,
                        status: 'completed',
                        response_snapshot: response as never,
                        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                        user_id: actor.id,
                        scope_id: null,
                        actor_namespace: `admin:${actor.id}`,
                    })
                    .execute();
            return response;
        });
    }
}
