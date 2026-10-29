import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { AdminAccessService } from '../admin-auth/admin-access.service.js';
import type { Principal } from '../auth/auth.service.js';
import { LegalConsentService } from '../legal-consents/legal-consent.service.js';
import { ReputationAchievementsService } from './reputation-achievements.service.js';
import { achievementAggregateConditionSchema, normalizeAchievementCondition } from './achievement-policy.js';
import {
    achievementPayloadSchema,
    contentDocumentPayloadSchema,
    createReleaseSchema,
    dictionaryEntryPayloadSchema,
    legalTextPayloadSchema,
    productDescriptionPayloadSchema,
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

    private get reputationAchievements() {
        return new ReputationAchievementsService(this.database, this.legalConsents);
    }

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
        return this.reputationAchievements.publicLevels();
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
        return this.reputationAchievements.recordReputationEvent(
            userId,
            code,
            subjectKey,
            qualifyingEventKey,
            evidence,
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
        return this.reputationAchievements.recordReputationEventIn(
            tx,
            userId,
            code,
            subjectKey,
            qualifyingEventKey,
            evidence,
        );
    }

    async processAchievementEventIn(tx: Tx, userId: string, event: string, evidence: Record<string, unknown>) {
        return this.reputationAchievements.processAchievementEventIn(tx, userId, event, evidence);
    }

    async evaluateAchievementsIn(tx: Tx, userId: string, evidence: Record<string, unknown> = {}) {
        return this.reputationAchievements.evaluateAchievementsIn(tx, userId, evidence);
    }

    async reverseReputationEvent(eventId: string, reason: string) {
        return this.reputationAchievements.reverseReputationEvent(eventId, reason);
    }

    async reverseReputationEventByKeyIn(tx: Tx, userId: string, qualifyingEventKey: string, reason: string) {
        return this.reputationAchievements.reverseReputationEventByKeyIn(tx, userId, qualifyingEventKey, reason);
    }

    async authorReputation(username: string) {
        return this.reputationAchievements.authorReputation(username);
    }

    async authorAchievements(username: string) {
        return this.reputationAchievements.authorAchievements(username);
    }
}

function zArray(value: unknown): ReleasePatch[] | null {
    if (!Array.isArray(value)) return null;
    const parsed = releasePatchSchema.array().safeParse(value);
    return parsed.success ? parsed.data : null;
}
