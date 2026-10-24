import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const expectStatus = (response, status, label) => {
    assert.equal(response.statusCode, status, `${label}: ${response.body}`);
    return response;
};

const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function runAdminDomainAcceptance({
    app,
    pool,
    ownerPool,
    adminHeaders,
    adminUserId,
    adminSessionId,
    userId,
    privateScopeId,
    ingredientId,
    unitId,
    suffix,
}) {
    let requestIndex = 0;
    const request = (method, url, payload, requestHeaders = adminHeaders()) =>
        app.inject({
            method,
            url,
            headers: requestHeaders,
            remoteAddress: `198.31.0.${(++requestIndex % 240) + 1}`,
            ...(payload === undefined ? {} : { payload }),
        });
    const expectError = async (promise, status, label) => {
        const response = await promise;
        expectStatus(response, status, label);
        assert.ok(response.json().error?.code, `${label}: error envelope`);
        return response;
    };
    const replay = async (method, url, payload, status, label) => {
        const first = expectStatus(await request(method, url, payload), status, label);
        const second = expectStatus(await request(method, url, payload), status, `${label} replay`);
        assert.deepEqual(second.json().data, first.json().data, `${label}: replay response`);
        return first;
    };
    const replayIgnoringMessage = async (method, url, payload, status, label) => {
        const first = expectStatus(await request(method, url, payload), status, label);
        const second = expectStatus(await request(method, url, payload), status, `${label} replay`);
        const { message: _firstMessage, ...firstState } = first.json().data;
        const { message: _secondMessage, ...secondState } = second.json().data;
        assert.deepEqual(secondState, firstState, `${label}: replay state`);
        return first;
    };
    const ids = {
        allergen: randomUUID(),
        variant: randomUUID(),
        brand: randomUUID(),
        productLeft: randomUUID(),
        productRight: randomUUID(),
        compositionLeft: randomUUID(),
        compositionRight: randomUUID(),
        recipe: randomUUID(),
        revision: randomUUID(),
        moderationCase: randomUUID(),
        targetUser: randomUUID(),
        notification: randomUUID(),
        reviewRelease: randomUUID(),
        reviewEvent: randomUUID(),
        compensationRequest: randomUUID(),
        compensationItem: randomUUID(),
        compensationSourceAudit: randomUUID(),
    };
    const allergenCode = `acceptance-${suffix}`;
    const targetLogin = `admin_target_${suffix}`;
    const owner = await ownerPool.connect();
    try {
        await owner.query('begin isolation level serializable');
        await owner.query(`update meal.sessions set admin_critical_until=now()+interval '30 minutes' where id=$1`, [
            adminSessionId,
        ]);
        await owner.query(`insert into meal.allergens(id,code,name) values($1,$2,$3)`, [
            ids.allergen,
            allergenCode,
            `Acceptance allergen ${suffix}`,
        ]);
        await owner.query(
            `insert into meal.ingredient_variants(id,name,attributes,status,ingredient_id)
             values($1,$2,'{}'::jsonb,'active',$3)`,
            [ids.variant, `Acceptance variant ${suffix}`, ingredientId],
        );
        await owner.query(`insert into meal.brands(id,name,country_code) values($1,$2,'RU')`, [
            ids.brand,
            `Acceptance brand ${suffix}`,
        ]);
        await owner.query(
            `insert into meal.brand_products(id,name,package_quantity,status,variant_id,brand_id,package_unit_id)
             values($1,$2,1,'active',$3,$4,$5),($6,$7,1,'active',$3,$4,$5)`,
            [
                ids.productLeft,
                `Acceptance card A ${suffix}`,
                ids.variant,
                ids.brand,
                unitId,
                ids.productRight,
                `Acceptance card B ${suffix}`,
            ],
        );
        for (const [compositionId, productId] of [
            [ids.compositionLeft, ids.productLeft],
            [ids.compositionRight, ids.productRight],
        ])
            await owner.query(
                `insert into meal.composition_versions(
                   id,revision,composition_text,kcal,protein,fat,carbs,basis_quantity,source,confidence,
                   dietary_flags,ingredient_id,variant_id,product_id,basis_unit_id
                 ) values($1,1,'water',0,0,0,0,100,'acceptance',1,'{}'::jsonb,null,null,$2,$3)`,
                [compositionId, productId, unitId],
            );
        await owner.query(
            `insert into meal.recipes(id,title,status,archived_at,author_id,scope_id)
             values($1,$2,'draft',null,$3,$4)`,
            [ids.recipe, `Admin content recipe ${suffix}`, userId, privateScopeId],
        );
        await owner.query(
            `insert into meal.recipe_revisions(id,revision,title,portions,method,nutrition_snapshot,timing,change_kind,recipe_id,created_by)
             values($1,1,$2,2,'Acceptance method',null,null,'admin-content',$3,$4)`,
            [ids.revision, `Admin content recipe ${suffix}`, ids.recipe, userId],
        );
        await owner.query(
            `insert into meal.moderation_cases(
               id,kind,status,reason,submitted_at,queue_priority,evidence,recipe_revision_id,assigned_to
             ) values($1,'recipe','pending','Admin content acceptance',now(),1,'{}'::jsonb,$2,$3)`,
            [ids.moderationCase, ids.revision, adminUserId],
        );
        await owner.query(
            `insert into meal.users(id,login,display_name,email_normalized,status,archived_at,email_verified_at,is_test_account)
             values($1,$2,'Governance target',$3,'active',null,now(),true)`,
            [ids.targetUser, targetLogin, `${targetLogin}@example.test`],
        );
        await owner.query(
            `insert into meal.notifications(
               id,category,priority,payload_minimized,dedup_key,available_at,read_at,fullscreen_seen_at,user_id,
               ownership_transfer_id,announcement_id
             ) values($1,'support','important',$2::jsonb,$3,now(),null,null,$4,null,null)`,
            [
                ids.notification,
                JSON.stringify({ title: 'Acceptance notification', summary: 'Inspect the admin notification center.' }),
                `admin-domain:${suffix}`,
                adminUserId,
            ],
        );
        await owner.query(
            `insert into meal.content_releases(
               id,name,status,revision,source_release_id,rolled_back_from_event_id,created_by,published_by,published_at,version
             ) values($1,$2,'published',1,null,null,$3,$3,now(),1)`,
            [ids.reviewRelease, `Review release ${suffix}`, adminUserId],
        );
        await owner.query(
            `insert into meal.content_release_events(id,release_id,kind,snapshot,inverse_snapshot,created_by)
             values($1,$2,'published','[]'::jsonb,'[]'::jsonb,$3)`,
            [ids.reviewEvent, ids.reviewRelease, adminUserId],
        );
        await owner.query(
            `insert into meal.audit_events(
               id,action,target_type,target_id,effective_at,recorded_at,request_id,actor_id
             ) values($1,'acceptance.source','content-release',$2,now(),now(),$3,$4)`,
            [ids.compensationSourceAudit, ids.reviewRelease, randomUUID(), adminUserId],
        );
        await owner.query(
            `insert into meal.compensation_requests(
               id,mode,status,preview,reason,applied_at,requested_by,scope_id,version
             ) values($1,'admin','pending','{}'::jsonb,'Acceptance rollback',null,$2,null,1)`,
            [ids.compensationRequest, adminUserId],
        );
        await owner.query(
            `insert into meal.compensation_items(
               id,status,dependency_snapshot,result,request_id,source_event_id,result_event_id,version
             ) values($1,'pending',$2::jsonb,'{}'::jsonb,$3,$4,null,1)`,
            [
                ids.compensationItem,
                JSON.stringify({
                    adapter: 'content-release',
                    targetId: ids.reviewRelease,
                    expectedVersion: 1,
                    before: { status: 'draft' },
                    after: { status: 'published' },
                }),
                ids.compensationRequest,
                ids.compensationSourceAudit,
            ],
        );
        await owner.query('commit');
    } catch (error) {
        await owner.query('rollback');
        throw error;
    } finally {
        owner.release();
    }

    await expectError(request('GET', '/api/v1/admin/allergens', undefined, {}), 401, 'admin allergen auth gate');
    const allergenList = expectStatus(await request('GET', '/api/v1/admin/allergens'), 200, 'admin allergen list');
    assert.equal(
        allergenList.json().data.items.some((item) => item.code === allergenCode),
        true,
    );
    const subjects = expectStatus(
        await request(
            'GET',
            `/api/v1/admin/allergens/subjects?subjectType=ingredient&q=${encodeURIComponent(suffix)}&limit=10`,
        ),
        200,
        'admin allergen subjects',
    );
    assert.equal(
        subjects.json().data.items.some((item) => item.subjectId === ingredientId),
        true,
    );
    expectStatus(await request('GET', `/api/v1/admin/allergens/${allergenCode}`), 200, 'admin allergen detail');
    const mappingKey = randomUUID();
    const mappingPayload = {
        action: 'add',
        subjectType: 'ingredient',
        subjectId: ingredientId,
        status: 'contains',
        source: 'Acceptance verified source',
        mappingId: null,
        expectedVersion: 1,
        idempotencyKey: mappingKey,
    };
    const mapping = await replay(
        'POST',
        `/api/v1/admin/allergens/${allergenCode}/mappings`,
        mappingPayload,
        200,
        'admin allergen mapping',
    );
    assert.equal(mapping.json().data.activeMappings, 1);
    await expectError(
        request('POST', `/api/v1/admin/allergens/${allergenCode}/mappings`, {
            ...mappingPayload,
            source: 'Changed replay',
        }),
        409,
        'admin allergen changed replay',
    );
    const iconPayload = {
        action: 'set_fallback',
        fallbackKey: 'allergen-acceptance',
        altText: 'Acceptance allergen icon',
        expectedVersion: 2,
        idempotencyKey: randomUUID(),
    };
    const icon = await replay(
        'PUT',
        `/api/v1/admin/allergens/${allergenCode}/icon`,
        iconPayload,
        200,
        'admin allergen icon',
    );
    assert.equal(icon.json().data.icon.fallbackKey, iconPayload.fallbackKey);
    const allergenEffects = await pool.query(
        `select a.version::int,
          (select count(*)::int from meal.allergen_mappings m where m.allergen_id=a.id and m.removed_at is null) mappings,
          (select count(*)::int from meal.allergen_icons i where i.allergen_id=a.id and i.fallback_key=$2) icons,
          (select count(*)::int from meal.audit_events e where e.target_id=a.id and e.action like 'admin.allergen.%') audits,
          (select count(*)::int from meal.idempotency_records i where i.target_binding=a.id::text and i.operation like 'admin.allergen.%') idempotency
         from meal.allergens a where a.id=$1`,
        [ids.allergen, iconPayload.fallbackKey],
    );
    assert.deepEqual(allergenEffects.rows[0], { version: 3, mappings: 1, icons: 1, audits: 2, idempotency: 2 });

    const queueLoad = expectStatus(
        await request('GET', `/api/v1/admin/content-workspace/queues/${ids.moderationCase}`),
        200,
        'admin content queue load',
    );
    assert.equal(queueLoad.json().data.pending.id, ids.revision);
    const moderatePayload = { action: 'approve', version: 1, reason: '', idempotencyKey: randomUUID() };
    const moderateUrl = `/api/v1/admin/content-workspace/queues/${ids.moderationCase}/moderate`;
    const moderated = await replayIgnoringMessage('POST', moderateUrl, moderatePayload, 200, 'admin content moderate');
    assert.equal(moderated.json().data.status, 'approved');
    const catalogLoad = expectStatus(
        await request('GET', `/api/v1/admin/content-workspace/catalog/${ids.productLeft}`),
        200,
        'admin content catalog load',
    );
    const comparePayload = {
        leftId: ids.productLeft,
        rightId: ids.productRight,
        leftVersion: 1,
        rightVersion: 1,
        canonicalId: ids.productLeft,
        choices: { name: 'left' },
    };
    const compared = expectStatus(
        await request('POST', `/api/v1/admin/content-workspace/catalog/${ids.productLeft}/compare`, comparePayload),
        200,
        'admin content compare',
    );
    assert.equal(compared.json().data.comparison.blockedReason, null);
    const notDuplicatePayload = {
        leftId: ids.productLeft,
        rightId: ids.productRight,
        leftVersion: 1,
        rightVersion: 1,
        reason: 'Acceptance cards are distinct',
        idempotencyKey: randomUUID(),
    };
    await replayIgnoringMessage(
        'POST',
        `/api/v1/admin/content-workspace/catalog/${ids.productLeft}/not-duplicate`,
        notDuplicatePayload,
        200,
        'admin content not duplicate',
    );
    const mergePayload = {
        ...comparePayload,
        previewKey: compared.json().data.comparison.previewKey,
        reason: 'Acceptance duplicate merge',
        idempotencyKey: randomUUID(),
    };
    const mergeUrl = `/api/v1/admin/content-workspace/catalog/${ids.productLeft}/merge`;
    const mergeResponse = await request('POST', mergeUrl, mergePayload);
    const merged = expectStatus(mergeResponse, 200, 'admin content merge');
    const mergedReplay = expectStatus(await request('POST', mergeUrl, mergePayload), 200, 'admin content merge replay');
    const { message: _mergedMessage, ...mergedState } = merged.json().data;
    const { message: _mergedReplayMessage, ...mergedReplayState } = mergedReplay.json().data;
    assert.deepEqual(mergedReplayState, mergedState);
    assert.equal(merged.json().data.cards.find((item) => item.id === ids.productRight).aliasOf, ids.productLeft);
    const contentEffects = await pool.query(
        `select
          (select status from meal.moderation_cases where id=$1) moderation_status,
          (select count(*)::int from meal.recipe_publications where revision_id=$2 and unpublished_at is null) publications,
          (select count(*)::int from meal.catalog_merges where source_product_id=$3 and target_product_id=$4 and status='applied') merges,
          (select count(*)::int from meal.catalog_merges where source_product_id=$4 and target_product_id=$3 and status='closed') distinct_pairs`,
        [ids.moderationCase, ids.revision, ids.productRight, ids.productLeft],
    );
    assert.deepEqual(contentEffects.rows[0], {
        moderation_status: 'approved',
        publications: 1,
        merges: 1,
        distinct_pairs: 1,
    });

    const releaseCreatePayload = { name: `Acceptance release ${suffix}`, idempotencyKey: randomUUID() };
    const releaseCreated = await replay(
        'POST',
        '/api/v1/admin/content-releases',
        releaseCreatePayload,
        201,
        'content release create',
    );
    const releaseId = releaseCreated.json().data.id;
    const patches = Array.from({ length: 10 }, (_, index) => ({
        patchId: randomUUID(),
        expectedVersion: 0,
        resourceType: 'reputation_title',
        action: 'create',
        resourceKey: `acceptance-level-${suffix}-${index + 1}`,
        payload: { level: index + 1, threshold: index * 100, title: `Acceptance level ${index + 1}` },
    }));
    const saveBase = { name: releaseCreatePayload.name, patches, clientRevision: 1 };
    const releaseSavePayload = {
        ...saveBase,
        expectedVersion: 1,
        checksum: sha256(saveBase),
        idempotencyKey: randomUUID(),
    };
    const saveUrl = `/api/v1/admin/content-releases/${releaseId}`;
    const saveResponse = await request('PUT', saveUrl, releaseSavePayload);
    const releaseSaved = expectStatus(saveResponse, 200, 'content release save');
    const saveReplay = expectStatus(
        await request('PUT', saveUrl, releaseSavePayload),
        200,
        'content release save replay',
    );
    assert.deepEqual(saveReplay.json().data, releaseSaved.json().data);
    assert.equal(releaseSaved.json().data.validation.valid, true);
    expectStatus(await request('GET', '/api/v1/admin/content-releases'), 200, 'content release list');
    expectStatus(await request('GET', `/api/v1/admin/content-releases/${releaseId}`), 200, 'content release detail');
    expectStatus(await request('GET', '/api/v1/admin/content-releases/sources'), 200, 'content release sources');
    expectStatus(
        await request('POST', `/api/v1/admin/content-releases/${releaseId}/validate`, { expectedVersion: 2 }),
        200,
        'content release validate',
    );
    await expectError(
        request('POST', `/api/v1/admin/content-releases/${releaseId}/validate`, { expectedVersion: 1 }),
        409,
        'content release stale validate',
    );
    const publishPayload = { expectedVersion: 2, idempotencyKey: randomUUID() };
    const releasePublished = await replay(
        'POST',
        `/api/v1/admin/content-releases/${releaseId}/publish`,
        publishPayload,
        200,
        'content release publish',
    );
    assert.equal(releasePublished.json().data.status, 'published');
    expectStatus(await request('GET', '/api/v1/admin/content-releases/history'), 200, 'content release history');
    const edited = await replay(
        'POST',
        `/api/v1/admin/content-releases/${releaseId}/edit`,
        { name: `Acceptance release copy ${suffix}`, idempotencyKey: randomUUID() },
        200,
        'content release edit',
    );
    assert.equal(edited.json().data.sourceReleaseId, releaseId);
    const rollbackPayload = { expectedVersion: 3, idempotencyKey: randomUUID() };
    const releaseRolledBack = await replay(
        'POST',
        `/api/v1/admin/content-releases/${releaseId}/rollback`,
        rollbackPayload,
        200,
        'content release rollback',
    );
    assert.equal(releaseRolledBack.json().data.status, 'draft');
    const releaseEffects = await pool.query(
        `select r.status,r.version::int,
          (select count(*)::int from meal.content_release_events e where e.release_id=r.id) events,
          (select count(*)::int from meal.idempotency_records i where i.actor_namespace=$2 and i.operation like 'content-release.%') idempotency
         from meal.content_releases r where r.id=$1`,
        [releaseId, `admin:${adminUserId}`],
    );
    assert.deepEqual(releaseEffects.rows[0], { status: 'draft', version: 4, events: 2, idempotency: 5 });

    const governanceView = expectStatus(
        await request('GET', `/api/v1/admin/governance/users/${ids.targetUser}`),
        200,
        'admin governance view',
    );
    assert.equal(governanceView.json().data.status, 'active');
    const governancePayload = {
        version: '1',
        idempotencyKey: randomUUID(),
        action: 'ban',
        category: 'rules',
        scope: 'ai',
        startsAt: null,
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        reason: 'Acceptance governance restriction',
        privateNote: 'Acceptance only',
        allowTemporaryBan: true,
        subscriptionDisposition: 'keep',
        subscriptionRecipientUserId: null,
        confirmed: true,
    };
    const governance = await replay(
        'POST',
        `/api/v1/admin/governance/users/${ids.targetUser}`,
        governancePayload,
        200,
        'admin governance command',
    );
    const sanctionId = governance.json().data.id;
    await expectError(
        request('POST', `/api/v1/admin/governance/users/${ids.targetUser}`, {
            ...governancePayload,
            reason: 'Changed replay',
        }),
        409,
        'admin governance changed replay',
    );
    const sanction = await pool.query(
        `select scope,category,version::int,
          (select count(*)::int from meal.audit_events where target_id=$1 and action='admin.governance.ban') audits
         from meal.sanctions where id=$1`,
        [sanctionId],
    );
    assert.deepEqual(sanction.rows[0], { scope: 'ai', category: 'rules', version: 1, audits: 1 });

    const content = {
        type: 'article',
        title: `Acceptance news ${suffix}`,
        pages: [{ blocks: [{ kind: 'text', text: 'Acceptance in-app announcement.' }] }],
        sources: [],
        audience: {
            plans: [],
            genders: [],
            families: [],
            registeredFrom: null,
            registeredTo: null,
            activeFrom: null,
            activeTo: null,
        },
        channels: ['in_app'],
        category: 'service',
    };
    const newsId = randomUUID();
    const newsSave = await replay(
        'POST',
        '/api/v1/admin/news-workspace/save',
        { action: 'save', id: newsId, version: 0, content, idempotencyKey: randomUUID() },
        200,
        'admin news save',
    );
    assert.equal(newsSave.json().data.items.find((item) => item.id === newsId).status, 'draft');
    expectStatus(await request('GET', '/api/v1/admin/news-workspace'), 200, 'admin news list');
    const newsPreview = expectStatus(
        await request('POST', '/api/v1/admin/news-workspace/preview', { action: 'preview', id: newsId, version: 1 }),
        200,
        'admin news preview',
    );
    assert.equal(newsPreview.json().data.preview.preliminary, true);
    await replay(
        'POST',
        '/api/v1/admin/news-workspace/test',
        { action: 'test', id: newsId, version: 1, idempotencyKey: randomUUID(), recipients: ['admin'] },
        200,
        'admin news test',
    );
    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    await replay(
        'POST',
        '/api/v1/admin/news-workspace/launch',
        { action: 'launch', id: newsId, version: 1, idempotencyKey: randomUUID(), scheduledAt },
        200,
        'admin news launch',
    );
    await replay(
        'POST',
        '/api/v1/admin/news-workspace/cancel',
        { action: 'cancel', id: newsId, version: 2, idempotencyKey: randomUUID() },
        200,
        'admin news cancel',
    );
    const newsEffects = await pool.query(
        `select a.status,a.version::int,
          (select count(*)::int from meal.notifications n where n.announcement_id=a.id) notifications,
          (select count(*)::int from meal.audit_events e where e.target_id=a.id and e.action like 'admin.news.%') audits
         from meal.announcements a where a.id=$1`,
        [newsId],
    );
    assert.deepEqual(newsEffects.rows[0], { status: 'cancelled', version: 3, notifications: 1, audits: 4 });

    const notificationRead = expectStatus(
        await request('GET', '/api/v1/admin/notification-center'),
        200,
        'admin notification center read',
    );
    assert.equal(
        notificationRead.json().data.items.some((item) => item.id === ids.notification),
        true,
    );
    const settings = structuredClone(notificationRead.json().data.settings);
    settings.categories.operations.browser = true;
    settings.quietHours = { start: '23:00', end: '07:00', timeZone: 'Asia/Yekaterinburg' };
    const updatedSettings = expectStatus(
        await request('POST', '/api/v1/admin/notification-center/settings', {
            expectedVersion: notificationRead.json().data.version,
            settings,
        }),
        200,
        'admin notification settings',
    );
    assert.equal(updatedSettings.json().data.settings.categories.operations.browser, true);
    await expectError(
        request('POST', '/api/v1/admin/notification-center/settings', { expectedVersion: 99, settings }),
        409,
        'admin notification stale settings',
    );
    const marked = expectStatus(
        await request('POST', '/api/v1/admin/notification-center/read', { id: ids.notification }),
        200,
        'admin notification mark read',
    );
    assert.ok(marked.json().data.items.find((item) => item.id === ids.notification).readAt);
    const markedAgain = expectStatus(
        await request('POST', '/api/v1/admin/notification-center/read', { id: ids.notification }),
        200,
        'admin notification mark read replay',
    );
    assert.equal(
        markedAgain.json().data.items.find((item) => item.id === ids.notification).readAt,
        marked.json().data.items.find((item) => item.id === ids.notification).readAt,
    );

    const reviewLoad = expectStatus(
        await request('GET', `/api/v1/admin/review-workspace/rollback/${ids.compensationRequest}`),
        200,
        'admin review load',
    );
    assert.equal(reviewLoad.json().data.items[0].state, 'ready');
    const reviewPreview = expectStatus(
        await request('POST', `/api/v1/admin/review-workspace/rollback/${ids.compensationRequest}/preview`, {
            version: 1,
        }),
        200,
        'admin review preview',
    );
    assert.ok(reviewPreview.json().data.previewKey);
    const reviewApplyPayload = {
        version: 1,
        previewKey: reviewPreview.json().data.previewKey,
        reason: 'Acceptance registered rollback',
        idempotencyKey: randomUUID(),
    };
    const reviewApplied = await replayIgnoringMessage(
        'POST',
        `/api/v1/admin/review-workspace/rollback/${ids.compensationRequest}/apply-rollback`,
        reviewApplyPayload,
        200,
        'admin review apply rollback',
    );
    assert.equal(reviewApplied.json().data.items[0].state, 'applied');
    const reviewEffects = await pool.query(
        `select
          (select status from meal.compensation_requests where id=$1) request_status,
          (select status from meal.compensation_items where id=$2) item_status,
          (select status from meal.content_releases where id=$3) release_status,
          (select count(*)::int from meal.audit_events where target_id=$2 and action='admin.rollback.content-release') audits`,
        [ids.compensationRequest, ids.compensationItem, ids.reviewRelease],
    );
    assert.deepEqual(reviewEffects.rows[0], {
        request_status: 'completed',
        item_status: 'applied',
        release_status: 'draft',
        audits: 1,
    });

    const supportCreatePayload = {
        idempotencyKey: randomUUID(),
        requesterId: ids.targetUser,
        subject: 'Acceptance admin support ticket',
        body: 'Acceptance admin-created support request.',
    };
    const supportCreated = await replay(
        'POST',
        '/api/v1/admin/support/create',
        supportCreatePayload,
        200,
        'admin support create',
    );
    const ticketId = supportCreated.json().data.ticketId;
    const supportWorkspace = expectStatus(
        await request('GET', `/api/v1/admin/support/${ticketId}/workspace`),
        200,
        'admin support workspace',
    );
    assert.equal(supportWorkspace.json().data.messages.length, 1);
    const supportManagePayload = {
        version: '1',
        idempotencyKey: randomUUID(),
        action: 'note',
        targetId: null,
        text: 'Acceptance private note',
        attachments: [],
    };
    const supportManaged = await replay(
        'POST',
        `/api/v1/admin/support/${ticketId}/manage`,
        supportManagePayload,
        200,
        'admin support manage',
    );
    assert.equal(supportManaged.json().data.version, '2');
    await expectError(
        request('POST', `/api/v1/admin/support/${ticketId}/manage`, {
            ...supportManagePayload,
            text: 'Changed replay',
        }),
        409,
        'admin support changed replay',
    );
    const supportEffects = await pool.query(
        `select t.version::int,
          (select count(*)::int from meal.support_messages where ticket_id=t.id) messages,
          (select count(*)::int from meal.support_events where ticket_id=t.id) events,
          (select count(*)::int from meal.audit_events where target_id=t.id and action like 'admin.support.%') audits
         from meal.support_tickets t where t.id=$1`,
        [ticketId],
    );
    assert.deepEqual(supportEffects.rows[0], { version: 2, messages: 2, events: 2, audits: 2 });

    const operationIds = [
        'AdminAllergensController_list',
        'AdminAllergensController_subjects',
        'AdminAllergensController_detail',
        'AdminAllergensController_mapping',
        'AdminAllergensController_icon',
        'AdminContentController_load',
        'AdminContentController_moderate',
        'AdminContentController_compare',
        'AdminContentController_merge',
        'AdminContentController_notDuplicate',
        'ContentReleasesController_list',
        'ContentReleasesController_create',
        'ContentReleasesController_history',
        'ContentReleasesController_sources',
        'ContentReleasesController_detail',
        'ContentReleasesController_save',
        'ContentReleasesController_validate',
        'ContentReleasesController_publish',
        'ContentReleasesController_rollback',
        'ContentReleasesController_edit',
        'AdminGovernanceController_view',
        'AdminGovernanceController_command',
        'AdminNewsController_list',
        'AdminNewsController_save',
        'AdminNewsController_preview',
        'AdminNewsController_launch',
        'AdminNewsController_cancel',
        'AdminNewsController_test',
        'NotificationCenterController_read',
        'NotificationCenterController_settings',
        'NotificationCenterController_markRead',
        'AdminReviewController_load',
        'AdminReviewController_preview',
        'AdminReviewController_applyRollback',
        'AdminSupportController_workspace',
        'AdminSupportController_manage',
        'AdminSupportController_create',
    ];
    assert.equal(operationIds.length, 37);
    console.log(
        `ADMIN_EXACT_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'admin-domain-live-v1',
            operationIds,
            assertions: {
                responseContracts: true,
                databaseEffects: true,
                auditEffects: true,
                idempotentReplay: true,
                changedReplayRollback: true,
                staleVersionRollback: true,
                criticalGate: true,
                roleGate: true,
                providerBoundariesExcluded: true,
            },
        })}`,
    );
}
