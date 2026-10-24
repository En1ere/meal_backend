import { ConflictException, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { Principal } from '../auth/auth.service.js';
import { ContentReleasesService } from '../content-releases/content-releases.service.js';

type Tx = Transaction<DatabaseSchema>;
type Db = Tx | import('kysely').Kysely<DatabaseSchema>;
const uuid = z.uuid();
const nullableDate = z.iso.datetime().nullable();
const policy = z.strictObject({
    submissionDailyLimit: z.number().int().positive(),
    commentHourlyLimit: z.number().int().positive(),
    reportDailyLimit: z.number().int().positive(),
});
const snapshotSchema = z.discriminatedUnion('adapter', [
    z.strictObject({
        adapter: z.literal('content-release'),
        targetId: uuid,
        expectedVersion: z.number().int().positive(),
        before: z.strictObject({ status: z.literal('draft') }),
        after: z.strictObject({ status: z.literal('published') }),
    }),
    z.strictObject({
        adapter: z.literal('moderation'),
        targetId: uuid,
        expectedVersion: z.number().int().positive(),
        before: z.strictObject({ status: z.literal('published') }),
        after: z.strictObject({ status: z.enum(['hide', 'unpublish']) }),
        publication: z.strictObject({
            id: uuid,
            expectedVersion: z.number().int().positive(),
            beforeUnpublishedAt: z.null(),
            afterUnpublishedAt: z.iso.datetime(),
        }),
    }),
    z.strictObject({
        adapter: z.literal('sanction'),
        targetId: uuid,
        expectedVersion: z.number().int().positive(),
        before: z.strictObject({ revokedAt: nullableDate, endsAt: nullableDate }),
        after: z.strictObject({ revokedAt: nullableDate, endsAt: nullableDate }),
    }),
    z.strictObject({
        adapter: z.literal('settings.recipe-policy'),
        targetId: uuid,
        expectedVersion: z.number().int().positive(),
        before: policy,
        after: policy,
    }),
]);
export type RollbackSnapshot = z.infer<typeof snapshotSchema>;
export type RollbackInspection = {
    supported: boolean;
    snapshot: RollbackSnapshot | null;
    targetId: string;
    before: string;
    after: string;
    current: string;
    expectedVersion: number;
    actualVersion: number;
    ready: boolean;
    reason: string;
};
const policyId = '71000000-0000-4000-8000-000000000001';
const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const date = (value: Date | null) => (value ? value.toISOString() : null);

/** Explicit allow-list for generic rollback. Unknown snapshots are intentionally non-executable. */
@Injectable()
export class AdminRollbackRegistry {
    constructor(private readonly releases: ContentReleasesService) {}

    parse(value: unknown) {
        return snapshotSchema.safeParse(value);
    }

    async inspect(db: Db, raw: unknown): Promise<RollbackInspection> {
        const parsed = this.parse(raw);
        if (!parsed.success) {
            const candidate = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
            return {
                supported: false,
                snapshot: null,
                targetId:
                    typeof candidate.targetId === 'string' && uuid.safeParse(candidate.targetId).success
                        ? candidate.targetId
                        : '00000000-0000-4000-8000-000000000000',
                before: show(candidate.before ?? 'unknown'),
                after: show(candidate.after ?? 'unknown'),
                current: show(candidate.current ?? candidate.after ?? 'unknown'),
                expectedVersion: Number.isInteger(candidate.expectedVersion) ? Number(candidate.expectedVersion) : 0,
                actualVersion: Number.isInteger(candidate.actualVersion)
                    ? Number(candidate.actualVersion)
                    : Number.isInteger(candidate.expectedVersion)
                      ? Number(candidate.expectedVersion)
                      : 0,
                ready: false,
                reason: 'Snapshot не входит в явный whitelist доменных компенсаторов.',
            };
        }
        const snapshot = parsed.data;
        let current: unknown = 'missing';
        let actualVersion = 0;
        if (snapshot.adapter === 'content-release') {
            const row = await sql<{
                status: string;
                version: number;
            }>`select status,version::int from meal.content_releases where id=${snapshot.targetId}::uuid`.execute(db);
            current = row.rows[0] ? { status: row.rows[0].status } : 'missing';
            actualVersion = row.rows[0]?.version ?? 0;
        } else if (snapshot.adapter === 'moderation') {
            const row = await sql<{
                status: string;
                version: number;
            }>`select status,version::int from meal.moderation_cases where id=${snapshot.targetId}::uuid`.execute(db);
            const publication = await sql<{
                version: number;
                unpublishedAt: Date | null;
            }>`select version::int,unpublished_at as "unpublishedAt" from meal.recipe_publications where id=${snapshot.publication.id}::uuid`.execute(
                db,
            );
            current = row.rows[0]
                ? {
                      status: row.rows[0].status,
                      publicationUnpublishedAt: date(publication.rows[0]?.unpublishedAt ?? null),
                  }
                : 'missing';
            actualVersion = row.rows[0]?.version ?? 0;
        } else if (snapshot.adapter === 'sanction') {
            const row = await sql<{
                version: number;
                revokedAt: Date | null;
                endsAt: Date | null;
            }>`select version::int,revoked_at as "revokedAt",ends_at as "endsAt" from meal.sanctions where id=${snapshot.targetId}::uuid`.execute(
                db,
            );
            current = row.rows[0]
                ? { revokedAt: date(row.rows[0].revokedAt), endsAt: date(row.rows[0].endsAt) }
                : 'missing';
            actualVersion = row.rows[0]?.version ?? 0;
        } else {
            const row = await sql<{
                version: number;
                submissionDailyLimit: number;
                commentHourlyLimit: number;
                reportDailyLimit: number;
            }>`select version::int,
                submission_daily_limit as "submissionDailyLimit",comment_hourly_limit as "commentHourlyLimit",report_daily_limit as "reportDailyLimit"
                from meal.recipe_policy where id=${snapshot.targetId}::uuid`.execute(db);
            current = row.rows[0]
                ? {
                      submissionDailyLimit: row.rows[0].submissionDailyLimit,
                      commentHourlyLimit: row.rows[0].commentHourlyLimit,
                      reportDailyLimit: row.rows[0].reportDailyLimit,
                  }
                : 'missing';
            actualVersion = row.rows[0]?.version ?? 0;
        }
        const expectedCurrent =
            snapshot.adapter === 'moderation'
                ? { ...snapshot.after, publicationUnpublishedAt: snapshot.publication.afterUnpublishedAt }
                : snapshot.after;
        const publicationReady =
            snapshot.adapter !== 'moderation' ||
            (
                await sql<{
                    version: number;
                }>`select version::int from meal.recipe_publications where id=${snapshot.publication.id}::uuid`.execute(
                    db,
                )
            ).rows[0]?.version === snapshot.publication.expectedVersion;
        const ready = actualVersion === snapshot.expectedVersion && publicationReady && same(current, expectedCurrent);
        return {
            supported: true,
            snapshot,
            targetId: snapshot.targetId,
            before: show(snapshot.before),
            after: show(snapshot.after),
            current: show(current),
            expectedVersion: snapshot.expectedVersion,
            actualVersion,
            ready,
            reason: ready
                ? 'Состояние и версия совпадают; зарегистрированный доменный компенсатор готов.'
                : 'Версия или текущее состояние изменились после подготовки snapshot.',
        };
    }

    async apply(tx: Tx, actor: Principal, inspection: RollbackInspection) {
        if (!inspection.snapshot || !inspection.ready) throw new ConflictException('Компенсация больше небезопасна');
        const snapshot = inspection.snapshot;
        if (snapshot.adapter === 'content-release') {
            await this.releases.compensatePublishedReleaseIn(tx, actor, snapshot.targetId, snapshot.expectedVersion);
        } else if (snapshot.adapter === 'moderation') {
            const updated = await tx
                .updateTable('moderation_cases')
                .set({ status: snapshot.before.status, version: snapshot.expectedVersion + 1 })
                .where('id', '=', snapshot.targetId)
                .where('version', '=', String(snapshot.expectedVersion))
                .executeTakeFirst();
            if (Number(updated.numUpdatedRows) !== 1) throw new ConflictException('Модерация изменилась');
            const publication = await tx
                .updateTable('recipe_publications')
                .set({
                    unpublished_at: snapshot.publication.beforeUnpublishedAt
                        ? new Date(snapshot.publication.beforeUnpublishedAt)
                        : null,
                    version: snapshot.publication.expectedVersion + 1,
                })
                .where('id', '=', snapshot.publication.id)
                .where('version', '=', String(snapshot.publication.expectedVersion))
                .executeTakeFirst();
            if (Number(publication.numUpdatedRows) !== 1) throw new ConflictException('Публикация изменилась');
            const recipe = await sql<{
                recipeId: string;
                authorId: string;
            }>`select rr.recipe_id as "recipeId",r.author_id as "authorId"
                from meal.recipe_publications rp join meal.recipe_revisions rr on rr.id=rp.revision_id join meal.recipes r on r.id=rr.recipe_id
                where rp.id=${snapshot.publication.id}::uuid`.execute(tx);
            if (recipe.rows[0]) {
                await this.releases.recordReputationEventIn(
                    tx,
                    recipe.rows[0].authorId,
                    'published-own-recipe',
                    recipe.rows[0].recipeId,
                    `recipe-published:${recipe.rows[0].recipeId}`,
                    { recipeId: recipe.rows[0].recipeId, compensation: true },
                );
                await this.releases.processAchievementEventIn(tx, recipe.rows[0].authorId, 'recipe.published', {
                    recipeId: recipe.rows[0].recipeId,
                    compensation: true,
                });
            }
        } else if (snapshot.adapter === 'sanction') {
            const updated = await tx
                .updateTable('sanctions')
                .set({
                    revoked_at: snapshot.before.revokedAt ? new Date(snapshot.before.revokedAt) : null,
                    ends_at: snapshot.before.endsAt ? new Date(snapshot.before.endsAt) : null,
                    version: snapshot.expectedVersion + 1,
                })
                .where('id', '=', snapshot.targetId)
                .where('version', '=', String(snapshot.expectedVersion))
                .executeTakeFirst();
            if (Number(updated.numUpdatedRows) !== 1) throw new ConflictException('Санкция изменилась');
        } else {
            if (snapshot.targetId !== policyId) throw new ConflictException('Неизвестный набор настроек');
            const updated = await tx
                .updateTable('recipe_policy')
                .set({
                    submission_daily_limit: snapshot.before.submissionDailyLimit,
                    comment_hourly_limit: snapshot.before.commentHourlyLimit,
                    report_daily_limit: snapshot.before.reportDailyLimit,
                    version: snapshot.expectedVersion + 1,
                    updated_at: new Date(),
                })
                .where('id', '=', snapshot.targetId)
                .where('version', '=', String(snapshot.expectedVersion))
                .executeTakeFirst();
            if (Number(updated.numUpdatedRows) !== 1) throw new ConflictException('Настройки изменились');
        }
        return {
            adapter: snapshot.adapter,
            before:
                snapshot.adapter === 'moderation'
                    ? { case: snapshot.after, publicationUnpublishedAt: snapshot.publication.afterUnpublishedAt }
                    : snapshot.after,
            after:
                snapshot.adapter === 'moderation'
                    ? { case: snapshot.before, publicationUnpublishedAt: snapshot.publication.beforeUnpublishedAt }
                    : snapshot.before,
        };
    }
}
