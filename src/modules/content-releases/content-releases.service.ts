import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { AdminAccessService } from '../admin-auth/admin-access.service.js';
import type { Principal } from '../auth/auth.service.js';
import { LegalConsentService } from '../legal-consents/legal-consent.service.js';
import {
    achievementPayloadSchema,
    contentDocumentPayloadSchema,
    createReleaseSchema,
    dictionaryEntryPayloadSchema,
    legalTextPayloadSchema,
    productDescriptionPayloadSchema,
    authorAchievementsSchema,
    authorReputationSchema,
    publicReputationLevelsSchema,
    releaseCommandSchema,
    releaseDetailSchema,
    releaseHistorySchema,
    releaseListSchema,
    releaseSourcesSchema,
    releasePatchSchema,
    releaseValidateSchema,
    reputationTitlePayloadSchema,
    saveReleaseSchema,
    type ReleaseDetail,
    type ReleasePatch,
} from './content-releases.contracts.js';

type Tx = Transaction<DatabaseSchema>;
type Db = NonNullable<DatabaseService['db']> | Tx;
const iso = (value: Date | string) => new Date(value).toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type Head = { resourceType: string; resourceKey: string; version: number; payload: unknown; retired: boolean };

@Injectable()
export class ContentReleasesService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: AdminAccessService,
        private readonly legalConsents: LegalConsentService,
    ) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    private async idempotent<T>(
        tx: Tx,
        actor: Principal,
        operation: string,
        key: string,
        request: unknown,
        run: () => Promise<T>,
    ) {
        const requestHash = hash(request);
        const prior = await tx
            .selectFrom('idempotency_records')
            .select(['request_hash', 'response_snapshot'])
            .where('actor_namespace', '=', `admin:${actor.id}`)
            .where('operation', '=', operation)
            .where('key', '=', key)
            .executeTakeFirst();
        if (prior) {
            if (prior.request_hash !== requestHash) throw new ConflictException('Ключ команды уже использован');
            return prior.response_snapshot as T;
        }
        const response = await run();
        await tx
            .insertInto('idempotency_records')
            .values({
                id: randomUUID(),
                operation,
                target_binding: 'content-releases',
                key,
                request_hash: requestHash,
                status: 'completed',
                response_snapshot: JSON.parse(JSON.stringify(response)) as never,
                expires_at: sql`'infinity'::timestamptz`,
                user_id: actor.id,
                scope_id: null,
                actor_namespace: `admin:${actor.id}`,
            })
            .execute();
        return response;
    }

    private async heads(db: Db, keys?: Array<{ resourceType: string; resourceKey: string }>) {
        const result =
            await sql<Head>`select resource_type as "resourceType",resource_key as "resourceKey",version::int,payload,retired
            from meal.content_resource_heads
            ${keys?.length ? sql`where (resource_type,resource_key) in (${sql.join(keys.map((item) => sql`(${item.resourceType},${item.resourceKey})`))})` : sql``}`.execute(
                db,
            );
        return result.rows;
    }

    private async row(db: Db, id: string, lock = false) {
        const result = await sql<{
            id: string;
            name: string;
            status: string;
            version: number;
            createdAt: Date;
            updatedAt: Date;
            publishedAt: Date | null;
            sourceReleaseId: string | null;
            rolledBackFromEventId: string | null;
            clientRevision: number | null;
            clientChecksum: string | null;
        }>`
            select id,name,status,version::int,created_at as "createdAt",updated_at as "updatedAt",published_at as "publishedAt",
                   source_release_id as "sourceReleaseId",rolled_back_from_event_id as "rolledBackFromEventId",client_revision::int as "clientRevision",client_checksum as "clientChecksum"
            from meal.content_releases where id=${id}::uuid ${lock ? sql`for update` : sql``}`.execute(db);
        return result.rows[0];
    }

    private async patches(db: Db, id: string) {
        const rows = await sql<{
            id: string;
            resourceType: string;
            action: string;
            resourceKey: string;
            expectedVersion: number;
            payload: unknown;
        }>`
            select id,resource_type as "resourceType",action,resource_key as "resourceKey",expected_version::int as "expectedVersion",payload
            from meal.content_release_patches where release_id=${id}::uuid order by ordinal`.execute(db);
        return rows.rows.map((item) =>
            releasePatchSchema.parse({
                patchId: item.id,
                resourceType: item.resourceType,
                action: item.action,
                resourceKey: item.resourceKey,
                expectedVersion: item.expectedVersion,
                payload: item.payload,
            }),
        );
    }

    private async validation(db: Db, patches: ReleasePatch[], enforceCatalog = true) {
        const errors: string[] = [];
        const conflicts: string[] = [];
        const seen = new Set<string>();
        for (const patch of patches) {
            const binding = `${patch.resourceType}:${patch.resourceKey}`;
            if (seen.has(binding)) errors.push(`Ресурс ${binding} изменяется больше одного раза`);
            seen.add(binding);
            if (
                patch.resourceType === 'achievement' &&
                patch.action !== 'retire' &&
                patch.resourceKey !== patch.payload.code
            )
                errors.push(`Ключ достижения ${patch.resourceKey} не совпадает с code`);
            if (
                patch.resourceType === 'achievement' &&
                patch.action !== 'retire' &&
                !achievementAggregateConditionSchema.safeParse(
                    normalizeAchievementCondition(patch.payload.code, patch.payload.condition),
                ).success
            )
                errors.push(`У достижения ${patch.resourceKey} нет поддерживаемого aggregate condition`);
            if (
                patch.resourceType === 'legal_text' &&
                patch.action !== 'retire' &&
                patch.resourceKey !== patch.payload.kind
            )
                errors.push(`Ключ юридического текста ${patch.resourceKey} не совпадает с kind`);
            if (
                patch.resourceType === 'product_description' &&
                patch.action !== 'retire' &&
                patch.resourceKey !== patch.payload.productId
            )
                errors.push(`Ключ описания продукта ${patch.resourceKey} не совпадает с productId`);
            if (
                patch.resourceType === 'content_document' &&
                patch.action !== 'retire' &&
                (!patch.resourceKey.startsWith(`${patch.payload.namespace}:${patch.payload.locale}:`) ||
                    patch.resourceKey.length <= `${patch.payload.namespace}:${patch.payload.locale}:`.length)
            )
                errors.push(
                    `Ключ документа ${patch.resourceKey} должен содержать непустой ID после ${patch.payload.namespace}:${patch.payload.locale}:`,
                );
            if (
                patch.resourceType === 'dictionary_entry' &&
                patch.action !== 'retire' &&
                patch.resourceKey !== `${patch.payload.dictionary}:${patch.payload.code}`
            )
                errors.push(
                    `Ключ словаря ${patch.resourceKey} должен совпадать с ${patch.payload.dictionary}:${patch.payload.code}`,
                );
        }
        const current = await this.heads(db);
        const byKey = new Map(current.map((item) => [`${item.resourceType}:${item.resourceKey}`, item]));
        for (const patch of patches) {
            const entry = byKey.get(`${patch.resourceType}:${patch.resourceKey}`);
            const version = entry?.version ?? 0;
            if (version !== patch.expectedVersion)
                conflicts.push(
                    `${patch.resourceType}:${patch.resourceKey} ожидался v${patch.expectedVersion}, сейчас v${version}`,
                );
            if (patch.action === 'create' && entry && !entry.retired)
                conflicts.push(`${patch.resourceType}:${patch.resourceKey} уже существует`);
            if (patch.action !== 'create' && (!entry || entry.retired))
                conflicts.push(`${patch.resourceType}:${patch.resourceKey} не существует`);
        }
        const levels = new Map<number, { threshold: number; title: string }>();
        current
            .filter((item) => item.resourceType === 'reputation_title' && !item.retired)
            .forEach((item) => {
                const parsed = reputationTitlePayloadSchema.safeParse(item.payload);
                if (parsed.success) levels.set(parsed.data.level, parsed.data);
            });
        for (const patch of patches)
            if (patch.resourceType === 'reputation_title') {
                if (patch.action === 'retire') {
                    const currentLevel = reputationTitlePayloadSchema.safeParse(
                        byKey.get(`${patch.resourceType}:${patch.resourceKey}`)?.payload,
                    );
                    if (currentLevel.success) levels.delete(currentLevel.data.level);
                } else levels.set(patch.payload.level, patch.payload);
            }
        if (enforceCatalog && levels.size !== 10) errors.push('Каталог репутации должен содержать ровно 10 уровней');
        const ordered = [...levels.entries()].sort(([a], [b]) => a - b);
        if (enforceCatalog && ordered.some(([level], index) => level !== index + 1))
            errors.push('Уровни репутации должны идти от 1 до 10');
        if (enforceCatalog && ordered[0]?.[1].threshold !== 0)
            errors.push('Первый уровень репутации должен начинаться с 0');
        if (
            enforceCatalog &&
            ordered.some((entry, index) => index > 0 && entry[1].threshold <= ordered[index - 1]![1].threshold)
        )
            errors.push('Пороги репутации должны строго возрастать');
        return { valid: !errors.length && !conflicts.length, conflicts, errors };
    }

    private async detailFrom(db: Db, id: string): Promise<ReleaseDetail> {
        const row = await this.row(db, id);
        if (!row) throw new NotFoundException('Релиз не найден');
        const patches = await this.patches(db, id);
        const { clientRevision, clientChecksum, ...release } = row;
        return releaseDetailSchema.parse({
            ...release,
            patchCount: patches.length,
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt),
            publishedAt: row.publishedAt ? iso(row.publishedAt) : null,
            patches,
            validation: await this.validation(db, patches),
            ack: clientRevision && clientChecksum ? { clientRevision, checksum: clientChecksum } : null,
        });
    }

    async list(actor?: Principal) {
        const db = await this.db();
        if (actor) await this.access.assertCapability(db, actor, 'content_releases.read');
        const rows = await sql<{
            id: string;
        }>`select id from meal.content_releases order by updated_at desc,id desc`.execute(db);
        return releaseListSchema.parse({
            items: await Promise.all(
                rows.rows.map(async ({ id }) => {
                    const detail = await this.detailFrom(db, id);
                    return {
                        id: detail.id,
                        name: detail.name,
                        status: detail.status,
                        version: detail.version,
                        patchCount: detail.patchCount,
                        createdAt: detail.createdAt,
                        updatedAt: detail.updatedAt,
                        publishedAt: detail.publishedAt,
                        sourceReleaseId: detail.sourceReleaseId,
                        rolledBackFromEventId: detail.rolledBackFromEventId,
                    };
                }),
            ),
        });
    }
    async detail(id: string, actor?: Principal) {
        const db = await this.db();
        if (actor) await this.access.assertCapability(db, actor, 'content_releases.read');
        return this.detailFrom(db, id);
    }
    async history(actor?: Principal) {
        const db = await this.db();
        if (actor) await this.access.assertCapability(db, actor, 'content_releases.read');
        const rows = await sql<{
            id: string;
            releaseId: string;
            kind: string;
            createdAt: Date;
            snapshot: unknown;
        }>`select id,release_id as "releaseId",kind,created_at as "createdAt",snapshot from meal.content_release_events order by created_at desc,id desc`.execute(
            db,
        );
        return releaseHistorySchema.parse({
            items: rows.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) })),
        });
    }

    async create(actor: Principal, raw: unknown) {
        const input = createReleaseSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.access.assertCapability(tx, actor, 'content_releases.edit');
            return this.idempotent(tx, actor, 'content-release.create', input.idempotencyKey, input, async () => {
                const id = randomUUID();
                await tx
                    .insertInto('content_releases')
                    .values({
                        id,
                        name: input.name,
                        status: 'draft',
                        revision: 1,
                        source_release_id: null,
                        rolled_back_from_event_id: null,
                        created_by: actor.id,
                        published_by: null,
                        published_at: null,
                    })
                    .execute();
                return this.detailFrom(tx, id);
            });
        });
    }

    async save(actor: Principal, id: string, raw: unknown) {
        const input = saveReleaseSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.access.assertCapability(tx, actor, 'content_releases.edit');
            return this.idempotent(
                tx,
                actor,
                'content-release.save',
                input.idempotencyKey,
                { id, ...input },
                async () => {
                    const release = await this.row(tx, id, true);
                    if (!release) throw new NotFoundException('Релиз не найден');
                    if (release.status !== 'draft')
                        throw new ConflictException('Опубликованный релиз нельзя редактировать');
                    if (release.version !== input.expectedVersion) throw new ConflictException('Черновик изменился');
                    const serverChecksum = hash({
                        name: input.name,
                        patches: input.patches,
                        clientRevision: input.clientRevision,
                    });
                    if (serverChecksum !== input.checksum)
                        throw new ConflictException({
                            code: 'CONTENT_RELEASE_CHECKSUM_MISMATCH',
                            expected: serverChecksum,
                        });
                    await sql`delete from meal.content_release_patches where release_id=${id}::uuid`.execute(tx);
                    for (const [ordinal, patch] of input.patches.entries())
                        await tx
                            .insertInto('content_release_patches')
                            .values({
                                id: patch.patchId,
                                release_id: id,
                                ordinal,
                                resource_type: patch.resourceType,
                                action: patch.action,
                                resource_key: patch.resourceKey,
                                expected_version: patch.expectedVersion,
                                payload: patch.payload as never,
                            })
                            .execute();
                    await sql`update meal.content_releases set name=${input.name},client_revision=${input.clientRevision},client_checksum=${input.checksum},updated_at=now(),version=version+1 where id=${id}::uuid`.execute(
                        tx,
                    );
                    return this.detailFrom(tx, id);
                },
            );
        });
    }

    async validate(id: string, raw: unknown, actor?: Principal) {
        const input = releaseValidateSchema.parse(raw);
        const db = await this.db();
        const release = await this.row(db, id);
        if (actor) await this.access.assertCapability(db, actor, 'content_releases.validate');
        if (!release) throw new NotFoundException('Релиз не найден');
        if (release.version !== input.expectedVersion) throw new ConflictException('Черновик изменился');
        return this.detailFrom(db, id);
    }

    private async setHead(tx: Tx, releaseId: string, patch: ReleasePatch) {
        const current = (
            await this.heads(tx, [{ resourceType: patch.resourceType, resourceKey: patch.resourceKey }])
        )[0];
        const nextPayload =
            patch.action === 'retire'
                ? (current?.payload ?? null)
                : patch.resourceType === 'achievement'
                  ? {
                        ...patch.payload,
                        condition: normalizeAchievementCondition(patch.payload.code, patch.payload.condition),
                    }
                  : patch.payload;
        if (current)
            await sql`update meal.content_resource_heads set payload=${JSON.stringify(nextPayload)}::jsonb,retired=${patch.action === 'retire'},published_release_id=${releaseId}::uuid,updated_at=now(),version=version+1 where resource_type=${patch.resourceType} and resource_key=${patch.resourceKey}`.execute(
                tx,
            );
        else
            await sql`insert into meal.content_resource_heads(resource_type,resource_key,payload,retired,published_release_id) values(${patch.resourceType},${patch.resourceKey},${JSON.stringify(nextPayload)}::jsonb,false,${releaseId}::uuid)`.execute(
                tx,
            );
        await this.materialize(tx, releaseId, patch, nextPayload);
    }

    private async materialize(tx: Tx, releaseId: string, patch: ReleasePatch, payload: unknown) {
        if (patch.resourceType === 'achievement') {
            const value = achievementPayloadSchema.parse(payload);
            const revision = await sql<{
                value: number;
            }>`select coalesce(max(revision),0)::int+1 value from meal.achievement_rules where code=${patch.resourceKey}`.execute(
                tx,
            );
            await sql`insert into meal.achievement_rules(id,code,revision,condition,category,enabled,title,description,icon_metadata,reputation_delta,secret,retired_at,published_release_id)
                values(${randomUUID()}::uuid,${value.code},${revision.rows[0]!.value},${JSON.stringify(value.condition)}::jsonb,${value.category},${patch.action !== 'retire'},${value.title},${value.description},${JSON.stringify(value.icon)}::jsonb,${value.reputationDelta},${value.secret},${patch.action === 'retire' ? new Date() : null},${releaseId}::uuid)`.execute(
                tx,
            );
        } else if (patch.resourceType === 'reputation_title') {
            const value = reputationTitlePayloadSchema.parse(payload);
            await sql`insert into meal.reputation_titles(id,level,threshold,title,published_release_id) values(${randomUUID()}::uuid,${value.level},${value.threshold},${value.title},${releaseId}::uuid)
                on conflict(level) do update set threshold=excluded.threshold,title=excluded.title,published_release_id=excluded.published_release_id,updated_at=now(),version=meal.reputation_titles.version+1`.execute(
                tx,
            );
        } else if (patch.resourceType === 'legal_text') {
            const value = legalTextPayloadSchema.parse(payload);
            const bodyHash = createHash('sha256').update(value.content).digest('hex');
            await sql`insert into meal.legal_documents(id,kind,version,body_hash,effective_at,content) values(${randomUUID()}::uuid,${value.kind},(select coalesce(max(version),0)+1 from meal.legal_documents where kind=${value.kind}),${bodyHash},${new Date(value.effectiveAt)},${value.content})`.execute(
                tx,
            );
        } else if (patch.resourceType === 'product_description') {
            const value = productDescriptionPayloadSchema.parse(payload);
            await sql`insert into meal.product_descriptions(product_id,description,published_release_id) values(${value.productId}::uuid,${value.description},${releaseId}::uuid)
                on conflict(product_id) do update set description=excluded.description,published_release_id=excluded.published_release_id,updated_at=now(),version=meal.product_descriptions.version+1`.execute(
                tx,
            );
        } else if (patch.resourceType === 'content_document') {
            contentDocumentPayloadSchema.parse(payload);
        } else {
            dictionaryEntryPayloadSchema.parse(payload);
        }
    }

    private inverse(patches: ReleasePatch[], heads: Head[]) {
        const map = new Map(heads.map((item) => [`${item.resourceType}:${item.resourceKey}`, item]));
        return patches.map((patch): ReleasePatch => {
            const current = map.get(`${patch.resourceType}:${patch.resourceKey}`);
            if (!current)
                return releasePatchSchema.parse({
                    ...patch,
                    patchId: randomUUID(),
                    action: 'retire',
                    expectedVersion: patch.expectedVersion + 1,
                    payload: null,
                });
            return releasePatchSchema.parse({
                ...patch,
                patchId: randomUUID(),
                action: current.retired ? 'retire' : 'update',
                expectedVersion: current.version + 1,
                payload: current.retired ? null : current.payload,
            });
        });
    }

    async publish(actor: Principal, id: string, raw: unknown) {
        const input = releaseCommandSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await sql`select pg_advisory_xact_lock(73821642)`.execute(tx);
            await this.access.assertCapability(tx, actor, 'content_releases.edit');
            await this.access.assertCritical(tx, actor);
            return this.idempotent(
                tx,
                actor,
                'content-release.publish',
                input.idempotencyKey,
                { id, ...input },
                async () => {
                    const release = await this.row(tx, id, true);
                    if (!release) throw new NotFoundException('Релиз не найден');
                    if (release.status !== 'draft' || release.version !== input.expectedVersion)
                        throw new ConflictException('Черновик изменился');
                    const patches = await this.patches(tx, id);
                    const validation = await this.validation(tx, patches);
                    if (!validation.valid)
                        throw new ConflictException({ code: 'CONTENT_RELEASE_INVALID', ...validation });
                    const before = await this.heads(
                        tx,
                        patches.map((item) => ({ resourceType: item.resourceType, resourceKey: item.resourceKey })),
                    );
                    const inverse = this.inverse(patches, before);
                    for (const patch of patches) await this.setHead(tx, id, patch);
                    await this.ensureBaseReputationRules(tx, id);
                    const eventId = randomUUID();
                    await sql`insert into meal.content_release_events(id,release_id,kind,snapshot,inverse_snapshot,created_by) values(${eventId}::uuid,${id}::uuid,'published',${JSON.stringify(patches)}::jsonb,${JSON.stringify(inverse)}::jsonb,${actor.id}::uuid)`.execute(
                        tx,
                    );
                    await sql`update meal.content_releases set status='published',published_by=${actor.id}::uuid,published_at=now(),updated_at=now(),version=version+1 where id=${id}::uuid`.execute(
                        tx,
                    );
                    return this.detailFrom(tx, id);
                },
            );
        });
    }

    async rollback(actor: Principal, id: string, raw: unknown) {
        const input = releaseCommandSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await sql`select pg_advisory_xact_lock(73821642)`.execute(tx);
            await this.access.assertCapability(tx, actor, 'content_releases.edit');
            await this.access.assertCritical(tx, actor);
            return this.idempotent(tx, actor, 'content-release.rollback', input.idempotencyKey, { id, ...input }, () =>
                this.compensatePublishedReleaseIn(tx, actor, id, input.expectedVersion, true),
            );
        });
    }

    /** Registered domain compensator used by both the release screen and the generic rollback workspace. */
    async compensatePublishedReleaseIn(
        tx: Tx,
        actor: Principal,
        id: string,
        expectedVersion: number,
        authorized = false,
    ) {
        if (!authorized) {
            await sql`select pg_advisory_xact_lock(73821642)`.execute(tx);
            await this.access.assertCapability(tx, actor, 'content_releases.edit');
            await this.access.assertCritical(tx, actor);
        }
        const release = await this.row(tx, id, true);
        if (!release) throw new NotFoundException('Релиз не найден');
        if (release.status !== 'published' || release.version !== expectedVersion)
            throw new ConflictException('Релиз изменился');
        const event = await sql<{
            id: string;
            inverse: unknown;
        }>`select id,inverse_snapshot inverse from meal.content_release_events where release_id=${id}::uuid and kind='published' order by created_at desc,id desc limit 1`.execute(
            tx,
        );
        const inverse = zArray(event.rows[0]?.inverse);
        if (!event.rows[0] || !inverse) throw new ConflictException('Снимок отката недоступен');
        const validation = await this.validation(tx, inverse, false);
        if (!validation.valid)
            throw new ConflictException({ code: 'CONTENT_RELEASE_ROLLBACK_CONFLICT', ...validation });
        for (const patch of inverse) await this.setHead(tx, id, patch);
        await this.disableBaseReputationRules(tx, id);
        const rollbackEvent = randomUUID();
        await sql`insert into meal.content_release_events(id,release_id,kind,snapshot,inverse_snapshot,created_by) values(${rollbackEvent}::uuid,${id}::uuid,'rolled_back',${JSON.stringify(inverse)}::jsonb,'[]'::jsonb,${actor.id}::uuid)`.execute(
            tx,
        );
        const original = await this.patches(tx, id);
        const current = await this.heads(tx);
        const versions = new Map(current.map((head) => [`${head.resourceType}:${head.resourceKey}`, head.version]));
        await sql`delete from meal.content_release_patches where release_id=${id}::uuid`.execute(tx);
        for (const [ordinal, patch] of original.entries())
            await tx
                .insertInto('content_release_patches')
                .values({
                    id: randomUUID(),
                    release_id: id,
                    ordinal,
                    resource_type: patch.resourceType,
                    action: patch.action,
                    resource_key: patch.resourceKey,
                    expected_version: versions.get(`${patch.resourceType}:${patch.resourceKey}`) ?? 0,
                    payload: patch.payload as never,
                })
                .execute();
        await sql`update meal.content_releases set status='draft',rolled_back_from_event_id=${rollbackEvent}::uuid,published_by=null,published_at=null,updated_at=now(),revision=revision+1,version=version+1 where id=${id}::uuid`.execute(
            tx,
        );
        return this.detailFrom(tx, id);
    }

    async editFromCurrent(actor: Principal, sourceId: string, raw: unknown) {
        const input = createReleaseSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.access.assertCapability(tx, actor, 'content_releases.edit');
            return this.idempotent(
                tx,
                actor,
                'content-release.edit',
                input.idempotencyKey,
                { sourceId, ...input },
                async () => {
                    const source = await this.row(tx, sourceId);
                    if (!source) throw new NotFoundException('Релиз не найден');
                    const sourcePatches = await this.patches(tx, sourceId);
                    const allHeads = await this.heads(tx);
                    const byKey = new Map(allHeads.map((head) => [`${head.resourceType}:${head.resourceKey}`, head]));
                    const id = randomUUID();
                    await tx
                        .insertInto('content_releases')
                        .values({
                            id,
                            name: input.name,
                            status: 'draft',
                            revision: 1,
                            source_release_id: sourceId,
                            rolled_back_from_event_id: null,
                            created_by: actor.id,
                            published_by: null,
                            published_at: null,
                        })
                        .execute();
                    let ordinal = 0;
                    for (const sourcePatch of sourcePatches) {
                        const current = byKey.get(`${sourcePatch.resourceType}:${sourcePatch.resourceKey}`);
                        if (!current || current.retired) continue;
                        await tx
                            .insertInto('content_release_patches')
                            .values({
                                id: randomUUID(),
                                release_id: id,
                                ordinal: ordinal++,
                                resource_type: sourcePatch.resourceType,
                                action: 'update',
                                resource_key: sourcePatch.resourceKey,
                                expected_version: current.version,
                                payload: current.payload as never,
                            })
                            .execute();
                    }
                    return this.detailFrom(tx, id);
                },
            );
        });
    }

    async publicLevels() {
        const rows = await sql<{
            payload: unknown;
        }>`select payload from meal.content_resource_heads where resource_type='reputation_title' and not retired order by (payload->>'level')::int`.execute(
            await this.db(),
        );
        return publicReputationLevelsSchema.parse({
            items: rows.rows.map((row) => reputationTitlePayloadSchema.parse(row.payload)),
        });
    }

    async sources(actor: Principal) {
        const db = await this.db();
        await this.access.assertCapability(db, actor, 'content_releases.read');
        const heads = await this.heads(db);
        const map = <T>(type: string, parser: { parse(value: unknown): T }) =>
            heads
                .filter((head) => head.resourceType === type)
                .map((head) => ({
                    key: head.resourceKey,
                    version: head.version,
                    retired: head.retired,
                    value: parser.parse(head.payload),
                }));
        const products = await sql<{
            id: string;
            name: string;
            version: number;
            description: string | null;
        }>`select p.id,p.name,coalesce(d.version,0)::int version,d.description from meal.brand_products p left join meal.product_descriptions d on d.product_id=p.id where p.status in ('active','approved','published') order by p.name,p.id limit 5000`.execute(
            db,
        );
        return releaseSourcesSchema.parse({
            achievements: map('achievement', achievementPayloadSchema),
            reputationTitles: map('reputation_title', reputationTitlePayloadSchema),
            legalTexts: map('legal_text', legalTextPayloadSchema),
            products: products.rows,
            contentDocuments: map('content_document', contentDocumentPayloadSchema),
            dictionaryEntries: map('dictionary_entry', dictionaryEntryPayloadSchema),
        });
    }

    private async ensureBaseReputationRules(tx: Tx, releaseId: string) {
        const rules = [
            {
                code: 'published-own-recipe',
                points: 5,
                perSubjectCap: 20,
                condition: { event: 'recipe.published', author: 'self' },
            },
            {
                code: 'accepted-content-correction',
                points: 2,
                perSubjectCap: 20,
                condition: { event: 'catalog.correction.accepted', substantive: true },
            },
            {
                code: 'first-independent-cook',
                points: 1,
                perSubjectCap: 20,
                condition: { event: 'recipe.cooked', firstForUserAndRecipe: true, independent: true },
            },
        ];
        for (const rule of rules) {
            const latest = await sql<{
                revision: number;
                enabled: boolean;
            }>`select revision,enabled from meal.reputation_rule_versions where code=${rule.code} order by revision desc limit 1`.execute(
                tx,
            );
            if (!latest.rows[0]?.enabled)
                await sql`insert into meal.reputation_rule_versions(id,code,revision,points,per_subject_cap,condition,enabled,published_release_id)
                values(${randomUUID()}::uuid,${rule.code},${(latest.rows[0]?.revision ?? 0) + 1},${rule.points},${rule.perSubjectCap},${JSON.stringify(rule.condition)}::jsonb,true,${releaseId}::uuid)`.execute(
                    tx,
                );
        }
    }

    private async disableBaseReputationRules(tx: Tx, releaseId: string) {
        const rows = await sql<{
            code: string;
            revision: number;
            points: number;
            cap: number | null;
            condition: unknown;
            releaseId: string;
            enabled: boolean;
        }>`select distinct on(code) code,revision,points,per_subject_cap cap,condition,published_release_id as "releaseId",enabled
            from meal.reputation_rule_versions order by code,revision desc`.execute(tx);
        for (const rule of rows.rows) {
            if (!rule.enabled || rule.releaseId !== releaseId) continue;
            await sql`insert into meal.reputation_rule_versions(id,code,revision,points,per_subject_cap,condition,enabled,published_release_id)
                values(${randomUUID()}::uuid,${rule.code},${rule.revision + 1},${rule.points},${rule.cap},${JSON.stringify(rule.condition)}::jsonb,false,${releaseId}::uuid)`.execute(
                tx,
            );
        }
    }

    async recordReputationEvent(
        userId: string,
        code: string,
        subjectKey: string,
        qualifyingEventKey: string,
        evidence: Record<string, unknown>,
    ) {
        return this.database.transaction((tx) =>
            this.recordReputationEventIn(tx, userId, code, subjectKey, qualifyingEventKey, evidence),
        );
    }

    async recordReputationEventIn(
        tx: Tx,
        userId: string,
        code: string,
        subjectKey: string,
        qualifyingEventKey: string,
        evidence: Record<string, unknown>,
    ) {
        const rule = await sql<{
            revision: number;
            points: number;
            cap: number | null;
            enabled: boolean;
        }>`select revision,points,per_subject_cap cap,enabled from meal.reputation_rule_versions where code=${code} order by revision desc limit 1`.execute(
            tx,
        );
        const current = rule.rows[0];
        // Content configuration must never block moderation/cooking. Until the first rules release there is no accrual.
        if (!current?.enabled) return { eventId: null, created: false };
        const ruleVersion = `${code}:${current.revision}`;
        const prior = await sql<{
            id: string;
            activeId: string;
            activeDelta: number;
        }>`select original.id,active.id "activeId",active.delta::int "activeDelta" from meal.reputation_events original
            join lateral (select current.id,current.delta from meal.reputation_events current
                where current.user_id=original.user_id and current.evidence->>'qualifyingEventKey'=${qualifyingEventKey}
                  and not exists(select 1 from meal.reputation_events next where next.reverses_id=current.id)
                order by current.recorded_at desc,current.id desc limit 1) active on true
            where original.user_id=${userId}::uuid
              and original.evidence->>'qualifyingEventKey'=${qualifyingEventKey} and original.reverses_id is null`.execute(
            tx,
        );
        const priorEvent = prior.rows[0];
        if (priorEvent && priorEvent.activeDelta > 0) return { eventId: priorEvent.activeId, created: false };
        if (current.cap !== null) {
            const total = await sql<{
                value: number;
            }>`select coalesce(sum(delta),0)::int value from meal.reputation_events where user_id=${userId}::uuid and evidence->>'subjectKey'=${subjectKey}`.execute(
                tx,
            );
            if ((total.rows[0]?.value ?? 0) + current.points > current.cap) return { eventId: null, created: false };
        }
        const id = randomUUID();
        await sql`insert into meal.reputation_events(id,delta,rule_version,reason,evidence,recorded_at,user_id,reverses_id)
                values(${id}::uuid,${current.points},${ruleVersion},${code},${JSON.stringify({ ...evidence, subjectKey, qualifyingEventKey })}::jsonb,now(),${userId}::uuid,${priorEvent?.activeId ?? null}::uuid)`.execute(
            tx,
        );
        return { eventId: id, created: true };
    }

    async processAchievementEventIn(tx: Tx, userId: string, event: string, evidence: Record<string, unknown>) {
        await this.evaluateAchievementsIn(tx, userId, { event, ...evidence });
    }

    async evaluateAchievementsIn(tx: Tx, userId: string, evidence: Record<string, unknown> = {}) {
        const rules = await sql<{
            id: string;
            code: string;
            condition: unknown;
        }>`select distinct on(code) id,code,condition from meal.achievement_rules where enabled and retired_at is null order by code,revision desc`.execute(
            tx,
        );
        if (!rules.rows.length) return { evaluated: 0, awarded: 0 };
        const metrics = await this.achievementMetrics(tx, userId);
        let awarded = 0;
        for (const rule of rules.rows) {
            const condition = achievementAggregateConditionSchema.safeParse(rule.condition);
            if (!condition.success || !achievementReached(condition.data, metrics)) continue;
            const result =
                await sql`insert into meal.achievement_awards(id,achievement_key,awarded_at,revoked_at,evidence,user_id,rule_id)
                values(${randomUUID()}::uuid,${rule.code},now(),null,${JSON.stringify({ evaluator: 'aggregate-v1', metrics, ...evidence })}::jsonb,${userId}::uuid,${rule.id}::uuid)
                on conflict(user_id,achievement_key) do nothing returning id`.execute(tx);
            awarded += result.rows.length;
        }
        return { evaluated: rules.rows.length, awarded };
    }

    private async achievementMetrics(tx: Tx, userId: string): Promise<AchievementMetrics> {
        const result = await sql<AchievementMetrics>`
          with cooked as (
            select ca.id,ca.completed_at,rr.recipe_id,lower(coalesce(rr.category,'')) category,coalesce(rr.tags,'{}'::text[]) tags,
              ca.recipe_snapshot,exists(select 1 from meal.cooking_inputs ci join meal.inventory_batches ib on ib.id=ci.batch_id where ci.attempt_id=ca.id and ib.kind in('prepared','preserve')) used_leftover
            from meal.cooking_attempts ca left join meal.recipe_revisions rr on rr.id=ca.revision_id
            where ca.actor_id=${userId}::uuid and ca.status='completed' and ca.completed_at is not null
          ), published as (
            select distinct on(r.id) r.id,rr.id revision_id,lower(coalesce(rr.category,'')) category,coalesce(rr.tags,'{}'::text[]) tags,rr.description,rr.image_url,
              exists(select 1 from meal.recipe_ingredients ri where ri.revision_id=rr.id) has_ingredients,
              exists(select 1 from meal.recipe_steps rs where rs.revision_id=rr.id) has_steps
            from meal.recipes r join meal.recipe_revisions rr on rr.recipe_id=r.id join meal.recipe_publications rp on rp.revision_id=rr.id
            where r.author_id=${userId}::uuid and rp.unpublished_at is null and rp.published_at<=now()
            order by r.id,rp.published_at desc,rp.id desc
          ), independent as (
            select rr.recipe_id,count(distinct ca.actor_id)::int cooks from meal.cooking_attempts ca join meal.recipe_revisions rr on rr.id=ca.revision_id
            join meal.recipes r on r.id=rr.recipe_id where r.author_id=${userId}::uuid and ca.actor_id<>${userId}::uuid and ca.status='completed' group by rr.recipe_id
          ), family_ids as (
            select fm.family_id from meal.family_memberships fm where fm.user_id=${userId}::uuid and fm.left_at is null
          )
          select
            (select count(*)::int from cooked) "cookCount",
            (select count(distinct recipe_id)::int from cooked where recipe_id is not null) "distinctRecipes",
            (select count(distinct recipe_id)::int from cooked where category like '%breakfast%' or 'breakfast'=any(tags)) "breakfastCount",
            (select count(distinct recipe_id)::int from cooked where category like '%soup%' or 'soup'=any(tags)) "soupCount",
            (select count(distinct recipe_id)::int from cooked where category like '%bak%' or 'baking'=any(tags)) "bakingCount",
            (select count(distinct recipe_id)::int from cooked where category like '%dessert%' or 'dessert'=any(tags)) "dessertCount",
            (select count(distinct recipe_id)::int from cooked where 'vegetable'=any(tags)) "vegetableCount",
            (select count(distinct recipe_id)::int from cooked where 'fish'=any(tags)) "fishCount",
            (select count(distinct recipe_id)::int from cooked where 'plant-based'=any(tags) or 'vegan'=any(tags)) "plantCount",
            (select count(distinct tag)::int from cooked cross join lateral unnest(tags) tag where tag like 'cuisine:%') "cuisineCount",
            (select count(*)::int from cooked where used_leftover) "leftoverCount",
            (select count(*)::int from cooked where extract(hour from completed_at at time zone 'Europe/Moscow') between 5 and 9) "earlyCount",
            (select count(*)::int from cooked where extract(hour from completed_at at time zone 'Europe/Moscow') between 0 and 4) "nightCount",
            (select count(*)::int from cooked where recipe_snapshot->>'servings' ~ '^[1-9][0-9]*$') "preciseCount",
            (select count(*)::int from cooked where 'seasonal'=any(tags)) "seasonalCount",
            (select count(*)::int from cooked where 'seasonal'=any(tags) and completed_at>=date_trunc('month',now())) "seasonalMonthCount",
            (select count(*)::int from meal.inventory_batches where created_by=${userId}::uuid) "batchCount",
            (select count(*)::int from meal.inventory_batches where created_by=${userId}::uuid and location_id is not null) "locatedBatchCount",
            (select count(*)::int from meal.inventory_batches where created_by=${userId}::uuid and archived_at is null) "activeBatchCount",
            (select coalesce(current_date-min(created_at::date),0)::int from meal.inventory_batches where created_by=${userId}::uuid and archived_at is null) "activeInventoryDays",
            (select count(*)::int from meal.inventory_batches where created_by=${userId}::uuid and kind='preserve') "preserveCount",
            (select count(distinct pr.id)::int from meal.plan_revisions pr join meal.meal_plans mp on mp.id=pr.plan_id where mp.created_by=${userId}::uuid and pr.status in('accepted','applied','completed')) "planCount",
            (select coalesce(max(days),0)::int from (select count(distinct pe.date) days from meal.plan_revisions pr join meal.meal_plans mp on mp.id=pr.plan_id join meal.plan_entries pe on pe.revision_id=pr.id where mp.created_by=${userId}::uuid group by pr.id)x) "maxPlanDays",
            (select count(*)::int from meal.shopping_lists sl where sl.created_by=${userId}::uuid and sl.status='completed' and exists(select 1 from meal.shopping_items si where si.list_id=sl.id and si.status='purchased')) "shoppingCount",
            (select count(*)::int from meal.shopping_lists sl join meal.data_scopes ds on ds.id=sl.scope_id where sl.created_by=${userId}::uuid and sl.status='completed' and ds.kind='family') "familyShoppingCount",
            (select count(*)::int from meal.receipts where created_by=${userId}::uuid and status in('committed','linked')) "receiptCount",
            (select count(*)::int from published) "publishedCount",
            (select count(*)::int from published where nullif(description,'') is not null and image_url is not null and has_ingredients and has_steps) "completeRecipeCount",
            (select coalesce(max(cooks),0)::int from independent) "maxIndependentCooks",
            (select coalesce(max(count),0)::int from (select count(*) count from published cross join lateral unnest(tags) tag where tag like 'series:%' group by tag)x) "seriesCount",
            (select count(*)::int from meal.recipe_comments rc where rc.author_id=${userId}::uuid and rc.removed_at is null and exists(select 1 from meal.comment_reactions cr where cr.comment_id=rc.id and cr.reaction in('helpful','useful'))) "helpfulCount",
            (select count(*)::int from meal.author_follows where author_id=${userId}::uuid and removed_at is null) "followerCount",
            (select count(*)::int from meal.author_follows where follower_id=${userId}::uuid and removed_at is null) "followingCount",
            (select count(*)::int from meal.reputation_events re where re.user_id=${userId}::uuid and re.reason='accepted-content-correction' and re.delta>0 and not exists(select 1 from meal.reputation_events rev where rev.reverses_id=re.id)) "correctionCount",
            (select count(*)::int from meal.allergen_reports ar where ar.user_id=${userId}::uuid and exists(select 1 from meal.moderation_cases mc join meal.moderation_decisions md on md.case_id=mc.id and md.action='approve' where mc.reporter_id=${userId}::uuid and mc.evidence->>'allergenReportId'=ar.id::text)) "allergenCount",
            (select count(*)::int from meal.catalog_proposals cp where cp.author_id=${userId}::uuid and cp.status='approved' and jsonb_typeof(cp.provenance->'sources')='array' and jsonb_array_length(cp.provenance->'sources')>0) "sourceCount",
            (select count(*)::int from meal.moderation_cases mc join meal.moderation_decisions md on md.case_id=mc.id and md.action='approve' where mc.reporter_id=${userId}::uuid and mc.kind in('recipe_image','product_image','image_improvement')) "photoCount",
            (select count(*)::int from meal.recipe_bookmarks where user_id=${userId}::uuid and removed_at is null) "bookmarkCount",
            (select count(*)::int from meal.cooking_attempts ca join meal.data_scopes ds on ds.id=ca.scope_id where ca.actor_id=${userId}::uuid and ca.status='completed' and ds.kind='family') "familyCookCount",
            (select coalesce(max(member_count),0)::int from (select count(distinct ca.actor_id) member_count from meal.cooking_attempts ca join meal.data_scopes ds on ds.id=ca.scope_id join family_ids f on f.family_id=ds.family_id where ca.status='completed' group by date_trunc('week',ca.completed_at))x) "familyWeeklyCooks",
            (select coalesce(max(days),0)::int from (select count(distinct pe.date) days from meal.plan_entries pe join meal.plan_revisions pr on pr.id=pe.revision_id join meal.meal_plans mp on mp.id=pr.plan_id join meal.data_scopes ds on ds.id=mp.scope_id join family_ids f on f.family_id=ds.family_id group by pr.id)x) "familyPlanDays",
            (select count(*)::int from meal.shopping_items si join meal.shopping_lists sl on sl.id=si.list_id where sl.created_by=${userId}::uuid and si.status in('purchased','completed') and coalesce((si.origin_snapshot->>'holiday')::boolean,false)) "holidayCount",
            (select count(*)::int from meal.cooking_attempts ca where ca.actor_id=${userId}::uuid and ca.status='completed' and coalesce((ca.output_snapshot->>'allInputsUsed')::boolean,false)) "everythingUsedCount",
            (select count(*)::int from meal.inventory_batches ib where ib.created_by=${userId}::uuid and ib.archived_at is null and ib.expiry_on is not null and ib.expiry_on<current_date) "expiredActiveCount"
        `.execute(tx);
        return result.rows[0]!;
    }

    async reverseReputationEvent(eventId: string, reason: string) {
        return this.database.transaction(async (tx) => {
            const original = await sql<{
                id: string;
                userId: string;
                delta: number;
                ruleVersion: string;
                evidence: unknown;
            }>`select id,user_id as "userId",delta::int,rule_version as "ruleVersion",evidence from meal.reputation_events where id=${eventId}::uuid and reverses_id is null for update`.execute(
                tx,
            );
            const row = original.rows[0];
            if (!row) throw new NotFoundException('Событие репутации не найдено');
            const prior = await sql<{
                id: string;
            }>`select id from meal.reputation_events where reverses_id=${eventId}::uuid`.execute(tx);
            if (prior.rows[0]) return { eventId: prior.rows[0].id, created: false };
            const id = randomUUID();
            await sql`insert into meal.reputation_events(id,delta,rule_version,reason,evidence,recorded_at,user_id,reverses_id)
                values(${id}::uuid,${-row.delta},${row.ruleVersion},${reason},${JSON.stringify(row.evidence)}::jsonb,now(),${row.userId}::uuid,${row.id}::uuid)`.execute(
                tx,
            );
            return { eventId: id, created: true };
        });
    }

    async reverseReputationEventByKeyIn(tx: Tx, userId: string, qualifyingEventKey: string, reason: string) {
        const original = await sql<{
            id: string;
            delta: number;
            ruleVersion: string;
            evidence: unknown;
        }>`select re.id,re.delta::int,re.rule_version as "ruleVersion",re.evidence from meal.reputation_events re
            where re.user_id=${userId}::uuid and re.evidence->>'qualifyingEventKey'=${qualifyingEventKey}
              and not exists(select 1 from meal.reputation_events next where next.reverses_id=re.id)
            order by re.recorded_at desc,re.id desc limit 1 for update`.execute(tx);
        const row = original.rows[0];
        if (!row || row.delta <= 0) return { eventId: row?.id ?? null, created: false };
        const id = randomUUID();
        await sql`insert into meal.reputation_events(id,delta,rule_version,reason,evidence,recorded_at,user_id,reverses_id)
            values(${id}::uuid,${-row.delta},${row.ruleVersion},${reason},${JSON.stringify(row.evidence)}::jsonb,now(),${userId}::uuid,${row.id}::uuid)`.execute(
            tx,
        );
        return { eventId: id, created: true };
    }

    private async publicAuthor(username: string) {
        const db = await this.db();
        const user = await sql<{
            id: string;
            username: string;
        }>`select id,login username from meal.users u where lower(login)=lower(${username}) and status='active' and archived_at is null and email_verified_at is not null
            and not exists(select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now())) limit 1`.execute(
            db,
        );
        if (!user.rows[0]) throw new NotFoundException('Автор не найден');
        if (!(await this.legalConsents.allowsFeatureAccess(user.rows[0].id, 'dissemination', db)))
            throw new NotFoundException('Автор не найден');
        // Awards are a materialized projection. Lazy synchronization makes historic data and
        // newly published aggregate rules visible without rewriting the source domain history.
        await this.database.transaction((tx) =>
            this.evaluateAchievementsIn(tx, user.rows[0]!.id, { trigger: 'public-profile-read' }),
        );
        const score = await sql<{
            score: number;
        }>`select coalesce(sum(delta),0)::int score from meal.reputation_events where user_id=${user.rows[0].id}::uuid`.execute(
            db,
        );
        const levels = (await this.publicLevels()).items;
        const currentScore = score.rows[0]?.score ?? 0;
        const currentIndex = Math.max(
            0,
            levels.findLastIndex((level) => level.threshold <= currentScore),
        );
        const current = levels[currentIndex]!;
        return {
            db,
            user: user.rows[0],
            score: currentScore,
            levels,
            rank: {
                id: String(current.level),
                title: current.title,
                minimumScore: current.threshold,
                nextMinimumScore: levels[currentIndex + 1]?.threshold ?? null,
            },
        };
    }

    async authorReputation(username: string) {
        const value = await this.publicAuthor(username);
        return authorReputationSchema.parse({
            profile: { username: value.user.username, avatarUrl: null },
            score: value.score,
            rank: value.rank,
            ranks: value.levels.map((level) => ({
                id: String(level.level),
                title: level.title,
                minimumScore: level.threshold,
            })),
            factors: [
                {
                    id: 'published-own-recipe',
                    title: '+5 за самостоятельный опубликованный рецепт',
                    icon: { assetId: null, fallbackKey: 'recipe', alt: 'Рецепт' },
                },
                {
                    id: 'accepted-content-correction',
                    title: '+2 за подтверждённое содержательное исправление',
                    icon: { assetId: null, fallbackKey: 'correction', alt: 'Исправление' },
                },
                {
                    id: 'first-independent-cook',
                    title: '+1 за первую независимую готовку рецепта',
                    icon: { assetId: null, fallbackKey: 'cook', alt: 'Готовка' },
                },
            ],
        });
    }

    async authorAchievements(username: string) {
        const value = await this.publicAuthor(username);
        const heads = await sql<{ code: string; payload: unknown; ruleId: string | null; awardedAt: Date | null }>`
            select h.resource_key code,h.payload,a.rule_id as "ruleId",a.awarded_at as "awardedAt"
            from meal.content_resource_heads h
            left join lateral (select aa.rule_id,aa.awarded_at from meal.achievement_awards aa join meal.achievement_rules ar on ar.id=aa.rule_id
                where aa.user_id=${value.user.id}::uuid and aa.revoked_at is null and ar.code=h.resource_key order by aa.awarded_at desc limit 1) a on true
            where h.resource_type='achievement' and not h.retired order by h.resource_key`.execute(value.db);
        const achievements = heads.rows.map((row) => {
            const payload = achievementPayloadSchema.parse(row.payload);
            const hidden = payload.secret && !row.ruleId;
            return {
                id: row.code,
                title: hidden ? 'Секретное достижение' : payload.title,
                description: hidden ? 'Условие откроется после получения.' : payload.description,
                category: payload.category,
                icon: hidden
                    ? { assetId: null, fallbackKey: 'achievement-secret', alt: 'Секретное достижение' }
                    : payload.icon,
                secret: payload.secret,
                status: row.ruleId ? ('earned' as const) : ('locked' as const),
                earnedAt: row.awardedAt ? iso(row.awardedAt) : null,
            };
        });
        const categories = [...new Set(achievements.map((item) => item.category))].map((id) => ({
            id,
            title: categoryTitle(id),
        }));
        return authorAchievementsSchema.parse({
            profile: { username: value.user.username, avatarUrl: null },
            reputation: { score: value.score, rank: value.rank },
            categories,
            achievements,
        });
    }
}

type AchievementMetrics = {
    cookCount: number;
    distinctRecipes: number;
    breakfastCount: number;
    soupCount: number;
    bakingCount: number;
    dessertCount: number;
    vegetableCount: number;
    fishCount: number;
    plantCount: number;
    cuisineCount: number;
    leftoverCount: number;
    earlyCount: number;
    nightCount: number;
    preciseCount: number;
    seasonalCount: number;
    seasonalMonthCount: number;
    batchCount: number;
    locatedBatchCount: number;
    activeBatchCount: number;
    activeInventoryDays: number;
    preserveCount: number;
    planCount: number;
    maxPlanDays: number;
    shoppingCount: number;
    familyShoppingCount: number;
    receiptCount: number;
    publishedCount: number;
    completeRecipeCount: number;
    maxIndependentCooks: number;
    seriesCount: number;
    helpfulCount: number;
    followerCount: number;
    followingCount: number;
    correctionCount: number;
    allergenCount: number;
    sourceCount: number;
    photoCount: number;
    bookmarkCount: number;
    familyCookCount: number;
    familyWeeklyCooks: number;
    familyPlanDays: number;
    holidayCount: number;
    everythingUsedCount: number;
    expiredActiveCount: number;
};

const achievementMetricSchema = z.enum([
    'cookCount',
    'distinctRecipes',
    'breakfastCount',
    'soupCount',
    'bakingCount',
    'dessertCount',
    'vegetableCount',
    'fishCount',
    'plantCount',
    'cuisineCount',
    'leftoverCount',
    'earlyCount',
    'nightCount',
    'preciseCount',
    'seasonalCount',
    'seasonalMonthCount',
    'batchCount',
    'locatedBatchCount',
    'activeBatchCount',
    'activeInventoryDays',
    'preserveCount',
    'planCount',
    'maxPlanDays',
    'shoppingCount',
    'familyShoppingCount',
    'receiptCount',
    'publishedCount',
    'completeRecipeCount',
    'maxIndependentCooks',
    'seriesCount',
    'helpfulCount',
    'followerCount',
    'followingCount',
    'correctionCount',
    'allergenCount',
    'sourceCount',
    'photoCount',
    'bookmarkCount',
    'familyCookCount',
    'familyWeeklyCooks',
    'familyPlanDays',
    'holidayCount',
    'everythingUsedCount',
    'expiredActiveCount',
]);
const aggregateClauseSchema = z.strictObject({
    metric: achievementMetricSchema,
    operator: z.enum(['gte', 'eq']),
    threshold: z.number().int().nonnegative(),
});
const achievementAggregateConditionSchema = z.union([
    aggregateClauseSchema,
    z.strictObject({ all: z.array(aggregateClauseSchema).min(1).max(10) }),
]);
type AggregateCondition = z.infer<typeof achievementAggregateConditionSchema>;
type AggregateClause = z.infer<typeof aggregateClauseSchema>;

const condition = (metric: AggregateClause['metric'], threshold: number): AggregateClause => ({
    metric,
    operator: 'gte',
    threshold,
});
const legacyAchievementConditions: Record<string, AggregateCondition> = {
    'first-dish': condition('cookCount', 1),
    'home-cook': condition('cookCount', 10),
    'confident-cook': condition('cookCount', 50),
    'hundred-dishes': condition('cookCount', 100),
    'new-flavors': condition('distinctRecipes', 10),
    'culinary-outlook': condition('distinctRecipes', 25),
    'breakfast-ready': condition('breakfastCount', 7),
    'soup-week': condition('soupCount', 5),
    'home-baking': condition('bakingCount', 5),
    'sweet-collection': condition('dessertCount', 5),
    'vegetable-season': condition('vegetableCount', 10),
    'fish-day': condition('fishCount', 5),
    'plant-menu': condition('plantCount', 10),
    'world-cuisines': condition('cuisineCount', 5),
    'no-extra-waste': condition('leftoverCount', 5),
    'first-batch': condition('batchCount', 1),
    'kitchen-order': condition('locatedBatchCount', 10),
    'full-pantry': condition('activeBatchCount', 50),
    'week-without-expiry': {
        all: [
            condition('activeBatchCount', 1),
            condition('activeInventoryDays', 7),
            { metric: 'expiredActiveCount', operator: 'eq', threshold: 0 },
        ],
    },
    'weekly-plan': condition('maxPlanDays', 7),
    'month-by-plan': condition('planCount', 4),
    'shopping-by-list': condition('shoppingCount', 1),
    'ten-lists': condition('shoppingCount', 10),
    'receipt-accepted': condition('receiptCount', 1),
    'homemade-preserve': condition('preserveCount', 1),
    'first-recipe': condition('publishedCount', 1),
    'five-recipes': condition('publishedCount', 5),
    'author-ten': condition('publishedCount', 10),
    'big-book': condition('publishedCount', 25),
    'complete-card': condition('completeRecipeCount', 1),
    'first-reader': condition('maxIndependentCooks', 1),
    'kitchen-tested': condition('maxIndependentCooks', 5),
    'peoples-recipe': condition('maxIndependentCooks', 25),
    'hundred-home-kitchens': condition('maxIndependentCooks', 100),
    'own-series': condition('seriesCount', 5),
    'good-advice': condition('helpfulCount', 1),
    'ten-good-tips': condition('helpfulCount', 10),
    'first-follower': condition('followerCount', 1),
    'readers-circle': condition('followerCount', 25),
    'useful-clarification': condition('correctionCount', 1),
    'catalog-helper': condition('correctionCount', 10),
    'catalog-expert': condition('correctionCount', 50),
    'allergen-noticed': condition('allergenCount', 1),
    'reliable-source': condition('sourceCount', 5),
    'good-photo': condition('photoCount', 1),
    'first-find': condition('bookmarkCount', 1),
    'personal-ten': condition('bookmarkCount', 10),
    'big-collection': condition('bookmarkCount', 50),
    'favorite-authors': condition('followingCount', 10),
    'shared-list': condition('familyShoppingCount', 1),
    'family-dinner': condition('familyCookCount', 1),
    'week-together': condition('familyPlanDays', 7),
    'team-kitchen': condition('familyWeeklyCooks', 3),
    'seasonal-table': condition('seasonalCount', 5),
    'holiday-table': condition('holidayCount', 1),
    'harvest-month': condition('seasonalMonthCount', 10),
    'early-breakfast': condition('earlyCount', 1),
    'night-cook': condition('nightCount', 1),
    'precise-calculation': condition('preciseCount', 1),
    'everything-used': condition('everythingUsedCount', 1),
};

function normalizeAchievementCondition(code: string, value: unknown): unknown {
    const typed = achievementAggregateConditionSchema.safeParse(value);
    if (typed.success) return typed.data;
    return legacyAchievementConditions[code] ?? value;
}

function achievementReached(conditionValue: AggregateCondition, metrics: AchievementMetrics) {
    const reached = (clause: AggregateClause) => {
        const actual = Number(metrics[clause.metric]);
        return clause.operator === 'gte' ? actual >= clause.threshold : actual === clause.threshold;
    };
    return 'all' in conditionValue ? conditionValue.all.every(reached) : reached(conditionValue);
}

function zArray(value: unknown): ReleasePatch[] | null {
    if (!Array.isArray(value)) return null;
    const parsed = releasePatchSchema.array().safeParse(value);
    return parsed.success ? parsed.data : null;
}

function categoryTitle(id: string) {
    return (
        (
            {
                culinary: 'Кулинария',
                inventory: 'Запасы',
                planning: 'Планирование',
                author: 'Авторство',
                community: 'Сообщество',
                catalog: 'Каталог',
                collections: 'Коллекции',
                family: 'Семья',
                seasonal: 'Сезонные',
                secret: 'Секретные',
            } as Record<string, string>
        )[id] ?? id
    );
}
