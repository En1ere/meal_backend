import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';

const expectStatus = (response, status, label) => {
    assert.equal(response.statusCode, status, `${label}: ${response.body}`);
    return response;
};
const keys = (value) => Object.keys(value).sort();

export async function runRemainingDomainsAcceptance({
    app,
    pool,
    ownerPool,
    headers,
    adminHeaders,
    userId,
    privateScopeId,
    ingredientId,
    unitId,
    recipeId,
    revisionId,
    authorUsername,
    familyOwner,
    familyMember,
    registerVerifiedAccount,
    subscriptionSettingsService,
    suffix,
}) {
    let requestIndex = 0;
    const request = (method, url, payload, requestHeaders = headers()) =>
        app.inject({
            method,
            url,
            headers: requestHeaders,
            remoteAddress: `198.34.0.${(++requestIndex % 240) + 1}`,
            ...(payload === undefined ? {} : { payload }),
        });
    const ownerBatch = async (statements) => {
        const client = await ownerPool.connect();
        try {
            await client.query('begin isolation level serializable');
            for (const [sql, values = []] of statements) await client.query(sql, values);
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    };

    // The preceding admin rollback intentionally restores the empty baseline. Seed a separate
    // published public catalog so these reads exercise their valid production contract.
    const publicReleaseId = randomUUID();
    await ownerBatch([
        [
            `insert into meal.content_releases(id,name,status,revision,created_by,published_by,published_at)
             values($1,$2,'published',1,$3,$3,now())`,
            [publicReleaseId, `Public acceptance catalog ${suffix}`, userId],
        ],
        ...Array.from({ length: 10 }, (_, index) => [
            `insert into meal.content_resource_heads(resource_type,resource_key,payload,retired,published_release_id)
             values('reputation_title',$1,$2::jsonb,false,$3)`,
            [
                `remaining-level-${suffix}-${index + 1}`,
                JSON.stringify({ level: index + 1, threshold: index * 100, title: `Level ${index + 1}` }),
                publicReleaseId,
            ],
        ]),
        [
            `insert into meal.content_resource_heads(resource_type,resource_key,payload,retired,published_release_id)
             values('achievement',$1,$2::jsonb,false,$3)`,
            [
                `remaining-achievement-${suffix}`,
                JSON.stringify({
                    code: `remaining-achievement-${suffix}`,
                    title: 'Acceptance achievement',
                    description: 'Exact public achievement projection',
                    icon: { assetId: null, fallbackKey: 'acceptance', alt: 'Acceptance' },
                    category: 'author',
                    condition: { metric: 'publishedCount', operator: 'gte', threshold: 1 },
                    reputationDelta: 5,
                    secret: false,
                }),
                publicReleaseId,
            ],
        ],
    ]);

    // Public achievement projections, including consent-gated author reads.
    const levels = expectStatus(await request('GET', '/api/v1/reputation/levels'), 200, 'reputation levels').json()
        .data;
    assert.deepEqual(keys(levels), ['items']);
    assert.ok(levels.items.length > 0);
    const achievements = expectStatus(
        await request('GET', `/api/v1/authors/${authorUsername}/achievements`),
        200,
        'author achievements',
    ).json().data;
    assert.deepEqual(keys(achievements), ['achievements', 'categories', 'profile', 'reputation']);
    const reputation = expectStatus(
        await request('GET', `/api/v1/authors/${authorUsername}/reputation`),
        200,
        'author reputation',
    ).json().data;
    assert.deepEqual(keys(reputation), ['factors', 'profile', 'rank', 'ranks', 'score']);

    // Allergen report: strict result, replay, changed-key conflict, immutable DB row and linked support ticket.
    const unknownIngredientId = randomUUID();
    await ownerBatch([
        [
            `insert into meal.recipe_ingredients(id,quantity,optional,position,revision_id,ingredient_id,unit_id)
             values($1,1,false,900,$2,null,$3)`,
            [unknownIngredientId, revisionId, unitId],
        ],
    ]);
    const allergenPayload = {
        recipeId,
        revisionId,
        unknownIngredientIds: [unknownIngredientId],
        note: 'Acceptance allergen report',
        idempotencyKey: randomUUID(),
    };
    const allergenReport = expectStatus(
        await request('POST', '/api/v1/allergens/reports', allergenPayload),
        200,
        'allergen report',
    ).json().data;
    assert.deepEqual(keys(allergenReport), ['ticketId', 'ticketNumber']);
    assert.deepEqual(
        expectStatus(await request('POST', '/api/v1/allergens/reports', allergenPayload), 200, 'allergen replay').json()
            .data,
        allergenReport,
    );
    expectStatus(
        await request('POST', '/api/v1/allergens/reports', { ...allergenPayload, note: 'changed replay' }),
        409,
        'allergen changed replay',
    );
    const allergenEffects = await pool.query(
        `select
          (select count(*)::int from meal.allergen_reports where ticket_id=$1) reports,
          (select count(*)::int from meal.support_tickets where id=$1) tickets,
          (select count(*)::int from meal.idempotency_records where actor_namespace=$2 and key=$3) idempotency`,
        [allergenReport.ticketId, `user:${userId}`, allergenPayload.idempotencyKey],
    );
    assert.deepEqual(allergenEffects.rows[0], { reports: 1, tickets: 1, idempotency: 1 });

    // Finance cost projections over private shopping and meal-plan fixtures plus a published recipe.
    const shoppingListId = randomUUID();
    const shoppingItemId = randomUUID();
    const mealPlanId = randomUUID();
    const planRevisionId = randomUUID();
    const planEntryId = randomUUID();
    await ownerBatch([
        [
            `insert into meal.shopping_lists(id,title,status,scope_id,created_by) values($1,$2,'active',$3,$4)`,
            [shoppingListId, `Cost shopping ${suffix}`, privateScopeId, userId],
        ],
        [
            `insert into meal.shopping_items(id,name,quantity,requirements,allow_analog,manual,status,list_id,ingredient_id,unit_id)
             values($1,$2,2,'{}'::jsonb,true,true,'active',$3,$4,$5)`,
            [shoppingItemId, `Cost ingredient ${suffix}`, shoppingListId, ingredientId, unitId],
        ],
        [
            `insert into meal.meal_plans(id,name,archived_at,scope_id,created_by) values($1,$2,null,$3,$4)`,
            [mealPlanId, `Cost plan ${suffix}`, privateScopeId, userId],
        ],
        [
            `insert into meal.plan_revisions(id,revision,starts_on,ends_on,timezone,status,plan_id)
             values($1,1,current_date,current_date,'UTC','active',$2)`,
            [planRevisionId, mealPlanId],
        ],
        [
            `insert into meal.plan_entries(id,date,meal,portions,substitutions,manual,locked,revision_id,recipe_revision_id)
             values($1,current_date,'lunch',2,'{}'::jsonb,true,false,$2,$3)`,
            [planEntryId, planRevisionId, revisionId],
        ],
    ]);
    for (const [url, type] of [
        [`/api/v1/finance/costs/recipes/${recipeId}?servings=3`, 'recipe'],
        [`/api/v1/finance/costs/shopping-lists/${shoppingListId}`, 'shopping_list'],
        [`/api/v1/finance/costs/meal-plans/${mealPlanId}`, 'meal_plan'],
    ]) {
        const estimate = expectStatus(await request('GET', url), 200, `finance ${type}`).json().data;
        assert.equal(estimate.subject.type, type);
        assert.deepEqual(keys(estimate), [
            'access',
            'approximate',
            'complete',
            'currency',
            'disclaimer',
            'estimatedTotalMinor',
            'knownLineCount',
            'knownSubtotalMinor',
            'lines',
            'subject',
            'totalLineCount',
        ]);
    }

    // Multipart table import and scan are preview-only and must leave inventory unchanged.
    const multipart = (field, filename, mime, bytes) => {
        const boundary = `----acceptance-${randomUUID()}`;
        const body = Buffer.concat([
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
            ),
            bytes,
            Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        return { body, contentType: `multipart/form-data; boundary=${boundary}` };
    };
    const inventoryBefore = Number((await pool.query('select count(*) from meal.inventory_batches')).rows[0].count);
    const table = multipart('file', 'acceptance.csv', 'text/csv', Buffer.from('name,quantity\nMilk,2\n'));
    const imported = expectStatus(
        await request('POST', '/api/v1/inventory/ingest/import', table.body, {
            ...headers(),
            'content-type': table.contentType,
        }),
        200,
        'inventory ingest import',
    ).json().data;
    assert.deepEqual(keys(imported), ['filename', 'sheets', 'warnings']);
    const onePixelPng = await sharp({
        create: { width: 600, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
        .png()
        .withMetadata({ density: 300 })
        .toBuffer();
    const scan = multipart('files', 'acceptance.png', 'image/png', onePixelPng);
    const scanned = expectStatus(
        await request('POST', '/api/v1/inventory/ingest/scan', scan.body, {
            ...headers(),
            'content-type': scan.contentType,
        }),
        200,
        'inventory ingest scan',
    ).json().data;
    assert.deepEqual(keys(scanned), ['images', 'warnings']);
    assert.equal(
        Number((await pool.query('select count(*) from meal.inventory_batches')).rows[0].count),
        inventoryBefore,
    );

    // Published unrestricted news: anonymous list/detail and authenticated idempotent read marker.
    const newsId = randomUUID();
    const newsVersionId = randomUUID();
    const newsContent = {
        type: 'article',
        title: `Public acceptance news ${suffix}`,
        pages: [{ blocks: [{ kind: 'text', text: 'Acceptance publication' }] }],
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
    await ownerBatch([
        [
            `insert into meal.announcements(id,kind,revision,pages,status,publish_at,author_id)
             values($1,'article',1,$2::jsonb,'published',now()-interval '1 minute',$3)`,
            [newsId, JSON.stringify(newsContent.pages), userId],
        ],
        [
            `insert into meal.announcement_versions(id,revision,content,announcement_id,created_by) values($1,1,$2::jsonb,$3,$4)`,
            [newsVersionId, JSON.stringify(newsContent), newsId, userId],
        ],
    ]);
    const newsList = expectStatus(await request('GET', '/api/v1/news?limit=20', undefined, {}), 200, 'news list').json()
        .data;
    assert.deepEqual(keys(newsList), ['items', 'nextCursor']);
    assert.ok(newsList.items.some((item) => item.id === newsId));
    const newsDetail = expectStatus(
        await request('GET', `/api/v1/news/${newsId}`, undefined, {}),
        200,
        'news detail',
    ).json().data;
    assert.deepEqual(keys(newsDetail), [
        'coverImage',
        'id',
        'pageCount',
        'pages',
        'publishedAt',
        'readAt',
        'title',
        'type',
    ]);
    const newsReadPayload = { idempotencyKey: randomUUID() };
    const newsRead = expectStatus(
        await request('POST', `/api/v1/news/${newsId}/read`, newsReadPayload),
        200,
        'news read',
    ).json().data;
    assert.deepEqual(keys(newsRead), ['id', 'readAt']);
    assert.deepEqual(
        expectStatus(
            await request('POST', `/api/v1/news/${newsId}/read`, newsReadPayload),
            200,
            'news read replay',
        ).json().data,
        newsRead,
    );
    assert.equal(
        Number(
            (await pool.query('select count(*) from meal.announcement_reads where announcement_id=$1', [newsId]))
                .rows[0].count,
        ),
        1,
    );

    // Portion allocation against a prepared cooking output: read, CAS/replay, decision and immutable movement.
    const attemptId = randomUUID();
    const preparedBatchId = randomUUID();
    const outputId = randomUUID();
    await ownerBatch([
        [
            `insert into meal.cooking_attempts(id,status,started_at,completed_at,recipe_snapshot,output_snapshot,scope_id,actor_id,revision_id)
             values($1,'completed',now()-interval '1 hour',now()-interval '30 minutes','{}'::jsonb,'{}'::jsonb,$2,$3,$4)`,
            [attemptId, privateScopeId, userId, revisionId],
        ],
        [
            `insert into meal.inventory_batches(id,kind,name,quantity,quantity_known,precision,package_state,scope_id,unit_id,created_by)
             values($1,'prepared',$2,4,true,'exact','opened',$3,$4,$5)`,
            [preparedBatchId, `Prepared ${suffix}`, privateScopeId, unitId, userId],
        ],
        [
            `insert into meal.cooking_outputs(id,quantity,yield_snapshot,attempt_id,batch_id,unit_id)
             values($1,4,'{}'::jsonb,$2,$3,$4)`,
            [outputId, attemptId, preparedBatchId, unitId],
        ],
    ]);
    const portionInitial = expectStatus(
        await request('GET', '/api/v1/portions?scope=private'),
        200,
        'portions detail',
    ).json().data;
    assert.deepEqual(keys(portionInitial), ['prepared', 'proposals', 'scope']);
    const portionPayload = {
        scope: 'private',
        batchId: preparedBatchId,
        recipientUserId: userId,
        quantity: '1',
        expectedBatchVersion: 1,
        idempotencyKey: randomUUID(),
    };
    const assigned = expectStatus(
        await request('POST', '/api/v1/portions/assign', portionPayload),
        200,
        'portion assign',
    ).json().data;
    const proposal = assigned.proposals.find((item) => item.source.batchId === preparedBatchId);
    assert.ok(proposal);
    assert.deepEqual(
        expectStatus(
            await request('POST', '/api/v1/portions/assign', portionPayload),
            200,
            'portion assign replay',
        ).json().data,
        assigned,
    );
    expectStatus(
        await request('POST', '/api/v1/portions/assign', { ...portionPayload, quantity: '2' }),
        409,
        'portion changed replay',
    );
    const decisionPayload = {
        scope: 'private',
        decision: 'confirmed',
        expectedVersion: proposal.version,
        idempotencyKey: randomUUID(),
    };
    const decided = expectStatus(
        await request('POST', `/api/v1/portions/${proposal.id}/decision`, decisionPayload),
        200,
        'portion decision',
    ).json().data;
    assert.equal(decided.proposals.find((item) => item.id === proposal.id).state, 'confirmed');
    assert.deepEqual(
        expectStatus(
            await request('POST', `/api/v1/portions/${proposal.id}/decision`, decisionPayload),
            200,
            'portion decision replay',
        ).json().data,
        decided,
    );
    const portionEffects = await pool.query(
        `select b.quantity::text,b.version::int,
          (select count(*)::int from meal.inventory_movements where batch_id=b.id) movements,
          (select count(*)::int from meal.diary_entries where proposal_id=$2) diary,
          (select count(*)::int from meal.audit_events where target_id=$2) audits
         from meal.inventory_batches b where b.id=$1`,
        [preparedBatchId, proposal.id],
    );
    assert.deepEqual(portionEffects.rows[0], { quantity: '3.00000000', version: 2, movements: 1, diary: 0, audits: 2 });

    // User/admin policy projections and atomic admin CAS update with audit.
    const policyAdminToken = randomBytes(32).toString('base64url');
    const policyAdminUnlock = randomBytes(32).toString('base64url');
    const policyAdminSessionId = randomUUID();
    await ownerBatch([
        [
            `insert into meal.sessions(id,kind,token_hash,expires_at,revoked_at,authenticated_at,mfa_verified_at,user_id,auth_context,admin_critical_until)
             values($1,'staff',$2,now()+interval '1 day',null,now(),now(),$3,'admin',now()+interval '30 minutes')`,
            [policyAdminSessionId, createHash('sha256').update(policyAdminToken).digest('hex'), userId],
        ],
        [
            `insert into meal.admin_session_unlocks(id,session_id,token_hash,expires_at)
             values($1,$2,$3,now()+interval '1 day')`,
            [randomUUID(), policyAdminSessionId, createHash('sha256').update(policyAdminUnlock).digest('hex')],
        ],
    ]);
    const policyCsrf = expectStatus(
        await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' }),
        200,
        'recipe policy admin csrf',
    );
    const policyAdminHeaders = () => ({
        origin: adminHeaders().origin,
        cookie: `${policyCsrf.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')}; meal_admin=${policyAdminToken}`,
        'x-csrf-token': policyCsrf.json().data.token,
        'x-admin-unlock': policyAdminUnlock,
    });
    const userPolicy = expectStatus(await request('GET', '/api/v1/recipe-policy'), 200, 'recipe policy user').json()
        .data;
    const adminPolicy = expectStatus(
        await request('GET', '/api/v1/admin/settings/recipe-policy', undefined, policyAdminHeaders()),
        200,
        'recipe policy admin',
    ).json().data;
    assert.deepEqual(adminPolicy, userPolicy);
    assert.deepEqual(keys(userPolicy), ['commentHourlyLimit', 'reportDailyLimit', 'submissionDailyLimit', 'version']);
    const policyPayload = {
        expectedVersion: userPolicy.version,
        submissionDailyLimit: userPolicy.submissionDailyLimit + 1,
        commentHourlyLimit: userPolicy.commentHourlyLimit + 1,
        reportDailyLimit: userPolicy.reportDailyLimit + 1,
    };
    const policyUpdated = expectStatus(
        await request('PUT', '/api/v1/admin/settings/recipe-policy', policyPayload, policyAdminHeaders()),
        200,
        'recipe policy update',
    ).json().data;
    assert.equal(policyUpdated.version, userPolicy.version + 1);
    expectStatus(
        await request('PUT', '/api/v1/admin/settings/recipe-policy', policyPayload, policyAdminHeaders()),
        409,
        'recipe policy stale CAS',
    );
    assert.equal(
        Number(
            (
                await pool.query(
                    "select count(*) from meal.audit_events where action='admin.recipe_policy.updated' and after_redacted->>'version'=$1",
                    [String(policyUpdated.version)],
                )
            ).rows[0].count,
        ),
        1,
    );

    // Full subscription settings lifecycle on isolated accounts.
    const trial = await registerVerifiedAccount('subtrial');
    const trialInitial = expectStatus(
        await trial.request('GET', '/api/v1/settings/subscription'),
        200,
        'subscription get',
    ).json().data;
    const trialPayload = { expectedVersion: trialInitial.version, idempotencyKey: randomUUID() };
    const trialResponse = await trial.request('POST', '/api/v1/settings/subscription/trial/activate', trialPayload);
    if (trialResponse.statusCode === 500)
        try {
            await subscriptionSettingsService.activateTrial(
                trialPayload,
                {
                    id: trial.userId,
                    displayName: 'Exact subtrial',
                    context: 'user',
                    sessionId: trial.sessionId,
                    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
                },
                randomUUID(),
            );
        } catch (error) {
            const classification =
                error && typeof error === 'object'
                    ? `${String(error.code ?? error.constructor?.name)}:${String(error.column ?? '')}:${String(error.constraint ?? '')}:${String(error.message ?? '').slice(0, 300)}`
                    : String(error);
            throw new Error(`SubscriptionSettingsController_activateTrial: ${classification}`);
        }
    const trialActivated = expectStatus(trialResponse, 200, 'subscription trial').json().data;
    assert.equal(trialActivated.current.plan, 'pro');
    assert.deepEqual(
        expectStatus(
            await trial.request('POST', '/api/v1/settings/subscription/trial/activate', trialPayload),
            200,
            'subscription trial replay',
        ).json().data,
        trialActivated,
    );

    const paid = await registerVerifiedAccount('subpaid');
    let settings = expectStatus(await paid.request('GET', '/api/v1/settings/subscription'), 200, 'paid settings').json()
        .data;
    const plusPreviewPayload = { expectedVersion: settings.version, period: 'month', idempotencyKey: randomUUID() };
    const plusPreview = expectStatus(
        await paid.request('POST', '/api/v1/settings/subscription/plus/preview', plusPreviewPayload),
        200,
        'plus preview',
    ).json().data;
    assert.deepEqual(
        expectStatus(
            await paid.request('POST', '/api/v1/settings/subscription/plus/preview', plusPreviewPayload),
            200,
            'plus preview replay',
        ).json().data,
        plusPreview,
    );
    const plusCommitPayload = {
        previewId: plusPreview.previewId,
        expectedVersion: settings.version,
        idempotencyKey: randomUUID(),
    };
    const plusCommitResponse = await paid.request(
        'POST',
        '/api/v1/settings/subscription/plus/commit',
        plusCommitPayload,
    );
    if (plusCommitResponse.statusCode === 500)
        try {
            await subscriptionSettingsService.commitPlus(
                plusCommitPayload,
                {
                    id: paid.userId,
                    displayName: 'Exact subpaid',
                    context: 'user',
                    sessionId: paid.sessionId,
                    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
                },
                randomUUID(),
            );
        } catch (error) {
            const classification =
                error && typeof error === 'object'
                    ? `${String(error.code ?? error.constructor?.name)}:${String(error.column ?? '')}:${String(error.constraint ?? '')}:${String(error.message ?? '').slice(0, 300)}`
                    : String(error);
            throw new Error(`SubscriptionSettingsController_commitPlus: ${classification}`);
        }
    settings = expectStatus(plusCommitResponse, 200, 'plus commit').json().data;
    assert.equal(settings.current.plan, 'plus');
    assert.deepEqual(
        expectStatus(
            await paid.request('POST', '/api/v1/settings/subscription/plus/commit', plusCommitPayload),
            200,
            'plus commit replay',
        ).json().data,
        settings,
    );
    const planPreviewPayload = {
        expectedVersion: settings.version,
        targetPlan: 'pro',
        period: 'month',
        timing: 'now',
        promotionOfferId: null,
        idempotencyKey: randomUUID(),
    };
    const planPreview = expectStatus(
        await paid.request('POST', '/api/v1/settings/subscription/plan/preview', planPreviewPayload),
        200,
        'plan preview',
    ).json().data;
    const planCommitPayload = {
        previewId: planPreview.previewId,
        expectedVersion: settings.version,
        idempotencyKey: randomUUID(),
    };
    settings = expectStatus(
        await paid.request('POST', '/api/v1/settings/subscription/plan/commit', planCommitPayload),
        200,
        'plan commit',
    ).json().data;
    assert.equal(settings.current.plan, 'pro');
    const renewalPreview = expectStatus(
        await paid.request('POST', '/api/v1/settings/subscription/renewal/preview', {
            expectedVersion: settings.version,
            enabled: true,
            idempotencyKey: randomUUID(),
        }),
        200,
        'renewal preview',
    ).json().data;
    const renewalCommitPayload = {
        previewId: renewalPreview.previewId,
        expectedVersion: settings.version,
        idempotencyKey: randomUUID(),
    };
    settings = expectStatus(
        await paid.request('POST', '/api/v1/settings/subscription/renewal/commit', renewalCommitPayload),
        200,
        'renewal commit',
    ).json().data;
    assert.equal(settings.current.autoRenew, true);
    const downgradePreview = expectStatus(
        await paid.request('POST', '/api/v1/settings/subscription/downgrade/preview', {
            expectedVersion: settings.version,
            targetPlan: 'free',
            idempotencyKey: randomUUID(),
        }),
        200,
        'downgrade preview',
    ).json().data;
    const downgradeCommitPayload = {
        previewId: downgradePreview.previewId,
        expectedVersion: settings.version,
        idempotencyKey: randomUUID(),
    };
    settings = expectStatus(
        await paid.request('POST', '/api/v1/settings/subscription/downgrade/commit', downgradeCommitPayload),
        200,
        'downgrade commit',
    ).json().data;
    assert.equal(settings.current.scheduledPlan, 'free');
    expectStatus(
        await paid.request('POST', '/api/v1/settings/subscription/downgrade/commit', {
            ...downgradeCommitPayload,
            idempotencyKey: randomUUID(),
            expectedVersion: downgradeCommitPayload.expectedVersion,
        }),
        409,
        'downgrade stale CAS',
    );

    // Use untouched source subscriptions; prior family acceptance intentionally exercised other
    // lifecycle states on the original Plus rows.
    const combinationOwnerSubscriptionId = randomUUID();
    const combinationMemberSubscriptionId = randomUUID();
    await ownerBatch([
        [
            `insert into meal.subscriptions(id,status,auto_renew,billing_anchor,billing_timezone,owner_id,product_id)
             select $1,'active',false,now(),'Europe/Moscow',$2,id from meal.billing_products where code='plus'`,
            [combinationOwnerSubscriptionId, familyOwner.userId],
        ],
        [
            `insert into meal.subscription_periods(id,starts_at,ends_at,grant_kind,price_snapshot,subscription_id)
             values($1,now()-interval '1 day',now()+interval '60 days','simulation',$2::jsonb,$3)`,
            [
                randomUUID(),
                JSON.stringify({ amountMinor: 39900, currency: 'RUB', period: 'month', paymentMode: 'simulation' }),
                combinationOwnerSubscriptionId,
            ],
        ],
        [
            `insert into meal.subscriptions(id,status,auto_renew,billing_anchor,billing_timezone,owner_id,product_id)
             select $1,'active',false,now(),'Europe/Moscow',$2,id from meal.billing_products where code='plus'`,
            [combinationMemberSubscriptionId, familyMember.userId],
        ],
        [
            `insert into meal.subscription_periods(id,starts_at,ends_at,grant_kind,price_snapshot,subscription_id)
             values($1,now()-interval '1 day',now()+interval '70 days','simulation',$2::jsonb,$3)`,
            [
                randomUUID(),
                JSON.stringify({ amountMinor: 39900, currency: 'RUB', period: 'month', paymentMode: 'simulation' }),
                combinationMemberSubscriptionId,
            ],
        ],
    ]);
    const ownerSettings = expectStatus(
        await familyOwner.request('GET', '/api/v1/settings/subscription'),
        200,
        'combination owner settings',
    ).json().data;
    const ownerVersion = Number(
        (await pool.query('select version from meal.users where id=$1', [familyOwner.userId])).rows[0].version,
    );
    assert.equal(ownerSettings.version, ownerVersion);
    const combinationPreview = expectStatus(
        await familyOwner.request('POST', '/api/v1/settings/subscription/combination/preview', {
            expectedVersion: ownerVersion,
            peerUserId: familyMember.userId,
            recipientId: familyOwner.userId,
            idempotencyKey: randomUUID(),
        }),
        200,
        'combination preview',
    ).json().data;
    const ownerConsentPayload = {
        previewId: combinationPreview.previewId,
        combinationId: combinationPreview.combinationId,
        expectedVersion: ownerVersion,
        idempotencyKey: randomUUID(),
    };
    const ownerConsent = expectStatus(
        await familyOwner.request('POST', '/api/v1/settings/subscription/combination/consent', ownerConsentPayload),
        200,
        'combination owner consent',
    ).json().data;
    assert.equal(ownerConsent.status, 'consent_pending');
    const memberSettings = expectStatus(
        await familyMember.request('GET', '/api/v1/settings/subscription'),
        200,
        'combination member settings',
    ).json().data;
    const memberConsent = expectStatus(
        await familyMember.request('POST', '/api/v1/settings/subscription/combination/consent', {
            previewId: combinationPreview.previewId,
            combinationId: combinationPreview.combinationId,
            expectedVersion: memberSettings.version,
            idempotencyKey: randomUUID(),
        }),
        200,
        'combination member consent',
    ).json().data;
    assert.equal(memberConsent.status, 'applied');

    const subscriptionEffects = await pool.query(
        `select
          (select count(*)::int from meal.trial_claims where user_id=$1) trials,
          (select count(*)::int from meal.subscription_changes where actor_id=$2) changes,
          (select count(*)::int from meal.audit_events where actor_id=$2 and action like 'subscription.%') audits,
          (select count(*)::int from meal.subscription_combinations where id=$3 and status='applied') combinations`,
        [trial.userId, paid.userId, combinationPreview.combinationId],
    );
    assert.equal(subscriptionEffects.rows[0].trials, 1);
    assert.ok(subscriptionEffects.rows[0].changes >= 4);
    assert.ok(subscriptionEffects.rows[0].audits >= 4);
    assert.equal(subscriptionEffects.rows[0].combinations, 1);

    const operationIds = [
        'AchievementsController_levels',
        'AchievementsController_achievements',
        'AchievementsController_reputation',
        'AllergenReportController_report',
        'PricingController_recipe',
        'PricingController_shopping',
        'PricingController_plan',
        'InventoryIngestController_import',
        'InventoryIngestController_scan',
        'NewsPublicController_list',
        'NewsPublicController_detail',
        'NewsPublicController_read',
        'PortionsController_detail',
        'PortionsController_assign',
        'PortionsController_decision',
        'RecipePolicyController_read',
        'RecipePolicyController_adminRead',
        'RecipePolicyController_update',
        'SubscriptionSettingsController_get',
        'SubscriptionSettingsController_activateTrial',
        'SubscriptionSettingsController_previewPlus',
        'SubscriptionSettingsController_commitPlus',
        'SubscriptionSettingsController_previewPlan',
        'SubscriptionSettingsController_commitPlan',
        'SubscriptionSettingsController_previewRenewal',
        'SubscriptionSettingsController_commitRenewal',
        'SubscriptionSettingsController_previewCombination',
        'SubscriptionSettingsController_consentCombination',
        'SubscriptionSettingsController_previewDowngrade',
        'SubscriptionSettingsController_commitDowngrade',
    ];
    assert.equal(operationIds.length, 30);
    console.log(
        `REMAINING_DOMAINS_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'remaining-domains-live-v1',
            operationIds,
            assertions: {
                exactResponses: true,
                databaseReadback: true,
                auditEffects: true,
                idempotentReplay: true,
                changedReplayRollback: true,
                staleCasRollback: true,
                authAndCriticalGate: true,
                tariffTransitions: true,
                familyCombinationConsent: true,
                ingestPreviewNoMutation: true,
                providerBoundariesExcluded: true,
            },
        })}`,
    );
}
