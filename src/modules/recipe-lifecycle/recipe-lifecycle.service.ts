import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';

type Tx = Transaction<DatabaseSchema>;
type ReviewStatus = 'draft' | 'pending' | 'rejected' | 'published' | 'hidden' | 'unpublished';

export type RecipeLifecycleProjection = {
    review: { revisionId: string; status: ReviewStatus; publicReason: string | null };
    publication: { revisionId: string; publishedAt: string } | null;
};

export function sanitizePublicReviewReason(value: string | null | undefined, status: ReviewStatus): string | null {
    const normalized = value
        ?.replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 500);
    if (normalized) return normalized;
    if (status === 'rejected') return 'Рецепт требует исправлений перед повторной отправкой.';
    if (status === 'hidden') return 'Рецепт скрыт из публичного доступа после проверки.';
    if (status === 'unpublished') return 'Публикация рецепта снята после проверки.';
    return null;
}

@Injectable()
export class RecipeLifecycleService {
    async projection(
        tx: Tx,
        recipeId: string,
        currentRevisionId: string,
        fallbackStatus: string,
    ): Promise<RecipeLifecycleProjection> {
        const publication = (
            await sql<{
                revisionId: string;
                publishedAt: Date;
            }>`select revision_id as "revisionId",published_at as "publishedAt"
                from meal.recipe_publications where recipe_id=${recipeId}::uuid and unpublished_at is null
                order by published_at desc,id desc limit 1`.execute(tx)
        ).rows[0];
        const review = (
            await sql<{
                revisionId: string;
                status: string;
                publicReason: string | null;
            }>`select mc.recipe_revision_id as "revisionId",mc.status,
                nullif(mc.evidence->>'publicReason','') as "publicReason"
                from meal.moderation_cases mc
                join meal.recipe_revisions rr on rr.id=mc.recipe_revision_id
                where rr.recipe_id=${recipeId}::uuid and mc.kind='recipe'
                order by (mc.recipe_revision_id=${currentRevisionId}::uuid) desc,rr.revision desc,mc.submitted_at desc,mc.id desc limit 1`.execute(
                tx,
            )
        ).rows[0];
        const effective =
            fallbackStatus === 'hidden'
                ? 'hidden'
                : ['hidden', 'unpublished'].includes(review?.status ?? '')
                  ? review?.status
                  : review?.status === 'published'
                    ? 'published'
                    : ['queued', 'pending', 'in_review', 'approved'].includes(review?.status ?? '')
                      ? 'pending'
                      : review?.status === 'rejected'
                        ? 'rejected'
                        : fallbackStatus === 'published'
                          ? 'published'
                          : 'draft';
        const status = effective as ReviewStatus;
        return {
            review: {
                revisionId: review?.revisionId ?? currentRevisionId,
                status,
                publicReason: sanitizePublicReviewReason(review?.publicReason, status),
            },
            publication: publication
                ? { revisionId: publication.revisionId, publishedAt: publication.publishedAt.toISOString() }
                : null,
        };
    }

    async markReview(
        tx: Tx,
        input: {
            caseId: string;
            revisionId: string;
            status: Exclude<ReviewStatus, 'draft' | 'published'>;
            publicReason?: string | null;
        },
    ) {
        const target = await this.lockTarget(tx, input.revisionId);
        const publicReason = sanitizePublicReviewReason(input.publicReason, input.status);
        const updated = await sql`update meal.moderation_cases set evidence=case when ${publicReason}::text is null
            then coalesce(evidence,'{}'::jsonb)-'publicReason'
            else jsonb_set(coalesce(evidence,'{}'::jsonb),'{publicReason}',to_jsonb(${publicReason}::text),true) end
            where id=${input.caseId}::uuid and recipe_revision_id=${input.revisionId}::uuid and kind='recipe'`.execute(
            tx,
        );
        if (Number(updated.numAffectedRows) !== 1)
            throw new ConflictException('Recipe review case does not match revision');
        await sql`update meal.recipes set status=${input.status},version=version+1 where id=${target.recipeId}::uuid`.execute(
            tx,
        );
        return target;
    }

    async publish(tx: Tx, input: { caseId: string; revisionId: string; decisionId: string; actorId: string | null }) {
        const target = await this.lockTarget(tx, input.revisionId);
        if (target.archivedAt || ['hidden', 'deleted'].includes(target.status))
            throw new ConflictException('Archived or hidden recipe cannot be published');
        const active = (
            await sql<{
                id: string;
                revisionId: string;
                revision: number;
            }>`select p.id,p.revision_id as "revisionId",
                (select rr.revision::int from meal.recipe_revisions rr where rr.id=p.revision_id) as revision
                from meal.recipe_publications p
                where p.recipe_id=${target.recipeId}::uuid and p.unpublished_at is null for update`.execute(tx)
        ).rows[0];
        if (active && active.revision > target.revision)
            throw new ConflictException('A newer recipe revision is already published');
        if (active?.revisionId !== input.revisionId) {
            if (active) {
                await sql`update meal.recipe_publications set unpublished_at=now(),version=version+1 where id=${active.id}::uuid`.execute(
                    tx,
                );
                const oldCase = (
                    await sql<{ id: string; status: string }>`select id,status from meal.moderation_cases
                        where kind='recipe' and recipe_revision_id=${active.revisionId}::uuid for update`.execute(tx)
                ).rows[0];
                if (oldCase) {
                    await sql`insert into meal.moderation_decisions(id,action,reason,decided_at,before_snapshot,after_snapshot,case_id,actor_id)
                        values(${randomUUID()}::uuid,'replaced','Заменено новой опубликованной редакцией',now(),${JSON.stringify({ status: oldCase.status })}::jsonb,${JSON.stringify({ status: 'unpublished', replacedByRevisionId: input.revisionId })}::jsonb,${oldCase.id}::uuid,${input.actorId}::uuid)`.execute(
                        tx,
                    );
                    await sql`update meal.moderation_cases set status='unpublished',version=version+1 where id=${oldCase.id}::uuid`.execute(
                        tx,
                    );
                }
            }
            await sql`insert into meal.recipe_publications(id,recipe_id,published_at,unpublished_at,revision_id,decision_id)
                values(${randomUUID()}::uuid,${target.recipeId}::uuid,now(),null,${input.revisionId}::uuid,${input.decisionId}::uuid)`.execute(
                tx,
            );
        }
        const updated = await sql`update meal.moderation_cases set evidence=evidence-'publicReason'
            where id=${input.caseId}::uuid and recipe_revision_id=${input.revisionId}::uuid and kind='recipe'`.execute(
            tx,
        );
        if (Number(updated.numAffectedRows) !== 1)
            throw new ConflictException('Recipe review case does not match revision');
        await sql`update meal.recipes set status='published',version=version+1 where id=${target.recipeId}::uuid`.execute(
            tx,
        );
        return { ...target, publicationCreated: !active || active.revisionId !== input.revisionId };
    }

    async closeActive(
        tx: Tx,
        input: {
            revisionId: string;
            status: 'hidden' | 'unpublished';
            publicReason?: string | null;
            sourceCaseId?: string;
            actorId?: string | null;
            decisionAction?: string;
            decisionReason?: string;
            allowAnyActiveRevision?: boolean;
            allowMissingPublication?: boolean;
        },
    ) {
        const target = await this.lockTarget(tx, input.revisionId);
        const active = (
            await sql<{
                id: string;
                revisionId: string;
            }>`select id,revision_id as "revisionId" from meal.recipe_publications
                where recipe_id=${target.recipeId}::uuid and unpublished_at is null for update`.execute(tx)
        ).rows[0];
        if (!active && input.allowMissingPublication) {
            await sql`update meal.recipes set status=${input.status},version=version+1 where id=${target.recipeId}::uuid`.execute(
                tx,
            );
            return {
                ...target,
                publicReason: sanitizePublicReviewReason(input.publicReason, input.status),
                publicationClosed: false,
            };
        }
        if (!active || (!input.allowAnyActiveRevision && active.revisionId !== input.revisionId))
            throw new ConflictException('Case revision is not the active publication');
        const recipeCase = (
            await sql<{ id: string; status: string }>`select id,status from meal.moderation_cases
                where kind='recipe' and recipe_revision_id=${active.revisionId}::uuid for update`.execute(tx)
        ).rows[0];
        if (!recipeCase) throw new ConflictException('Active publication has no recipe review case');
        const publicReason = sanitizePublicReviewReason(input.publicReason, input.status);
        await sql`update meal.recipe_publications set unpublished_at=now(),version=version+1 where id=${active.id}::uuid`.execute(
            tx,
        );
        await sql`update meal.moderation_cases set status=${input.status},
            evidence=jsonb_set(coalesce(evidence,'{}'::jsonb),'{publicReason}',to_jsonb(${publicReason}::text),true),version=version+1
            where id=${recipeCase.id}::uuid`.execute(tx);
        if (!input.sourceCaseId || input.sourceCaseId !== recipeCase.id) {
            await sql`insert into meal.moderation_decisions(id,action,reason,decided_at,before_snapshot,after_snapshot,case_id,actor_id)
                values(${randomUUID()}::uuid,${input.decisionAction ?? input.status},${input.decisionReason ?? 'Публикация закрыта системным действием'},now(),
                ${JSON.stringify({ status: recipeCase.status })}::jsonb,
                ${JSON.stringify({ status: input.status, publicReason })}::jsonb,
                ${recipeCase.id}::uuid,${input.actorId ?? null}::uuid)`.execute(tx);
        }
        await sql`update meal.recipes set status=${input.status},version=version+1 where id=${target.recipeId}::uuid`.execute(
            tx,
        );
        return { ...target, publicReason, publicationClosed: true };
    }

    async archive(tx: Tx, recipeId: string, actorId: string) {
        const recipe = (
            await sql<{
                id: string;
                authorId: string;
            }>`select id,author_id as "authorId" from meal.recipes where id=${recipeId}::uuid for update`.execute(tx)
        ).rows[0];
        if (!recipe) throw new NotFoundException('Recipe not found');
        const active = (
            await sql<{ revisionId: string }>`select revision_id as "revisionId" from meal.recipe_publications
                where recipe_id=${recipeId}::uuid and unpublished_at is null for update`.execute(tx)
        ).rows[0];
        if (!active) return { closed: false, recipeId, authorId: recipe.authorId };
        const recipeCase = (
            await sql<{ id: string; status: string }>`select id,status from meal.moderation_cases
                where kind='recipe' and recipe_revision_id=${active.revisionId}::uuid for update`.execute(tx)
        ).rows[0];
        if (!recipeCase) throw new ConflictException('Active publication has no recipe review case');
        const publicReason = sanitizePublicReviewReason(null, 'unpublished');
        await sql`update meal.recipe_publications set unpublished_at=now(),version=version+1
            where recipe_id=${recipeId}::uuid and unpublished_at is null`.execute(tx);
        await sql`update meal.moderation_cases set status='unpublished',
            evidence=jsonb_set(coalesce(evidence,'{}'::jsonb),'{publicReason}',to_jsonb(${publicReason}::text),true),version=version+1
            where id=${recipeCase.id}::uuid`.execute(tx);
        await sql`insert into meal.moderation_decisions(id,action,reason,decided_at,before_snapshot,after_snapshot,case_id,actor_id)
            values(${randomUUID()}::uuid,'archive','Автор архивировал рецепт',now(),${JSON.stringify({ status: recipeCase.status })}::jsonb,
            ${JSON.stringify({ status: 'unpublished', publicReason })}::jsonb,${recipeCase.id}::uuid,${actorId}::uuid)`.execute(
            tx,
        );
        return { closed: true, recipeId, authorId: recipe.authorId };
    }

    private async lockTarget(tx: Tx, revisionId: string) {
        const target = (
            await sql<{
                recipeId: string;
                authorId: string;
                status: string;
                archivedAt: Date | null;
                revision: number;
            }>`select r.id as "recipeId",r.author_id as "authorId",r.status,r.archived_at as "archivedAt",rr.revision::int
                from meal.recipe_revisions rr join meal.recipes r on r.id=rr.recipe_id
                where rr.id=${revisionId}::uuid for update of r`.execute(tx)
        ).rows[0];
        if (!target) throw new NotFoundException('Recipe revision not found');
        return target;
    }
}
