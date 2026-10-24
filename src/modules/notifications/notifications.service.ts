import { HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import {
    notificationCategories,
    notificationListQuerySchema,
    notificationListSchema,
    notificationMutationSchema,
    notificationPreferencesSchema,
    notificationPreferencesUpdateSchema,
    notificationReadAllSchema,
    notificationReadSchema,
} from './notifications.contracts.js';

type Tx = Transaction<DatabaseSchema>;
type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
const text = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : fallback;
const project = (row: {
    id: string;
    category: string;
    priority: string;
    payload: unknown;
    availableAt: Date | string;
    readAt: Date | string | null;
    version: string | number;
}) => {
    const payload = object(row.payload);
    const type = typeof payload.type === 'string' ? payload.type : '';
    let title = 'Новое уведомление',
        body = 'Откройте приложение, чтобы посмотреть подробности.',
        href: string | null = null;
    if (type === 'cooking-reminder') {
        title = 'Незавершённое приготовление';
        body = 'Приготовление ещё не завершено. Проверьте его состояние.';
    } else if (type === 'recipe-comment-reply') {
        title = 'Ответ на комментарий';
        body = 'В обсуждении вашего рецепта появился ответ.';
        href = typeof payload.recipeId === 'string' ? `/recipes/${payload.recipeId}` : null;
    } else if (type === 'support-reply') {
        title = 'Ответ поддержки';
        body = 'Поддержка ответила на ваше обращение.';
        href = typeof payload.ticketId === 'string' ? `/support/${payload.ticketId}` : null;
    } else {
        title = text(payload.title, title);
        body = text(payload.body, body);
        href = typeof payload.href === 'string' && /^\/(?!\/)/.test(payload.href) ? payload.href : null;
    }
    return {
        id: row.id,
        category: row.category,
        priority: row.priority,
        title,
        body,
        href,
        occurredAt: new Date(row.availableAt).toISOString(),
        readAt: row.readAt ? new Date(row.readAt).toISOString() : null,
        groupedCount:
            typeof payload.groupedCount === 'number' && payload.groupedCount > 0 ? Math.floor(payload.groupedCount) : 1,
        version: Number(row.version),
    };
};
@Injectable()
export class NotificationsService {
    constructor(private readonly database: DatabaseService) {}
    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    async list(userId: string, raw: unknown) {
        const input = notificationListQuerySchema.parse(raw);
        const db = await this.db();
        const category = input.category === 'all' ? sql`` : sql`and category=${input.category}`;
        const unread = input.unread === '1' ? sql`and read_at is null` : sql``;
        const [rows, count, unreadCount, counts] = await Promise.all([
            sql<{
                id: string;
                category: string;
                priority: string;
                payload: unknown;
                availableAt: Date;
                readAt: Date | null;
                version: string;
            }>`select id,category,priority,payload_minimized as payload,available_at as "availableAt",read_at as "readAt",version from meal.notifications where user_id=${userId}::uuid and available_at<=now() ${category} ${unread} order by available_at desc,id limit ${input.limit} offset ${input.offset}`.execute(
                db,
            ),
            sql<{
                total: number;
            }>`select count(*)::integer total from meal.notifications where user_id=${userId}::uuid and available_at<=now() ${category} ${unread}`.execute(
                db,
            ),
            sql<{
                total: number;
            }>`select count(*)::integer total from meal.notifications where user_id=${userId}::uuid and available_at<=now() and read_at is null`.execute(
                db,
            ),
            sql<{
                category: string;
                total: number;
            }>`select category,count(*)::integer total from meal.notifications where user_id=${userId}::uuid and available_at<=now() group by category`.execute(
                db,
            ),
        ]);
        const categoryCounts = Object.fromEntries(
            notificationCategories.map(([code]) => [code, counts.rows.find((x) => x.category === code)?.total ?? 0]),
        );
        return notificationListSchema.parse({
            items: rows.rows.map(project),
            total: count.rows[0]?.total ?? 0,
            unreadCount: unreadCount.rows[0]?.total ?? 0,
            categoryCounts,
        });
    }
    private async replay<T>(
        tx: Tx,
        userId: string,
        operation: string,
        target: string,
        input: { idempotencyKey: string },
        run: () => Promise<T>,
    ): Promise<T> {
        const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const prior = await tx
            .selectFrom('idempotency_records')
            .select(['request_hash', 'response_snapshot'])
            .where('actor_namespace', '=', `user:${userId}`)
            .where('operation', '=', operation)
            .where('target_binding', '=', target)
            .where('key', '=', input.idempotencyKey)
            .executeTakeFirst();
        if (prior) {
            if (prior.request_hash !== hash) throw new HttpException('Ключ использован для другого запроса', 409);
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
                response_snapshot: JSON.parse(JSON.stringify(result)) as never,
                expires_at: sql`'infinity'::timestamptz`,
                user_id: userId,
                scope_id: null,
                actor_namespace: `user:${userId}`,
            })
            .execute();
        return result;
    }
    private async writable(tx: Tx, userId: string) {
        const user = await tx
            .selectFrom('users')
            .select('id')
            .where('id', '=', userId)
            .where('status', '=', 'active')
            .forUpdate()
            .executeTakeFirst();
        if (!user) throw new HttpException('Аккаунт недоступен', 403);
        const banned =
            await sql`select id from meal.sanctions where user_id=${userId}::uuid and scope='account' and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                tx,
            );
        if (banned.rows.length) throw new HttpException('Доступен только просмотр', 403);
    }
    read(userId: string, id: string, raw: unknown) {
        const input = notificationReadSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            return this.replay(tx, userId, 'notifications.read', id, input, async () => {
                const row = await tx
                    .selectFrom('notifications')
                    .select(['id', 'version', 'read_at'])
                    .where('id', '=', id)
                    .where('user_id', '=', userId)
                    .forUpdate()
                    .executeTakeFirst();
                if (!row) throw new NotFoundException();
                if (Number(row.version) !== input.expectedVersion)
                    throw new HttpException('Уведомление изменилось', 412);
                if (row.read_at) return notificationMutationSchema.parse({ updated: 0 });
                await tx
                    .updateTable('notifications')
                    .set({ read_at: new Date(), version: Number(row.version) + 1 })
                    .where('id', '=', id)
                    .execute();
                return notificationMutationSchema.parse({ updated: 1 });
            });
        });
    }
    readAll(userId: string, raw: unknown) {
        const input = notificationReadAllSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            return this.replay(tx, userId, 'notifications.read-all', input.category, input, async () => {
                const category = input.category === 'all' ? sql`` : sql`and category=${input.category}`;
                const result = await sql<{
                    id: string;
                }>`update meal.notifications set read_at=now(),version=version+1 where user_id=${userId}::uuid and read_at is null and available_at<=now() ${category} returning id`.execute(
                    tx,
                );
                return notificationMutationSchema.parse({ updated: result.rows.length });
            });
        });
    }
    async preferences(userId: string) {
        const db = await this.db();
        const rows = await db
            .selectFrom('notification_preferences')
            .select(['category', 'channel', 'enabled', 'quiet_hours', 'timezone', 'urgent_opt_in', 'version'])
            .where('user_id', '=', userId)
            .where('channel', 'in', ['web_push', 'email'])
            .execute();
        const first = rows[0];
        const quiet = object(first?.quiet_hours);
        return notificationPreferencesSchema.parse({
            categories: notificationCategories.map(([category]) => ({
                category,
                push: rows.find((x) => x.category === category && x.channel === 'web_push')?.enabled ?? false,
                email: rows.find((x) => x.category === category && x.channel === 'email')?.enabled ?? false,
            })),
            quietHours: { start: text(quiet.start, '22:00'), end: text(quiet.end, '08:00') },
            planReminderTime: text(quiet.planReminderTime, '08:00'),
            timezone: first?.timezone ?? 'Europe/Moscow',
            urgentFoodRisk: rows.some((x) => x.urgent_opt_in),
            version: Math.max(1, ...rows.map((x) => Number(x.version))),
            deliveryAvailable: { push: false, email: false },
        });
    }
    updatePreferences(userId: string, raw: unknown) {
        const input = notificationPreferencesUpdateSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            return this.replay(tx, userId, 'notifications.preferences', userId, input, async () => {
                const rows = await tx
                    .selectFrom('notification_preferences')
                    .select('version')
                    .where('user_id', '=', userId)
                    .where('channel', 'in', ['web_push', 'email'])
                    .forUpdate()
                    .execute();
                const version = Math.max(1, ...rows.map((x) => Number(x.version)));
                if (version !== input.expectedVersion) throw new HttpException('Настройки изменились', 412);
                const next = version + 1;
                const quiet = { ...input.quietHours, planReminderTime: input.planReminderTime };
                for (const item of input.categories)
                    for (const channel of ['web_push', 'email'] as const)
                        await tx
                            .insertInto('notification_preferences')
                            .values({
                                id: randomUUID(),
                                category: item.category,
                                channel,
                                enabled: channel === 'web_push' ? item.push : item.email,
                                quiet_hours: quiet,
                                timezone: input.timezone,
                                urgent_opt_in: input.urgentFoodRisk,
                                user_id: userId,
                                version: next,
                            })
                            .onConflict((x) =>
                                x.columns(['user_id', 'category', 'channel']).doUpdateSet({
                                    enabled: channel === 'web_push' ? item.push : item.email,
                                    quiet_hours: quiet,
                                    timezone: input.timezone,
                                    urgent_opt_in: input.urgentFoodRisk,
                                    version: next,
                                }),
                            )
                            .execute();
                return notificationPreferencesSchema.parse({
                    categories: input.categories,
                    quietHours: input.quietHours,
                    planReminderTime: input.planReminderTime,
                    timezone: input.timezone,
                    urgentFoodRisk: input.urgentFoodRisk,
                    version: next,
                    deliveryAvailable: { push: false, email: false },
                });
            });
        });
    }
}
