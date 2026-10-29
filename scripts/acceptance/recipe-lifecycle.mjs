import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { sql } from 'kysely';
import { RecipeLifecycleService } from '../../dist/src/modules/recipe-lifecycle/recipe-lifecycle.service.js';
import { ContentReleasesService } from '../../dist/src/modules/content-releases/content-releases.service.js';
import { AdminRollbackRegistry } from '../../dist/src/modules/admin-review/admin-rollback.registry.js';

const conflict = (error) => error instanceof ConflictException || error?.status === 409;

export async function runRecipeLifecycleAcceptance({ database, ownerPool, author, moderatorUserId, moderatorPost }) {
    const lifecycle = new RecipeLifecycleService();
    const releases = new ContentReleasesService(database, {}, {});
    const rollback = new AdminRollbackRegistry(releases);
    const privateScope = await ownerPool.query(
        `select id from meal.data_scopes where kind='private' and user_id=$1 limit 1`,
        [author.userId],
    );
    assert.equal(privateScope.rows.length, 1);

    const recipeId = randomUUID();
    const reputationReleaseId = randomUUID();
    const revisions = Array.from({ length: 6 }, (_, index) => ({
        id: randomUUID(),
        number: index + 1,
        caseId: randomUUID(),
        decisionId: randomUUID(),
    }));
    await ownerPool.query('begin isolation level serializable');
    try {
        await ownerPool.query(
            `insert into meal.recipes(id,title,status,author_id,scope_id) values($1,'Focused lifecycle','approved',$2,$3)`,
            [recipeId, author.userId, privateScope.rows[0].id],
        );
        await ownerPool.query(
            `insert into meal.content_releases(
               id,name,status,revision,created_by,published_by,published_at
             ) values($1,'Focused recipe lifecycle reputation','published',1,$2,$3,now())`,
            [reputationReleaseId, author.userId, moderatorUserId],
        );
        await ownerPool.query(
            `insert into meal.reputation_rule_versions(
               id,code,revision,points,per_subject_cap,condition,enabled,published_release_id
             ) select $1,'published-own-recipe',coalesce(max(revision),0)+1,5,20,$2::jsonb,true,$3
               from meal.reputation_rule_versions where code='published-own-recipe'`,
            [
                randomUUID(),
                JSON.stringify({ event: 'recipe.published', author: 'self', fixture: 'focused-lifecycle' }),
                reputationReleaseId,
            ],
        );
        for (const revision of revisions.slice(0, 2)) {
            await ownerPool.query(
                `insert into meal.recipe_revisions(id,revision,title,portions,method,change_kind,recipe_id,created_by)
                 values($1,$2,$3,2,'Focused acceptance','acceptance',$4,$5)`,
                [revision.id, revision.number, `Focused lifecycle r${revision.number}`, recipeId, author.userId],
            );
            await ownerPool.query(
                `insert into meal.moderation_cases(
                   id,kind,status,reason,submitted_at,queue_priority,evidence,reporter_id,recipe_revision_id,assigned_to
                 ) values($1,'recipe',$2,'Focused acceptance',now(),1,$3::jsonb,$4,$5,$6)`,
                [
                    revision.caseId,
                    revision.number === 2 || revision.number === 6 ? 'pending' : 'approved',
                    JSON.stringify({ internalNote: `internal-r${revision.number}` }),
                    author.userId,
                    revision.id,
                    moderatorUserId,
                ],
            );
        }
        await ownerPool.query('commit');
    } catch (error) {
        await ownerPool.query('rollback');
        throw error;
    }

    const seedRevision = async (revision) => {
        await ownerPool.query('begin isolation level serializable');
        try {
            await ownerPool.query(
                `insert into meal.recipe_revisions(id,revision,title,portions,method,change_kind,recipe_id,created_by)
                 values($1,$2,$3,2,'Focused acceptance','acceptance',$4,$5)`,
                [revision.id, revision.number, `Focused lifecycle r${revision.number}`, recipeId, author.userId],
            );
            await ownerPool.query(
                `insert into meal.moderation_cases(
                   id,kind,status,reason,submitted_at,queue_priority,evidence,reporter_id,recipe_revision_id,assigned_to
                 ) values($1,'recipe',$2,'Focused acceptance',now(),1,$3::jsonb,$4,$5,$6)`,
                [
                    revision.caseId,
                    revision.number === 6 ? 'pending' : 'approved',
                    JSON.stringify({ internalNote: `internal-r${revision.number}` }),
                    author.userId,
                    revision.id,
                    moderatorUserId,
                ],
            );
            if ([4, 5].includes(revision.number))
                await ownerPool.query(
                    `insert into meal.moderation_decisions(
                       id,action,reason,decided_at,before_snapshot,after_snapshot,case_id,actor_id
                     ) values($1,'publish','Focused concurrency acceptance',now(),'{}'::jsonb,'{}'::jsonb,$2,$3)`,
                    [revision.decisionId, revision.caseId, moderatorUserId],
                );
            await ownerPool.query('commit');
        } catch (error) {
            await ownerPool.query('rollback');
            throw error;
        }
    };

    const publish = (revision) =>
        database.transaction(async (tx) => {
            const result = await lifecycle.publish(tx, {
                caseId: revision.caseId,
                revisionId: revision.id,
                decisionId: revision.decisionId,
                actorId: moderatorUserId,
            });
            await sql`update meal.moderation_cases set status='published',version=version+1 where id=${revision.caseId}::uuid`.execute(
                tx,
            );
            return result;
        });

    const moderate = async (revision, action, publicReason = undefined) => {
        const payload = {
            action,
            category: 'focused-lifecycle',
            reason: `Internal ${action} note that must not be author-visible`,
            ...(publicReason === undefined ? {} : { publicReason }),
            version: 1,
            idempotencyKey: randomUUID(),
        };
        const response = await moderatorPost(`/api/v1/moderator/items/${revision.caseId}/decision`, payload);
        assert.equal(response.statusCode, 200, `${action}: ${response.body}`);
        assert.equal(response.json().data.status, action === 'publish' ? 'published' : 'rejected');
        assert.equal(response.json().data.version, 2);
        const replay = await moderatorPost(`/api/v1/moderator/items/${revision.caseId}/decision`, payload);
        assert.equal(replay.statusCode, 200, `${action} replay: ${replay.body}`);
        assert.equal(replay.json().data.version, 2);
        const changedReplay = await moderatorPost(`/api/v1/moderator/items/${revision.caseId}/decision`, {
            ...payload,
            reason: `${payload.reason} changed`,
        });
        assert.equal(changedReplay.statusCode, 409, changedReplay.body);
        return response;
    };

    const forbiddenPublish = await moderatorPost(`/api/v1/moderator/items/${revisions[0].caseId}/decision`, {
        action: 'publish',
        category: 'focused-lifecycle',
        reason: 'Reviewer without publish grant must be rejected',
        version: 1,
        idempotencyKey: randomUUID(),
    });
    assert.equal(forbiddenPublish.statusCode, 403, forbiddenPublish.body);
    await ownerPool.query('begin isolation level serializable');
    try {
        await ownerPool.query(
            `insert into meal.staff_grants(id,permission,scope,valid_until,revoked_at,user_id,granted_by)
             values($1,'catalog.publish','global',null,null,$2,$2)`,
            [randomUUID(), moderatorUserId],
        );
        await ownerPool.query('commit');
    } catch (error) {
        await ownerPool.query('rollback');
        throw error;
    }
    await moderate(revisions[0], 'publish');
    await moderate(revisions[1], 'reject', '  Исправьте\n\tописание  ');
    let state = await ownerPool.query(
        `select revision_id from meal.recipe_publications where recipe_id=$1 and unpublished_at is null`,
        [recipeId],
    );
    assert.deepEqual(
        state.rows.map((row) => row.revision_id),
        [revisions[0].id],
    );
    const rejectedReadback = await author.request('GET', `/api/v1/recipe-workspace/${recipeId}?scope=private`);
    assert.equal(rejectedReadback.statusCode, 200, rejectedReadback.body);
    assert.deepEqual(rejectedReadback.json().data.recipe.review, {
        revisionId: revisions[1].id,
        status: 'rejected',
        publicReason: 'Исправьте описание',
    });
    assert.equal(rejectedReadback.json().data.recipe.publication.revisionId, revisions[0].id);
    assert.equal(JSON.stringify(rejectedReadback.json()).includes('internal-r2'), false);
    assert.equal(
        JSON.stringify(rejectedReadback.json()).includes('Internal reject note that must not be author-visible'),
        false,
    );

    await seedRevision(revisions[2]);
    await moderate(revisions[2], 'publish');
    state = await ownerPool.query(
        `select revision_id,unpublished_at from meal.recipe_publications where recipe_id=$1 order by published_at,id`,
        [recipeId],
    );
    assert.equal(state.rows.filter((row) => row.unpublished_at === null).length, 1);
    assert.equal(state.rows.find((row) => row.revision_id === revisions[0].id).unpublished_at !== null, true);
    assert.equal(state.rows.find((row) => row.revision_id === revisions[2].id).unpublished_at, null);
    assert.equal(
        (await ownerPool.query(`select status from meal.moderation_cases where id=$1`, [revisions[0].caseId])).rows[0]
            .status,
        'unpublished',
    );
    const endpointEffects = await ownerPool.query(
        `select
           (select count(*)::int from meal.moderation_decisions where case_id=$1 and action='publish') r1_decisions,
           (select count(*)::int from meal.moderation_decisions where case_id=$2 and action='reject') r2_decisions,
           (select count(*)::int from meal.moderation_decisions where case_id=$3 and action='publish') r3_decisions,
           (select count(*)::int from meal.idempotency_records
             where actor_namespace=$4 and target_binding=any($5::text[])) idempotency,
           (select count(*)::int from meal.audit_events
             where actor_id=$6 and target_id=any($5::uuid[]) and action in('moderator.publish','moderator.reject')) audits`,
        [
            revisions[0].caseId,
            revisions[1].caseId,
            revisions[2].caseId,
            `moderator:${moderatorUserId}`,
            revisions.slice(0, 3).map((revision) => revision.caseId),
            moderatorUserId,
        ],
    );
    assert.deepEqual(endpointEffects.rows[0], {
        r1_decisions: 1,
        r2_decisions: 1,
        r3_decisions: 1,
        idempotency: 3,
        audits: 3,
    });

    await assert.rejects(
        database.transaction((tx) =>
            lifecycle.closeActive(tx, {
                revisionId: revisions[0].id,
                status: 'unpublished',
                sourceCaseId: revisions[0].caseId,
            }),
        ),
        conflict,
    );
    await assert.rejects(publish(revisions[0]), conflict);

    await seedRevision(revisions[3]);
    await seedRevision(revisions[4]);
    const concurrent = await Promise.allSettled([publish(revisions[3]), publish(revisions[4])]);
    assert.equal(
        concurrent.every((result) => result.status === 'fulfilled' || conflict(result.reason)),
        true,
    );
    state = await ownerPool.query(
        `select revision_id from meal.recipe_publications where recipe_id=$1 and unpublished_at is null`,
        [recipeId],
    );
    assert.deepEqual(
        state.rows.map((row) => row.revision_id),
        [revisions[4].id],
    );

    await seedRevision(revisions[5]);
    await database.transaction(async (tx) => {
        await releases.recordReputationEventIn(
            tx,
            author.userId,
            'published-own-recipe',
            recipeId,
            `recipe-published:${recipeId}`,
            { recipeId },
        );
    });
    await database.transaction(async (tx) => {
        const closed = await lifecycle.closeActive(tx, {
            revisionId: revisions[4].id,
            status: 'unpublished',
            publicReason: 'Публикация снята для проверки.',
            sourceCaseId: revisions[4].caseId,
            actorId: moderatorUserId,
        });
        await releases.reverseReputationEventByKeyIn(
            tx,
            closed.authorId,
            `recipe-published:${closed.recipeId}`,
            'published-own-recipe-reversed',
        );
        await sql`update meal.moderation_cases set status='pending' where id=${revisions[5].caseId}::uuid`.execute(tx);
        await sql`update meal.recipes set status='pending' where id=${recipeId}::uuid`.execute(tx);
    });
    const projection = await database.transaction((tx) =>
        lifecycle.projection(tx, recipeId, revisions[5].id, 'pending'),
    );
    assert.deepEqual(projection.review, { revisionId: revisions[5].id, status: 'pending', publicReason: null });
    assert.equal(projection.publication, null);

    const rollbackRows = await ownerPool.query(
        `select mc.version::int case_version,rp.id publication_id,rp.version::int publication_version,rp.unpublished_at
         from meal.moderation_cases mc join meal.recipe_publications rp on rp.revision_id=mc.recipe_revision_id
         where mc.id=$1 order by rp.published_at desc limit 1`,
        [revisions[4].caseId],
    );
    const rollbackSnapshot = {
        adapter: 'moderation',
        targetId: revisions[4].caseId,
        expectedVersion: rollbackRows.rows[0].case_version,
        before: { status: 'published' },
        after: { status: 'unpublished' },
        publication: {
            id: rollbackRows.rows[0].publication_id,
            expectedVersion: rollbackRows.rows[0].publication_version,
            beforeUnpublishedAt: null,
            afterUnpublishedAt: rollbackRows.rows[0].unpublished_at.toISOString(),
        },
    };
    const inspection = await rollback.inspect(database.db, rollbackSnapshot);
    assert.equal(inspection.ready, true);
    await database.transaction((tx) =>
        rollback.apply(
            tx,
            {
                id: moderatorUserId,
                sessionId: randomUUID(),
                context: 'admin',
                displayName: 'Focused lifecycle admin',
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
            inspection,
        ),
    );
    state = await ownerPool.query(
        `select r.status,(select count(*)::int from meal.recipe_publications where recipe_id=r.id and unpublished_at is null) active
         from meal.recipes r where r.id=$1`,
        [recipeId],
    );
    assert.deepEqual(state.rows[0], { status: 'published', active: 1 });
    const restoredState = await ownerPool.query(
        `select mc.status case_status,rp.version::int publication_version,rp.unpublished_at,
           coalesce((select sum(re.delta)::int from meal.reputation_events re
             where re.user_id=$3 and re.evidence->>'qualifyingEventKey'=$4),0) reputation_delta,
           (select count(*)::int from meal.reputation_events re
             where re.user_id=$3 and re.evidence->>'qualifyingEventKey'=$4
               and re.delta>0 and not exists(select 1 from meal.reputation_events next where next.reverses_id=re.id)) active_reputation
         from meal.moderation_cases mc join meal.recipe_publications rp on rp.id=$2
         where mc.id=$1`,
        [revisions[4].caseId, rollbackSnapshot.publication.id, author.userId, `recipe-published:${recipeId}`],
    );
    assert.equal(restoredState.rows[0].case_status, 'published');
    assert.equal(restoredState.rows[0].publication_version, rollbackSnapshot.publication.expectedVersion + 1);
    assert.equal(restoredState.rows[0].unpublished_at, null);
    assert.equal(restoredState.rows[0].reputation_delta > 0, true);
    assert.equal(restoredState.rows[0].active_reputation, 1);

    await database.transaction((tx) =>
        sql`update meal.moderation_cases set status='approved' where id=${revisions[5].caseId}::uuid`.execute(tx),
    );
    await moderate(revisions[5], 'publish');
    const staleRollbackRows = await ownerPool.query(
        `select mc.version::int case_version,rp.version::int publication_version,rp.unpublished_at
         from meal.moderation_cases mc join meal.recipe_publications rp on rp.revision_id=mc.recipe_revision_id
         where mc.id=$1 order by rp.published_at desc limit 1`,
        [revisions[4].caseId],
    );
    const blockedInspection = await rollback.inspect(database.db, {
        ...rollbackSnapshot,
        expectedVersion: staleRollbackRows.rows[0].case_version,
        publication: {
            ...rollbackSnapshot.publication,
            expectedVersion: staleRollbackRows.rows[0].publication_version,
            afterUnpublishedAt: staleRollbackRows.rows[0].unpublished_at.toISOString(),
        },
    });
    assert.equal(blockedInspection.ready, false);

    const archiveDetail = await author.request('GET', `/api/v1/recipe-workspace/${recipeId}?scope=private`);
    const archiveVersion = archiveDetail.json().data.recipe.version;
    const archived = await author.request('POST', `/api/v1/recipe-workspace/${recipeId}/archive`, {
        expectedVersion: archiveVersion,
        idempotencyKey: randomUUID(),
    });
    assert.equal(archived.statusCode, 200, archived.body);
    const restored = await author.request('POST', `/api/v1/recipe-workspace/${recipeId}/restore`, {
        expectedVersion: archived.json().data.recipe.version,
        idempotencyKey: randomUUID(),
    });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().data.recipe.publication, null);
    const archiveEffects = await ownerPool.query(
        `select
           (select count(*)::int from meal.recipe_publications where recipe_id=$1 and unpublished_at is null) active,
           coalesce((select sum(delta)::int from meal.reputation_events
             where user_id=$2 and evidence->>'qualifyingEventKey'=$3),0) reputation_delta`,
        [recipeId, author.userId, `recipe-published:${recipeId}`],
    );
    assert.deepEqual(archiveEffects.rows[0], { active: 0, reputation_delta: 0 });

    const familyScope = await ownerPool.query(
        `select ds.id from meal.data_scopes ds join meal.family_memberships fm on fm.family_id=ds.family_id
         where ds.kind='family' and fm.user_id=$1 and fm.left_at is null limit 1`,
        [author.userId],
    );
    assert.equal(familyScope.rows.length, 1);
    const criticalRecipe = randomUUID();
    const criticalPublished = { id: randomUUID(), caseId: randomUUID(), decisionId: randomUUID() };
    const criticalDraft = { id: randomUUID(), caseId: randomUUID() };
    await ownerPool.query('begin isolation level serializable');
    try {
        await ownerPool.query(
            `insert into meal.recipes(id,title,status,author_id,scope_id) values($1,'Critical family lifecycle','approved',$2,$3)`,
            [criticalRecipe, author.userId, familyScope.rows[0].id],
        );
        await ownerPool.query(
            `insert into meal.recipe_revisions(id,revision,title,portions,method,recipe_id,created_by) values
               ($1,1,'Critical published',2,'Acceptance',$3,$4),
               ($2,2,'Critical newer draft',2,'Acceptance',$3,$4)`,
            [criticalPublished.id, criticalDraft.id, criticalRecipe, author.userId],
        );
        await ownerPool.query(
            `insert into meal.moderation_cases(id,kind,status,reason,submitted_at,queue_priority,evidence,reporter_id,recipe_revision_id,assigned_to)
             values($1,'recipe','approved','Critical fixture',now(),1,'{}'::jsonb,$2,$3,$4)`,
            [criticalPublished.caseId, author.userId, criticalPublished.id, moderatorUserId],
        );
        await ownerPool.query(
            `insert into meal.moderation_decisions(id,action,reason,decided_at,before_snapshot,after_snapshot,case_id,actor_id)
             values($1,'publish','Critical fixture',now(),'{}'::jsonb,'{}'::jsonb,$2,$3)`,
            [criticalPublished.decisionId, criticalPublished.caseId, moderatorUserId],
        );
        await ownerPool.query('commit');
    } catch (error) {
        await ownerPool.query('rollback');
        throw error;
    }
    await database.transaction(async (tx) => {
        await lifecycle.publish(tx, {
            caseId: criticalPublished.caseId,
            revisionId: criticalPublished.id,
            decisionId: criticalPublished.decisionId,
            actorId: moderatorUserId,
        });
        await sql`update meal.moderation_cases set status='published',version=version+1 where id=${criticalPublished.caseId}::uuid`.execute(
            tx,
        );
        await sql`update meal.recipes set title='Critical newer draft',status='draft',version=version+1 where id=${criticalRecipe}::uuid`.execute(
            tx,
        );
    });
    const critical = await author.request('POST', `/api/v1/recipe-workspace/${criticalRecipe}/reports`, {
        idempotencyKey: randomUUID(),
        reason: 'dangerous',
        comment: 'Focused global hide',
        commentId: null,
    });
    assert.equal(critical.statusCode, 200, critical.body);
    const criticalState = await ownerPool.query(
        `select r.status,
           (select count(*)::int from meal.recipe_publications where recipe_id=r.id and unpublished_at is null) active,
           (select status from meal.moderation_cases where id=$2) published_case_status
         from meal.recipes r where r.id=$1`,
        [criticalRecipe, criticalPublished.caseId],
    );
    assert.deepEqual(criticalState.rows[0], { status: 'hidden', active: 0, published_case_status: 'hidden' });

    const effects = {
        rejectedPreservedR1: true,
        replacementClosedR1: true,
        currentReviewAndPublicationAxes: true,
        moderatorEndpointCasReplayAudit: true,
        catalogPublishGrantEnforced: true,
        staleCloseConflict: true,
        downgradeConflict: true,
        concurrentNewerWinner: true,
        sanitizedPublicReason: true,
        internalNoteHidden: true,
        rollbackRestored: true,
        rollbackBlockedByNewerActive: true,
        criticalOldActiveNewDraftHidden: true,
        archiveRestoreNoRepublish: true,
    };
    console.log(
        `RECIPE_LIFECYCLE_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'recipe-revision-lifecycle-live-v1',
            recipeId,
            effects,
        })}`,
    );
    return { schema: 'recipe-revision-lifecycle-live-v1', recipeId, effects };
}
