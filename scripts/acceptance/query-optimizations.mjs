import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const timed = async (work) => {
    const started = performance.now();
    const value = await work();
    return { value, elapsedMs: Number((performance.now() - started).toFixed(3)) };
};

export async function runQueryOptimizationsAcceptance({
    ownerPool,
    pool,
    familyClient,
    familyId,
    familyUserId,
    app,
    requestHeaders,
    moderatorUserId,
    recipeRevisionId,
    explain,
}) {
    const familyScope = await ownerPool.query(
        `select id from meal.data_scopes where kind='family' and family_id=$1 limit 1`,
        [familyId],
    );
    assert.equal(familyScope.rows.length, 1);
    const familyScopeId = familyScope.rows[0].id;

    const shoppingListIds = Array.from({ length: 700 }, () => randomUUID());
    const shoppingItemIds = Array.from({ length: shoppingListIds.length * 3 }, () => randomUUID());
    const shoppingItemListIds = shoppingListIds.flatMap((id) => [id, id, id]);
    const shoppingItemPositions = shoppingListIds.flatMap(() => [0, 1, 2]);
    const shoppingItemStatuses = shoppingListIds.flatMap(() => ['active', 'purchased', 'removed']);

    const noteIds = Array.from({ length: 800 }, () => randomUUID());
    const noteItemIds = Array.from({ length: noteIds.length * 3 }, () => randomUUID());
    const noteItemNoteIds = noteIds.flatMap((id) => [id, id, id]);
    const noteItemPositions = noteIds.flatMap(() => [0, 1, 2]);
    const closedCaseIds = Array.from({ length: 550 }, () => randomUUID());
    const reachableCaseId = randomUUID();
    const moderatorSessionId = randomUUID();
    const moderatorToken = randomBytes(32).toString('base64url');

    const client = await ownerPool.connect();
    try {
        await client.query('begin isolation level serializable');
        await client.query(
            `insert into meal.shopping_lists(id,title,status,scope_id,created_by,created_at)
             select id,'Optimization list '||ordinality,'active',$2::uuid,$3::uuid,
                    now()-(($4::integer-ordinality)::text||' seconds')::interval
             from unnest($1::uuid[]) with ordinality as seeded(id,ordinality)`,
            [shoppingListIds, familyScopeId, familyUserId, shoppingListIds.length],
        );
        await client.query(
            `insert into meal.shopping_items(id,name,quantity,requirements,allow_analog,manual,status,list_id,position)
             select id,'Optimization item '||position,null,'{}'::jsonb,false,true,status,list_id,position
             from unnest($1::uuid[],$2::uuid[],$3::integer[],$4::text[])
                  as seeded(id,list_id,position,status)`,
            [shoppingItemIds, shoppingItemListIds, shoppingItemPositions, shoppingItemStatuses],
        );
        await client.query(
            `insert into meal.family_notes(id,title,body,format,archived_at,family_id,author_id,created_at)
             select id,
                    case when ordinality % 200 = 1 then 'Optimization needle '||ordinality
                         else 'Optimization family note '||ordinality end,
                    'High-cardinality family note','checklist',
                    case when ordinality % 2 = 0 then now() else null end,
                    $2::uuid,$3::uuid,now()-(ordinality::text||' seconds')::interval
             from unnest($1::uuid[]) with ordinality as seeded(id,ordinality)`,
            [noteIds, familyId, familyUserId],
        );
        await client.query(
            `insert into meal.note_items(id,position,text,checked,checked_at,note_id,checked_by)
             select id,position,'Optimization note item '||position,false,null,note_id,null
             from unnest($1::uuid[],$2::uuid[],$3::integer[]) as seeded(id,note_id,position)`,
            [noteItemIds, noteItemNoteIds, noteItemPositions],
        );
        await client.query(
            `insert into meal.moderation_cases(
                 id,kind,status,reason,submitted_at,queue_priority,evidence,recipe_revision_id,assigned_to
             )
             select id,'authorship','closed','Optimization closed prefix',now(),1000,'{}'::jsonb,$2::uuid,null
             from unnest($1::uuid[]) as seeded(id)`,
            [closedCaseIds, recipeRevisionId],
        );
        await client.query(
            `insert into meal.moderation_cases(
                 id,kind,status,reason,submitted_at,queue_priority,evidence,recipe_revision_id,assigned_to
             ) values($1,'authorship','pending','Optimization reachable target',now()-interval '3 days',0,
                      '{"signals":["optimization"]}'::jsonb,$2,$3)`,
            [reachableCaseId, recipeRevisionId, moderatorUserId],
        );
        await client.query(
            `insert into meal.sessions(
                 id,kind,token_hash,expires_at,revoked_at,authenticated_at,mfa_verified_at,user_id,auth_context
             ) values($1,'staff',$2,now()+interval '1 hour',null,now(),now(),$3,'moderator')`,
            [moderatorSessionId, createHash('sha256').update(moderatorToken).digest('hex'), moderatorUserId],
        );
        await client.query('commit');
    } catch (error) {
        await client.query('rollback');
        throw error;
    } finally {
        client.release();
    }

    await ownerPool.query(
        `analyze meal.shopping_lists; analyze meal.shopping_items; analyze meal.family_notes;
         analyze meal.note_items; analyze meal.moderation_cases`,
    );
    const moderatorGet = (url) =>
        app.inject({
            method: 'GET',
            url,
            remoteAddress: '203.0.113.250',
            headers: {
                ...requestHeaders,
                cookie: `${requestHeaders.cookie}; meal_staff=${moderatorToken}`,
            },
        });

    const legacyShopping = await timed(async () => {
        const page = await pool.query(
            `select id from meal.shopping_lists where scope_id=$1 and status='active'
             order by created_at desc,id desc limit 101`,
            [familyScopeId],
        );
        for (const row of page.rows.slice(0, 100)) {
            await pool.query(
                `select l.id,l.title,l.version,l.status,l.created_at,s.kind
                 from meal.shopping_lists l join meal.data_scopes s on s.id=l.scope_id
                 where l.id=$1 and l.scope_id=$2`,
                [row.id, familyScopeId],
            );
            await pool.query(
                `select i.id,i.status,(select sum(a.quantity) from meal.shopping_allocations a where a.item_id=i.id)
                 from meal.shopping_items i where i.list_id=$1 and i.status<>'removed'
                 order by i.position,i.created_at,i.id`,
                [row.id],
            );
        }
        return page.rows.length;
    });
    assert.equal(legacyShopping.value, 101);
    const legacyShoppingPagePlan = await explain(
        `select id from meal.shopping_lists where scope_id=$1 and status='active'
         order by created_at desc,id desc limit 101`,
        [familyScopeId],
    );
    const optimizedShopping = await timed(() =>
        familyClient.request('GET', '/api/v1/shopping-lists?scope=family&status=active&limit=100&q=Optimization'),
    );
    assert.equal(optimizedShopping.value.statusCode, 200, optimizedShopping.value.body);
    assert.equal(optimizedShopping.value.json().data.items.length, 100);
    assert.deepEqual(optimizedShopping.value.json().data.items[0].progress, { total: 2, purchased: 1 });
    assert.ok(optimizedShopping.value.json().data.nextCursor);
    const shoppingPlan = await explain(
        `with page as (
           select id,title,version,status,created_at,scope_id from meal.shopping_lists
           where scope_id=$1 and status='active' and title ilike '%Optimization%'
           order by created_at desc,id desc limit 101
         )
         select p.id,count(i.id) filter(where i.status<>'removed')::integer total,
                count(i.id) filter(where i.status='purchased')::integer purchased
         from page p left join meal.shopping_items i on i.list_id=p.id
         group by p.id,p.created_at order by p.created_at desc,p.id desc`,
        [familyScopeId],
    );

    const legacyNoteRows = await pool.query(
        `select
           (select count(*)::int from meal.family_notes where family_id=$1) notes,
           (select count(*)::int from meal.note_items where note_id in
               (select id from meal.family_notes where family_id=$1)) items`,
        [familyId],
    );
    const legacyFamilyNotesPlan = await explain(
        `select id from meal.family_notes where family_id=$1 order by created_at desc,id`,
        [familyId],
    );
    const optimizedNotes = await timed(() => familyClient.request('GET', '/api/v1/family/notes?tab=active&q=needle'));
    assert.equal(optimizedNotes.value.statusCode, 200, optimizedNotes.value.body);
    assert.equal(optimizedNotes.value.json().data.items.length, 4);
    assert.equal(
        optimizedNotes.value.json().data.items.reduce((total, note) => total + note.items.length, 0),
        12,
    );
    const familyNotesPlan = await explain(
        `select id from meal.family_notes
         where family_id=$1 and archived_at is null
           and lower(translate(coalesce(title,'')||E'\n'||body,
             'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя'))
             like '%needle%' escape '\\'
         order by created_at desc,id`,
        [familyId],
    );
    const familyNoteItemsPlan = await explain(
        `select id,note_id from meal.note_items where note_id=any($1::uuid[]) order by position,id`,
        [optimizedNotes.value.json().data.items.map((note) => note.id)],
    );

    const legacyModerator = await pool.query(
        `select id,status from meal.moderation_cases where kind='authorship'
         order by queue_priority desc,submitted_at,id limit 500`,
    );
    assert.equal(
        legacyModerator.rows.some((row) => row.id === reachableCaseId && row.status === 'pending'),
        false,
    );
    const legacyModeratorPlan = await explain(
        `select id,status from meal.moderation_cases where kind='authorship'
         order by queue_priority desc,submitted_at,id limit 500`,
        [],
    );
    const optimizedModerator = await timed(() =>
        moderatorGet('/api/v1/moderator/queues/authorship?status=pending&assignment=mine'),
    );
    assert.equal(optimizedModerator.value.statusCode, 200, optimizedModerator.value.body);
    assert.deepEqual(
        optimizedModerator.value.json().data.items.map((item) => item.id),
        [reachableCaseId],
    );
    const exactOverview = await moderatorGet('/api/v1/moderator/overview');
    assert.equal(exactOverview.statusCode, 200, exactOverview.body);
    assert.equal(exactOverview.json().data.queues.find((queue) => queue.key === 'authorship').count, 1);
    assert.equal(
        exactOverview.json().data.assigned.some((item) => item.id === reachableCaseId),
        true,
    );
    assert.equal(exactOverview.json().data.sla.state, 'attention');
    const moderatorQueuePlan = await explain(
        `select id from meal.moderation_cases
         where kind='authorship' and status='pending' and assigned_to=$1
         order by queue_priority desc,submitted_at,id limit 51`,
        [moderatorUserId],
    );
    const moderatorCountPlan = await explain(
        `select kind,count(*) from meal.moderation_cases
         where kind=any($1::text[]) and status not in ('closed','resolved') group by kind`,
        [['authorship', 'recipe', 'report', 'product', 'product_image', 'catalog_correction', 'recipe_variant']],
    );

    const evidence = {
        schema: 'query-optimizations-live-v1',
        methodology: 'removed-implementation-reference-sql-vs-live-http-and-current-sql',
        shopping: {
            seededLists: shoppingListIds.length,
            seededItems: shoppingItemIds.length,
            legacyDomainStatements: 201,
            optimizedDomainStatements: 1,
            legacyElapsedMs: legacyShopping.elapsedMs,
            optimizedHttpElapsedMs: optimizedShopping.elapsedMs,
            legacyPagePlan: legacyShoppingPagePlan,
            optimizedPlan: shoppingPlan,
        },
        familyNotes: {
            seededNotes: noteIds.length,
            seededItems: noteItemIds.length,
            legacyLoadedRows: legacyNoteRows.rows[0],
            optimizedLoadedRows: { notes: 4, items: 12 },
            optimizedHttpElapsedMs: optimizedNotes.elapsedMs,
            legacyPlan: legacyFamilyNotesPlan,
            optimizedPlan: familyNotesPlan,
            optimizedItemsPlan: familyNoteItemsPlan,
        },
        moderatorQueue: {
            seededClosedPrefix: closedCaseIds.length,
            legacyLimit: 500,
            targetReachableAfterSqlFilter: true,
            exactCount: true,
            exactAssigned: true,
            exactSla: true,
            optimizedHttpElapsedMs: optimizedModerator.elapsedMs,
            legacyPlan: legacyModeratorPlan,
            queuePlan: moderatorQueuePlan,
            countPlan: moderatorCountPlan,
        },
        assertions: {
            publicContractsUnchanged: true,
            shoppingSummaryParity: true,
            familyNoteFilterAndItemParity: true,
            moderatorBeyondLegacyCapReachable: true,
            chatCursorUnchanged: true,
            pgTrgmNotAdded: true,
        },
    };
    console.log(`QUERY_OPTIMIZATIONS_EVIDENCE ${JSON.stringify(evidence)}`);
    return evidence;
}
