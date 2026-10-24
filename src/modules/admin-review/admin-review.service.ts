import {
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { AdminAccessService } from '../admin-auth/admin-access.service.js';
import type { Principal } from '../auth/auth.service.js';
import { reviewExecuteSchema, reviewResultSchema, type ReviewResult } from './admin-review.contracts.js';
import { AdminRollbackRegistry } from './admin-rollback.registry.js';

type Section = 'legal-requests' | 'rollback';
const blockerSchema = z.strictObject({
    code: z.string(),
    message: z.string(),
    blocksFinalization: z.boolean(),
});
const object = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const evidenceText = (value: unknown) => {
    if (typeof value === 'string') return value;
    const data = object(value);
    return typeof data?.reason === 'string'
        ? data.reason
        : typeof data?.message === 'string'
          ? data.message
          : 'Событие подтверждено серверным процессом.';
};
const previewKey = (view: ReviewResult) =>
    createHash('sha256')
        .update(
            JSON.stringify({
                section: view.section,
                id: view.id,
                version: view.version,
                identityVerified: view.identityVerified,
                dependencies: view.dependencies,
                items: view.items,
            }),
        )
        .digest('base64url');

export function canApplyPreviewedRollbackItem(
    previewedReadyIds: ReadonlySet<string>,
    item: { id: string; status: string },
    inspection: { supported: boolean; ready: boolean },
) {
    return item.status !== 'applied' && previewedReadyIds.has(item.id) && inspection.supported && inspection.ready;
}

@Injectable()
export class AdminReviewService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: AdminAccessService,
        private readonly rollbackRegistry: AdminRollbackRegistry,
    ) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    private async assertAdmin(tx: Parameters<Parameters<DatabaseService['transaction']>[0]>[0], actor: Principal) {
        const role = await tx
            .selectFrom('staff_role_assignments')
            .select('id')
            .where('user_id', '=', actor.id)
            .where('role', '=', 'admin')
            .where('revoked_at', 'is', null)
            .executeTakeFirst();
        if (!role) throw new ForbiddenException();
        await this.access.assertCritical(tx, actor);
    }

    private async loadRaw(section: Section, id: string): Promise<ReviewResult> {
        const db = await this.db();
        if (section === 'legal-requests') {
            const request = await sql<{
                id: string;
                status: string;
                user_id: string;
                version: string;
                blocker_snapshot: unknown;
                export_id: string | null;
            }>`select id,status,user_id,version,blocker_snapshot,export_id from meal.legal_requests where id=${id}::uuid`.execute(
                db,
            );
            const row = request.rows[0];
            if (!row) throw new NotFoundException();
            const steps = await sql<{
                kind: string;
                status: string;
                evidence: unknown;
                approved_by: string | null;
                at: Date;
            }>`select kind,status,evidence,approved_by,coalesce(completed_at,created_at) at from meal.legal_request_steps
                where request_id=${id}::uuid order by created_at,id`.execute(db);
            const identity = steps.rows.find(
                (step) => step.kind === 'identity' && ['completed', 'verified', 'approved'].includes(step.status),
            );
            const blockers = z.array(blockerSchema).safeParse(row.blocker_snapshot);
            const exportRow = row.export_id
                ? await sql<{
                      id: string;
                      status: string;
                      expires_at: Date | null;
                      manifest: unknown;
                  }>`select id,status,expires_at,manifest
                    from meal.export_jobs where id=${row.export_id}::uuid`.execute(db)
                : { rows: [] };
            const exported = exportRow.rows[0];
            const manifest = object(exported?.manifest);
            const exportManifest = object(manifest?.exportManifest);
            const sections = Array.isArray(exportManifest?.sections)
                ? exportManifest.sections.flatMap((entry) => {
                      const item = object(entry);
                      return typeof item?.label === 'string' ? [item.label] : [];
                  })
                : [];
            const related = await sql<{
                id: string;
                kind: string;
                status: string;
            }>`select id,kind,status from meal.legal_requests
                where user_id=${row.user_id}::uuid and id<>${id}::uuid order by requested_at desc,id desc limit 5`.execute(
                db,
            );
            return reviewResultSchema.parse({
                section,
                id,
                version: Number(row.version),
                status: row.status,
                requesterId: row.user_id,
                identityVerified: !!identity,
                identityEvidence: identity ? evidenceText(identity.evidence) : null,
                dependencies: blockers.success
                    ? blockers.data.map((blocker) => ({
                          label: blocker.code,
                          state: blocker.blocksFinalization ? 'blocked' : 'info',
                          detail: blocker.message,
                      }))
                    : [],
                exportData:
                    exported?.expires_at && ['ready', 'expired'].includes(exported.status)
                        ? {
                              id: exported.id,
                              expiresAt: exported.expires_at.toISOString(),
                              status:
                                  exported.status === 'expired' || exported.expires_at <= new Date()
                                      ? 'expired'
                                      : 'ready',
                              sections,
                          }
                        : null,
                items: [],
                history: steps.rows.map((step) => ({
                    action: `${step.kind}.${step.status}`,
                    reason: evidenceText(step.evidence),
                    actor: step.approved_by ?? 'system',
                    at: step.at.toISOString(),
                })),
                previewKey: null,
                message: '',
                relatedRequests: related.rows.map((item) => ({
                    id: item.id,
                    label: `${item.kind} · ${item.status}`,
                })),
            });
        }
        const request = await sql<{
            id: string;
            status: string;
            version: string;
            requested_by: string;
        }>`select id,status,version,requested_by from meal.compensation_requests where id=${id}::uuid`.execute(db);
        const row = request.rows[0];
        if (!row) throw new NotFoundException();
        const items = await sql<{
            id: string;
            status: string;
            source_event_id: string;
            dependency_snapshot: unknown;
            result: unknown;
            version: string;
        }>`select id,status,source_event_id,dependency_snapshot,result,version from meal.compensation_items
            where request_id=${id}::uuid order by created_at,id`.execute(db);
        const history = await sql<{
            action: string;
            reason: string | null;
            actor_id: string | null;
            at: Date;
        }>`select action,reason,actor_id,recorded_at at
            from meal.audit_events where target_id=${id}::uuid and target_type in('rollback','compensation')
            order by recorded_at,id`.execute(db);
        return reviewResultSchema.parse({
            section,
            id,
            version: Number(row.version),
            status: row.status,
            requesterId: row.requested_by,
            identityVerified: true,
            identityEvidence: null,
            dependencies: [],
            exportData: null,
            items: await Promise.all(
                items.rows.map(async (item) => {
                    const inspection = await this.rollbackRegistry.inspect(db, item.dependency_snapshot);
                    const result = object(item.result);
                    const state =
                        item.status === 'applied'
                            ? 'applied'
                            : !inspection.supported
                              ? 'blocked'
                              : inspection.ready
                                ? 'ready'
                                : 'conflict';
                    return {
                        id: item.id,
                        targetId: inspection.targetId,
                        before: inspection.before,
                        after: inspection.after,
                        current: inspection.current,
                        expectedVersion: inspection.expectedVersion,
                        actualVersion: inspection.actualVersion,
                        state,
                        reason: typeof result?.message === 'string' ? result.message : inspection.reason,
                    };
                }),
            ),
            history: history.rows.map((entry) => ({
                action: entry.action,
                reason: entry.reason ?? 'Причина не указана',
                actor: entry.actor_id ?? 'system',
                at: entry.at.toISOString(),
            })),
            previewKey: null,
            message: '',
            relatedRequests: [],
        });
    }

    private async audit(actor: Principal, requestId: string, section: Section, id: string, action: string) {
        await this.database.transaction(async (tx) => {
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action,
                    target_type: section,
                    target_id: id,
                    effective_at: new Date(),
                    recorded_at: new Date(),
                    reason: null,
                    before_redacted: null,
                    after_redacted: null,
                    request_id: requestId,
                    actor_id: actor.id,
                    scope_id: null,
                })
                .execute();
        });
    }

    async load(section: Section, id: string, actor: Principal, requestId: string): Promise<ReviewResult> {
        const view = await this.loadRaw(section, id);
        await this.audit(actor, requestId, section, id, 'admin.review.read');
        return view;
    }

    async preview(section: Section, id: string, version: number, actor: Principal, requestId: string) {
        const view = await this.loadRaw(section, id);
        if (view.version !== version) throw new ConflictException('Запрос изменился. Обновите данные.');
        const result = reviewResultSchema.parse({ ...view, previewKey: previewKey(view) });
        await this.audit(actor, requestId, section, id, 'admin.review.previewed');
        return result;
    }

    prepareExport(section: Section): never {
        if (section !== 'legal-requests') throw new ConflictException('Команда недоступна для раздела');
        throw new ServiceUnavailableException({
            code: 'EXPORT_STORAGE_UNAVAILABLE',
            message: 'Подготовка архива недоступна до подключения защищённого хранилища.',
        });
    }

    async applyRollback(
        section: Section,
        id: string,
        raw: unknown,
        actor: Principal,
        requestId: string,
    ): Promise<ReviewResult> {
        if (section !== 'rollback') throw new ConflictException('Команда недоступна для раздела');
        const input = reviewExecuteSchema.parse(raw);
        const requestHash = createHash('sha256').update(JSON.stringify({ section, id, input })).digest('hex');
        const db = await this.db();
        const prior = await db
            .selectFrom('idempotency_records')
            .select('request_hash')
            .where('actor_namespace', '=', `admin:${actor.id}`)
            .where('operation', '=', 'admin.review.apply-rollback')
            .where('key', '=', input.idempotencyKey)
            .executeTakeFirst();
        if (prior) {
            if (prior.request_hash !== requestHash) throw new ConflictException('Ключ команды уже использован');
            await this.database.transaction((tx) => this.assertAdmin(tx, actor));
            const replayed = await this.loadRaw(section, id);
            return reviewResultSchema.parse({ ...replayed, message: 'Команда уже была применена.' });
        }
        const view = await this.loadRaw(section, id);
        if (view.version !== input.version) throw new ConflictException('Запрос изменился. Обновите данные.');
        if (previewKey(view) !== input.previewKey)
            throw new ConflictException('Последствия изменились. Повторите предпросмотр.');
        const previewedReadyIds = new Set(view.items.filter((item) => item.state === 'ready').map((item) => item.id));
        const replay = await this.database.transaction(async (tx) => {
            await this.assertAdmin(tx, actor);
            const prior = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash'])
                .where('actor_namespace', '=', `admin:${actor.id}`)
                .where('operation', '=', 'admin.review.apply-rollback')
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (prior) {
                if (prior.request_hash !== requestHash) throw new ConflictException('Ключ команды уже использован');
                return true;
            }
            const request = await tx
                .selectFrom('compensation_requests')
                .select(['version'])
                .where('id', '=', id)
                .forUpdate()
                .executeTakeFirst();
            if (!request) throw new NotFoundException();
            if (Number(request.version) !== input.version) throw new ConflictException('Запрос изменился');
            const items = await tx
                .selectFrom('compensation_items')
                .select(['id', 'status', 'dependency_snapshot', 'version'])
                .where('request_id', '=', id)
                .orderBy('created_at')
                .orderBy('id')
                .forUpdate()
                .execute();
            let applied = 0;
            for (const item of items) {
                const inspection = await this.rollbackRegistry.inspect(tx, item.dependency_snapshot);
                if (!canApplyPreviewedRollbackItem(previewedReadyIds, item, inspection)) continue;
                const result = await this.rollbackRegistry.apply(tx, actor, inspection);
                const eventId = randomUUID();
                await tx
                    .insertInto('audit_events')
                    .values({
                        id: eventId,
                        action: `admin.rollback.${result.adapter}`,
                        target_type: 'compensation_item',
                        target_id: item.id,
                        effective_at: new Date(),
                        recorded_at: new Date(),
                        reason: input.reason,
                        before_redacted: result.before as never,
                        after_redacted: result.after as never,
                        request_id: requestId,
                        actor_id: actor.id,
                        scope_id: null,
                    })
                    .execute();
                await tx
                    .updateTable('compensation_items')
                    .set({
                        status: 'applied',
                        result: { adapter: result.adapter, message: 'Компенсирующая операция применена.' },
                        result_event_id: eventId,
                        version: Number(item.version) + 1,
                    })
                    .where('id', '=', item.id)
                    .where('version', '=', item.version)
                    .executeTakeFirstOrThrow();
                applied++;
            }
            if (!applied) throw new ConflictException('Нет элементов, которые можно безопасно компенсировать.');
            const remaining = await sql<{
                count: number;
            }>`select count(*)::int count from meal.compensation_items where request_id=${id}::uuid and status<>'applied'`.execute(
                tx,
            );
            await tx
                .updateTable('compensation_requests')
                .set({
                    status: remaining.rows[0]?.count ? 'partial' : 'completed',
                    reason: input.reason,
                    applied_at: new Date(),
                    version: input.version + 1,
                })
                .where('id', '=', id)
                .where('version', '=', String(input.version))
                .executeTakeFirstOrThrow();
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'admin.review.apply-rollback',
                    target_binding: id,
                    key: input.idempotencyKey,
                    request_hash: requestHash,
                    status: 'completed',
                    response_snapshot: { requestId: id },
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: actor.id,
                    scope_id: null,
                    actor_namespace: `admin:${actor.id}`,
                })
                .execute();
            return false;
        });
        const result = await this.loadRaw(section, id);
        return reviewResultSchema.parse({
            ...result,
            message: replay ? 'Команда уже была применена.' : 'Безопасные элементы компенсированы.',
        });
    }
}
