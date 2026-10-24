import {
    BadRequestException,
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
import { adminRecordSchema, type AdminRecord, type AdminSearch, type AdminSection } from './admin-read.contracts.js';
import { adminSources } from './admin-read.sources.js';
import { adminRelatedSources, relatedCollections } from './admin-related.sources.js';
import type { AdminRelatedSearch } from './admin-read.contracts.js';

type Tx = Transaction<DatabaseSchema>;
type Row = Record<string, string | number | boolean | Date | null>;
const uuid = z.string().uuid();
export function cursorBinding(section: AdminSection, input: AdminSearch, actor: Principal) {
    return createHash('sha256')
        .update(
            JSON.stringify([
                section,
                input.queue ?? '',
                input.query ?? '',
                input.status ?? '',
                input.limit ?? 25,
                actor.id,
                actor.sessionId,
            ]),
        )
        .digest('hex');
}
export function decodeAdminCursor(cursor: string | undefined, binding: string): string | null {
    if (!cursor) return null;
    try {
        const data: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        const parsed = z.strictObject({ id: uuid, binding: z.literal(binding) }).parse(data);
        return parsed.id;
    } catch {
        throw new BadRequestException('Invalid cursor');
    }
}
function value(raw: Row[string]): string | null {
    return raw === null || raw === undefined ? null : raw instanceof Date ? raw.toISOString() : String(raw);
}
export function projectAdminRecord(section: Exclude<AdminSection, 'overview'>, row: Row): AdminRecord {
    const source = adminSources[section];
    let status = source.status ? value(row[source.status] ?? null) : null;
    if (section === 'sanctions') {
        const now = Date.now();
        status = row.revoked_at
            ? 'revoked'
            : new Date(String(row.starts_at)).getTime() > now
              ? 'scheduled'
              : row.ends_at && new Date(String(row.ends_at)).getTime() <= now
                ? 'expired'
                : 'active';
    }
    return adminRecordSchema.parse({
        id: row.id,
        title: value(row[source.title] ?? null) ?? String(row.id),
        status,
        updatedAt: null,
        version: String(row.version ?? '1'),
        fields: [
            { key: 'createdAt', label: 'Создано', value: value(row.created_at ?? null) },
            ...source.fields.map(([key, label]) => ({ key, label, value: value(row[key] ?? null) })),
        ],
        related: (source.related ?? []).flatMap(([key, label, target]) =>
            row[key] ? [{ label, section: target, id: row[key] }] : [],
        ),
        actions: [
            {
                key: 'change',
                label: 'Изменить',
                enabled: false,
                reason: 'Изменение доступно только через согласованную доменную команду с проверкой последствий.',
            },
        ],
    });
}

@Injectable()
export class AdminReadService {
    constructor(private readonly database: DatabaseService) {}
    private async run<T>(
        actor: Principal,
        section: AdminSection,
        target: string | undefined,
        requestId: string,
        work: (tx: Tx) => Promise<T>,
    ) {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.transaction(async (tx) => {
            // Recheck inside the same serializable transaction as protected reads and their audit.
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
                            .where('verified_at', 'is not', null)
                            .where('revoked_at', 'is', null),
                    ),
                )
                .executeTakeFirst();
            if (!allowed || actor.context !== 'admin') throw new UnauthorizedException();
            const result = await work(tx);
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: target ? 'admin.detail.read' : 'admin.search.read',
                    target_type: section,
                    target_id: target ?? actor.id,
                    effective_at: new Date(),
                    recorded_at: new Date(),
                    reason: null,
                    before_redacted: null,
                    after_redacted: null,
                    request_id: uuid.safeParse(requestId).success ? requestId : randomUUID(),
                    actor_id: actor.id,
                    scope_id: null,
                })
                .execute();
            return result;
        });
    }
    async search(section: AdminSection, input: AdminSearch, actor: Principal, requestId: string) {
        if (input.queue && section !== 'queues') throw new BadRequestException();
        const binding = cursorBinding(section, input, actor);
        const after = decodeAdminCursor(input.cursor, binding);
        return this.run(actor, section, undefined, requestId, async (tx) => {
            if (section === 'overview') return this.overview(tx, actor);
            const source = adminSources[section];
            if (source.requiresQuery && !input.query)
                return {
                    section,
                    availability: 'requires_query' as const,
                    reason: 'Введите точный ID или логин пользователя; для подписки — ID подписки или владельца.',
                    items: [],
                    nextCursor: null,
                };
            const conditions = [sql`true`];
            if (input.queue === 'recipes') conditions.push(sql`kind = 'recipe'`);
            if (after) conditions.push(sql`id > ${after}::uuid`);
            if (input.status) {
                if (!source.status) throw new BadRequestException('Status filter is not supported by this section');
                conditions.push(sql`${sql.ref(source.status)} = ${input.status}`);
            }
            if (input.query) {
                if (section === 'users' || section === 'access') {
                    if (uuid.safeParse(input.query).success) conditions.push(sql`id = ${input.query}::uuid`);
                    else if (/^[A-Za-z0-9_]{3,30}$/.test(input.query))
                        conditions.push(sql`lower(login) = ${input.query.toLowerCase()}`);
                    else throw new BadRequestException('Use an exact user ID or login');
                } else if (section === 'subscriptions') {
                    if (!uuid.safeParse(input.query).success)
                        throw new BadRequestException('Use an exact subscription or owner ID');
                    conditions.push(sql`(id = ${input.query}::uuid or owner_id = ${input.query}::uuid)`);
                } else if (uuid.safeParse(input.query).success) conditions.push(sql`id = ${input.query}::uuid`);
                else
                    conditions.push(
                        sql`strpos(lower(${sql.ref(source.title)}::text), ${input.query.toLowerCase()}) > 0`,
                    );
            }
            const columns = [
                ...new Set([
                    'id',
                    'version',
                    ...(section === 'errors' || section === 'metrics' ? [] : ['created_at']),
                    source.title,
                    ...(source.status ? [source.status] : []),
                    ...source.fields.map(([key]) => key),
                    ...(source.related ?? []).map(([key]) => key),
                ]),
            ];
            const limit = input.limit ?? 25;
            const result =
                await sql<Row>`select ${sql.join(columns.map((column) => sql.ref(column)))} from ${sql.table(`meal.${source.table}`)} where ${sql.join(conditions, sql` and `)} order by id limit ${limit + 1}`.execute(
                    tx,
                );
            const page = result.rows.slice(0, limit);
            const last = page.at(-1);
            return {
                section,
                availability: 'available' as const,
                reason: source.note ?? null,
                items: page.map((row) => projectAdminRecord(section, row)),
                nextCursor:
                    result.rows.length > limit && last
                        ? Buffer.from(JSON.stringify({ id: last.id, binding })).toString('base64url')
                        : null,
            };
        });
    }
    async detail(section: AdminSection, id: string, actor: Principal, requestId: string) {
        if (section === 'overview') throw new NotFoundException();
        return this.run(actor, section, id, requestId, async (tx) => {
            const source = adminSources[section];
            const columns = [
                ...new Set([
                    'id',
                    'version',
                    ...(section === 'errors' || section === 'metrics' ? [] : ['created_at']),
                    source.title,
                    ...(source.status ? [source.status] : []),
                    ...source.fields.map(([key]) => key),
                    ...(source.related ?? []).map(([key]) => key),
                ]),
            ];
            const result =
                await sql<Row>`select ${sql.join(columns.map((column) => sql.ref(column)))} from ${sql.table(`meal.${source.table}`)} where id = ${id}::uuid limit 1`.execute(
                    tx,
                );
            const row = result.rows[0];
            if (!row) throw new NotFoundException();
            const item = projectAdminRecord(section, row);
            if (section === 'news') {
                const metadata = await sql<{
                    page_count: number | null;
                }>`select case when jsonb_typeof(pages)='array' then jsonb_array_length(pages) else null end as page_count from meal.announcements where id=${id}::uuid`.execute(
                    tx,
                );
                item.fields.push({
                    key: 'pageCount',
                    label: 'Количество страниц',
                    value: metadata.rows[0]?.page_count == null ? null : String(metadata.rows[0].page_count),
                });
            }
            if (section === 'access') {
                const roles = await tx
                    .selectFrom('staff_role_assignments')
                    .select(['role', 'revoked_at'])
                    .where('user_id', '=', id)
                    .execute();
                item.fields.push(
                    {
                        key: 'activeStaffRoles',
                        label: 'Действующие служебные роли',
                        value:
                            [...new Set(roles.filter((role) => !role.revoked_at).map((role) => role.role))]
                                .sort()
                                .join(', ') || 'Нет действующих ролей',
                    },
                    {
                        key: 'revokedStaffRoleCount',
                        label: 'Отозванных назначений ролей',
                        value: String(roles.filter((role) => role.revoked_at).length),
                    },
                );
            }
            if (section === 'payments') {
                const count = await tx
                    .selectFrom('payment_attempts')
                    .select((eb) => eb.fn.countAll<string>().as('count'))
                    .where('order_id', '=', id)
                    .executeTakeFirstOrThrow();
                const latest = await tx
                    .selectFrom('payment_attempts')
                    .select(['status', 'created_at'])
                    .where('order_id', '=', id)
                    .orderBy('created_at', 'desc')
                    .orderBy('id', 'desc')
                    .limit(1)
                    .executeTakeFirst();
                item.fields.push(
                    { key: 'paymentAttemptCount', label: 'Попыток оплаты', value: String(count.count) },
                    { key: 'latestPaymentStatus', label: 'Статус последней попытки', value: latest?.status ?? null },
                    {
                        key: 'latestPaymentAt',
                        label: 'Последняя попытка',
                        value: latest?.created_at.toISOString() ?? null,
                    },
                );
            }
            return { section, item, collections: relatedCollections(section) };
        });
    }
    async related(
        section: AdminSection,
        id: string,
        collection: string,
        input: AdminRelatedSearch,
        actor: Principal,
        requestId: string,
    ) {
        const source = Object.hasOwn(adminRelatedSources[section] ?? {}, collection)
            ? adminRelatedSources[section]?.[collection]
            : undefined;
        if (!source || section === 'overview') throw new NotFoundException();
        const binding = createHash('sha256')
            .update(JSON.stringify([section, id, collection, input.limit ?? 25, actor.id, actor.sessionId]))
            .digest('hex');
        const after = decodeAdminCursor(input.cursor, binding);
        return this.run(actor, section, id, requestId, async (tx) => {
            const parent = await sql<{
                id: string;
            }>`select id from ${sql.table(`meal.${adminSources[section].table}`)} where id = ${id}::uuid limit 1`.execute(
                tx,
            );
            if (!parent.rows[0]) throw new NotFoundException();
            const columns = [
                ...new Set([
                    'id',
                    'version',
                    'created_at',
                    source.title,
                    ...(source.status ? [source.status] : []),
                    ...source.fields.map(([key]) => key),
                ]),
            ];
            const limit = input.limit ?? 25;
            const result =
                await sql<Row>`select ${sql.join(columns.map((column) => sql.ref(column)))} from ${sql.table(`meal.${source.table}`)} where (${source.predicate(id)}) ${after ? sql`and id > ${after}::uuid` : sql``} order by id limit ${limit + 1}`.execute(
                    tx,
                );
            const rows = result.rows.slice(0, limit);
            return {
                items: rows.map((row) =>
                    adminRecordSchema.parse({
                        id: row.id,
                        title: value(row[source.title] ?? null) ?? String(row.id),
                        status: source.status ? value(row[source.status] ?? null) : null,
                        updatedAt: null,
                        version: String(row.version ?? '1'),
                        fields: [
                            { key: 'createdAt', label: 'Создано', value: value(row.created_at ?? null) },
                            ...source.fields.map(([key, label]) => ({ key, label, value: value(row[key] ?? null) })),
                        ],
                        related: [],
                        actions: [],
                    }),
                ),
                nextCursor:
                    result.rows.length > limit && rows.at(-1)
                        ? Buffer.from(JSON.stringify({ id: rows.at(-1)!.id, binding })).toString('base64url')
                        : null,
            };
        });
    }
    private async overview(tx: Tx, actor: Principal) {
        const result = await sql<Record<string, string>>`select
            (select count(*)::text from meal.support_tickets where status='waiting_for_support') as support_waiting,
            (select count(*)::text from meal.moderation_cases where status='pending') as moderation_pending,
            (select count(*)::text from meal.support_tickets where assignee_id=${actor.id}::uuid) as assigned_support,
            (select count(*)::text from meal.moderation_cases where assigned_to=${actor.id}::uuid) as assigned_moderation,
            (select count(*)::text from meal.background_jobs where status='failed') as jobs_failed,
            (select count(*)::text from meal.background_jobs where status='running') as jobs_running,
            (select count(*)::text from meal.billing_orders where status='pending') as orders_pending,
            (select count(*)::text from meal.payment_attempts where status='failed') as attempts_failed`.execute(tx);
        const counts = result.rows[0];
        const blocks = [
            {
                title: 'Требуют внимания',
                fields: [
                    ['support_waiting', 'Ожидают ответа поддержки'],
                    ['moderation_pending', 'Ожидают проверки'],
                ],
            },
            {
                title: 'Назначено мне',
                fields: [
                    ['assigned_support', 'Мои обращения, включая завершённые'],
                    ['assigned_moderation', 'Мои проверки, включая завершённые'],
                ],
            },
            {
                title: 'Система',
                fields: [
                    ['jobs_failed', 'Задачи с ошибкой'],
                    ['jobs_running', 'Задачи выполняются'],
                ],
            },
            {
                title: 'Платежи',
                fields: [
                    ['orders_pending', 'Заказы в ожидании'],
                    ['attempts_failed', 'Неудачные попытки оплаты'],
                ],
            },
        ];
        const items: AdminRecord[] = blocks.map((block, index) => ({
            id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            title: block.title,
            status: null,
            updatedAt: null,
            version: '1',
            fields: block.fields.map(([key, label]) => ({ key: key!, label: label!, value: counts?.[key!] ?? null })),
            related: [],
            actions: [],
        }));
        return {
            section: 'overview' as const,
            availability: 'available' as const,
            reason: 'Счётчики рассчитаны по сохранённым данным. Назначения включают завершённые записи.',
            items,
            nextCursor: null,
        };
    }
}
