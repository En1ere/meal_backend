import {
    BadRequestException,
    ConflictException,
    HttpException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { CriticalReauthService } from '../account-lifecycle/critical-reauth.service.js';
import { ProAccessService } from '../pro-overview/pro-access.service.js';
import {
    exportJobSchema,
    exportListSchema,
    exportManifestSchema,
    exportPreviewSchema,
    exportWorkerRunSchema,
    type CreateExport,
    type ExportListQuery,
    type ExportManifest,
    type ExportSelection,
} from './exports.contracts.js';
import { EXPORT_MANIFEST_VERSION, exportDataThrough, isProExportDomain, proExportSections } from './exports.policy.js';

const personalSections = [
    ['identity', 'Аккаунт', 'Логин, имя и подтверждённый адрес.'],
    ['profile', 'Профиль', 'Личные профильные данные.'],
    ['preferences', 'Предпочтения', 'Питание, аллергены, цели и оборудование.'],
    ['consents', 'Согласия', 'История ваших согласий и отзывов.'],
    ['inventory', 'Запасы', 'Личные партии, места и движения.'],
    ['recipes', 'Рецепты', 'Авторские черновики, версии и публикации.'],
    ['cooking', 'Готовка', 'Ваши попытки и прогресс.'],
    ['preserves', 'Заготовки', 'Личные заготовки и контейнеры.'],
    ['meal_plans', 'Планы', 'Личные планы и порции.'],
    ['shopping', 'Покупки', 'Списки, покупки и распознанные данные чеков.'],
    ['notifications', 'Уведомления', 'Настройки и безопасная история уведомлений.'],
    ['community', 'Сообщество', 'Ваши оценки, комментарии, подписки и закладки.'],
    ['support', 'Поддержка', 'Ваши обращения и доступные вам сообщения.'],
    ['ai_history', 'AI', 'Ваши запросы и сохранённые результаты без provider payload.'],
    ['subscription_metadata', 'Подписка', 'Статусы продукта и периоды без платёжных документов.'],
] as const;
const familySections = [
    ['family_profile', 'Семья', 'Название и общие настройки семьи.'],
    ['family_memberships', 'Участники', 'Общая история состава без приватных данных других участников.'],
    ['family_inventory', 'Семейные запасы', 'Общие партии, места и движения.'],
    ['family_recipes', 'Семейные рецепты', 'Доступные семье рецепты и версии.'],
    ['family_preserves', 'Семейные заготовки', 'Общие заготовки и контейнеры.'],
    ['family_meal_plans', 'Семейные планы', 'Общие планы и распределение порций.'],
    ['family_shopping', 'Семейные покупки', 'Общие списки и покупки.'],
    ['family_notes', 'Семейные заметки', 'Общие заметки и история редакций.'],
    ['family_chat', 'Семейный чат', 'Сообщения, доступные заявителю по периоду членства.'],
] as const;
const exclusions = [
    {
        code: 'credentials' as const,
        message: 'Пароли, PIN, MFA-секреты, recovery-коды и session tokens не экспортируются.',
    },
    {
        code: 'internal_audit' as const,
        message: 'Внутренний аудит и служебные расследования не входят в пользовательский архив.',
    },
    { code: 'payment_documents' as const, message: 'Платёжные документы выдаются отдельным регулируемым процессом.' },
    {
        code: 'binary_assets' as const,
        message:
            'Без защищённого object storage бинарные оригиналы недоступны; manifest сохраняет только разрешённые метаданные.',
    },
];
const storedManifestSchema = z.strictObject({
    exportManifest: exportManifestSchema,
    completedAt: z.iso.datetime().nullable().default(null),
    failureCode: z.enum(['generation_failed', 'storage_unavailable', 'access_revoked']).nullable().default(null),
    idempotencyKey: z.uuid(),
});
const cursorSchema = z.strictObject({ requestedAt: z.iso.datetime(), id: z.uuid() });
type Row = { id: string; status: string; manifest: unknown; requestedAt: Date; expiresAt: Date | null };
const decode = (value: string) => {
    try {
        return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    } catch {
        throw new BadRequestException('Некорректный cursor');
    }
};
const encode = (requestedAt: string, id: string) =>
    Buffer.from(JSON.stringify({ requestedAt, id })).toString('base64url');

@Injectable()
export class ExportsService {
    constructor(
        private readonly database: DatabaseService,
        private readonly reauth: CriticalReauthService,
        private readonly proAccess: ProAccessService,
    ) {}
    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    private job(row: Row) {
        const stored = storedManifestSchema.parse(row.manifest);
        const requestedAt = new Date(row.requestedAt).toISOString();
        const expiresAt = row.expiresAt?.toISOString() ?? null;
        const status =
            row.status === 'ready' && expiresAt && Date.parse(expiresAt) <= Date.now() ? 'expired' : row.status;
        return exportJobSchema.parse({
            id: row.id,
            manifest: stored.exportManifest,
            requestedAt,
            status,
            completedAt: stored.completedAt,
            expiresAt,
            failureCode: stored.failureCode,
        });
    }
    private async assertManifestAccess(
        executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
        userId: string,
        manifest: ExportManifest,
        allowReadOnlyPro: boolean,
    ) {
        if (isProExportDomain(manifest.selection.domain)) {
            if (allowReadOnlyPro) await this.proAccess.resolve(userId, executor);
            else await this.proAccess.requireActive(userId, executor);
        }
        if (manifest.selection.scope !== 'family') return;
        const access = await sql<{ ok: boolean }>`
            select exists(
                select 1 from meal.family_memberships membership
                join meal.families family on family.id=membership.family_id
                where membership.user_id=${userId}::uuid
                  and membership.family_id=${manifest.familyId}::uuid
                  and membership.left_at is null
                  and family.archived_at is null
            ) ok
        `.execute(executor);
        if (!access.rows[0]?.ok) throw new HttpException('Доступ к семье изменился', 403);
    }
    async preview(userId: string, selection: ExportSelection) {
        const db = await this.db();
        let scopeId: string | null = null,
            familyId: string | null = null;
        const blockers = [] as Array<{
            code: 'family_membership_required' | 'active_pro_required' | 'service_unavailable';
            message: string;
        }>;
        if (selection.scope === 'private') {
            const scope = await sql<{
                id: string;
            }>`select id from meal.data_scopes where kind='private' and user_id=${userId}::uuid limit 1`.execute(db);
            scopeId = scope.rows[0]?.id ?? null;
        } else {
            const scope = await sql<{
                id: string;
                family_id: string;
            }>`select ds.id,ds.family_id from meal.family_memberships fm join meal.families f on f.id=fm.family_id join meal.data_scopes ds on ds.family_id=f.id and ds.kind='family' where fm.user_id=${userId}::uuid and fm.left_at is null and f.archived_at is null limit 1`.execute(
                db,
            );
            scopeId = scope.rows[0]?.id ?? null;
            familyId = scope.rows[0]?.family_id ?? null;
            if (!scopeId)
                blockers.push({
                    code: 'family_membership_required',
                    message: 'Для семейного экспорта требуется действующее членство.',
                });
        }
        const now = new Date(),
            expiresAt = new Date(now.getTime() + 10 * 60_000);
        let proAccess: {
            modeAtPreview: 'active';
            source: 'personal' | 'family' | 'trial' | 'gift';
            periodEndsAt: string | null;
            dataThrough: string;
            checkedAt: string;
        } | null = null;
        if (isProExportDomain(selection.domain)) {
            try {
                const access = await this.proAccess.requireActive(userId, db);
                if (access.source === 'history') throw new HttpException('Active Pro required', 403);
                proAccess = {
                    modeAtPreview: 'active',
                    source: access.source,
                    periodEndsAt: access.periodEndsAt,
                    dataThrough: exportDataThrough(selection, now, access.periodEndsAt),
                    checkedAt: now.toISOString(),
                };
            } catch (error) {
                if (!(error instanceof HttpException) || error.getStatus() !== 403) throw error;
                blockers.push({
                    code: 'active_pro_required',
                    message:
                        'Новый Pro-экспорт доступен только при активном Pro. Готовая история остаётся доступной для чтения.',
                });
            }
        }
        const tuples = isProExportDomain(selection.domain)
            ? proExportSections(selection.domain)
            : selection.scope === 'private'
              ? personalSections
              : familySections;
        const manifest: ExportManifest | null = blockers.length
            ? null
            : exportManifestSchema.parse({
                  schemaVersion: EXPORT_MANIFEST_VERSION,
                  selection,
                  scopeId,
                  familyId,
                  requesterId: userId,
                  sections: tuples.map(([code, label, detail]) => ({
                      code,
                      label,
                      detail,
                      ownership: selection.scope === 'private' ? 'requester' : 'shared_family',
                  })),
                  exclusions: [
                      ...(selection.scope === 'family'
                          ? [
                                {
                                    code: 'other_members_private_data' as const,
                                    message: 'Личные данные других участников семьи не включаются.',
                                },
                            ]
                          : []),
                      ...exclusions,
                  ],
                  aclSnapshotAt: now.toISOString(),
                  proAccess,
              });
        const id = randomUUID();
        await this.database.transaction(async (tx) => {
            await sql`insert into meal.export_previews(id,user_id,scope_id,selection,manifest,expires_at) values(${id}::uuid,${userId}::uuid,${scopeId}::uuid,${JSON.stringify(selection)}::jsonb,${JSON.stringify(manifest)}::jsonb,${expiresAt})`.execute(
                tx,
            );
        });
        return exportPreviewSchema.parse({
            previewId: id,
            manifest,
            canCreate: !!manifest,
            blockers,
            expiresAt: expiresAt.toISOString(),
        });
    }
    async create(userId: string, sessionId: string, input: CreateExport) {
        return this.database.transaction(async (tx) => {
            await sql`select pg_advisory_xact_lock(hashtextextended(${`export:${userId}:${input.idempotencyKey}`},0))`.execute(
                tx,
            );
            const replay =
                await sql<Row>`select id,status,manifest,requested_at "requestedAt",expires_at "expiresAt" from meal.export_jobs where user_id=${userId}::uuid and idempotency_key=${input.idempotencyKey}::uuid limit 1`.execute(
                    tx,
                );
            if (replay.rows[0]) {
                const job = this.job(replay.rows[0]);
                await this.assertManifestAccess(tx, userId, job.manifest, false);
                return { job };
            }
            await this.reauth.consume(tx, userId, sessionId, input.reauthToken, 'export');
            const preview = await sql<{
                manifest: unknown;
                scope_id: string | null;
                expires_at: Date;
                consumed_at: Date | null;
            }>`select manifest,scope_id,expires_at,consumed_at from meal.export_previews where id=${input.previewId}::uuid and user_id=${userId}::uuid for update`.execute(
                tx,
            );
            const p = preview.rows[0];
            if (!p || p.consumed_at || p.expires_at <= new Date())
                throw new ConflictException('Предпросмотр экспорта истёк');
            const manifest = exportManifestSchema.safeParse(p.manifest);
            if (!manifest.success) throw new ConflictException('Экспорт недоступен');
            await this.assertManifestAccess(tx, userId, manifest.data, false);
            const id = randomUUID(),
                requestedAt = new Date();
            const stored = {
                exportManifest: manifest.data,
                completedAt: null,
                failureCode: null,
                idempotencyKey: input.idempotencyKey,
            };
            await sql`insert into meal.export_jobs(id,kind,format,period,status,manifest,requested_at,user_id,scope_id,idempotency_key) values(${id}::uuid,${manifest.data.selection.domain},${manifest.data.selection.format},${JSON.stringify({ startsOn: manifest.data.selection.startsOn, endsOn: manifest.data.selection.endsOn })},'queued',${JSON.stringify(stored)}::jsonb,${requestedAt},${userId}::uuid,${p.scope_id}::uuid,${input.idempotencyKey}::uuid)`.execute(
                tx,
            );
            await sql`update meal.export_previews set consumed_at=now(),version=version+1 where id=${input.previewId}::uuid`.execute(
                tx,
            );
            return { job: this.job({ id, status: 'queued', manifest: stored, requestedAt, expiresAt: null }) };
        });
    }
    async list(userId: string, query: ExportListQuery) {
        const db = await this.db(),
            cursor = query.cursor ? decode(query.cursor) : null,
            after = cursor ? sql`and (requested_at,id)<(${cursor.requestedAt}::timestamptz,${cursor.id}::uuid)` : sql``;
        const rows =
            await sql<Row>`select id,status,manifest,requested_at "requestedAt",expires_at "expiresAt" from meal.export_jobs where user_id=${userId}::uuid ${after} order by requested_at desc,id desc limit ${query.limit + 1}`.execute(
                db,
            );
        const items = rows.rows.slice(0, query.limit).flatMap((r) => {
                try {
                    return [this.job(r)];
                } catch {
                    return [];
                }
            }),
            last = items.at(-1);
        return exportListSchema.parse({
            items,
            nextCursor: rows.rows.length > query.limit && last ? encode(last.requestedAt, last.id) : null,
        });
    }
    async download(userId: string, id: string) {
        const db = await this.db();
        const row = await sql<{
            status: string;
            expires_at: Date | null;
            file_id: string | null;
            manifest: unknown;
        }>`select status,expires_at,file_id,manifest from meal.export_jobs where id=${id}::uuid and user_id=${userId}::uuid`.execute(
            db,
        );
        if (!row.rows[0]) throw new NotFoundException();
        const stored = storedManifestSchema.parse(row.rows[0].manifest);
        await this.assertManifestAccess(db, userId, stored.exportManifest, true);
        if (row.rows[0].status !== 'ready' || !row.rows[0].expires_at || row.rows[0].expires_at <= new Date())
            throw new ConflictException('Экспорт не готов или срок доступа истёк');
        throw new ServiceUnavailableException({
            code: 'EXPORT_STORAGE_UNAVAILABLE',
            message: 'Защищённое хранилище экспортов не подключено.',
        });
    }
    async runNext(limit = 10) {
        const db = await this.db();
        const ids = await sql<{
            id: string;
        }>`select id from meal.export_jobs where status='queued' order by requested_at,id limit ${limit}`.execute(db);
        let claimedCount = 0;
        let failedClosed = 0;
        for (const row of ids.rows) {
            await this.database.transaction(async (tx) => {
                const claimed = await sql<{
                    manifest: unknown;
                    userId: string;
                }>`update meal.export_jobs set status='processing',version=version+1 where id=${row.id}::uuid and status='queued' returning manifest,user_id "userId"`.execute(
                    tx,
                );
                if (!claimed.rows[0]) return;
                claimedCount++;
                const stored = storedManifestSchema.parse(claimed.rows[0].manifest);
                let failureCode: 'storage_unavailable' | 'access_revoked' = 'storage_unavailable';
                try {
                    await this.assertManifestAccess(tx, claimed.rows[0].userId, stored.exportManifest, true);
                } catch (error) {
                    if (!(error instanceof HttpException) || error.getStatus() !== 403) throw error;
                    failureCode = 'access_revoked';
                }
                const failed = {
                    ...stored,
                    completedAt: new Date().toISOString(),
                    failureCode,
                };
                await sql`update meal.export_jobs set status='failed',manifest=${JSON.stringify(failed)}::jsonb,expires_at=null,version=version+1 where id=${row.id}::uuid and status='processing'`.execute(
                    tx,
                );
                failedClosed++;
            });
        }
        return exportWorkerRunSchema.parse({ claimed: claimedCount, failedClosed });
    }
}
