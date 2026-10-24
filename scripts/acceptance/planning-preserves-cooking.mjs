import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

const expectStatus = (response, status, label) => {
    assert.equal(response.statusCode, status, `${label}: ${response.body}`);
    return response;
};

const createAuthenticatedUser = async (app, frontendOrigin, label) => {
    let requestIndex = 0;
    const inject = (options) => app.inject({ ...options, remoteAddress: `198.31.0.${(++requestIndex % 240) + 1}` });
    const csrf = expectStatus(await inject({ method: 'GET', url: '/api/v1/auth/csrf' }), 200, `${label} csrf`);
    const cookies = new Map(csrf.cookies.map((cookie) => [cookie.name, cookie.value]));
    const suffix = randomBytes(6).toString('hex');
    const email = `${label}-${suffix}@example.test`;
    const headers = () => ({
        origin: frontendOrigin,
        cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        'x-csrf-token': csrf.json().data.token,
    });
    expectStatus(
        await inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            headers: headers(),
            payload: {
                username: `${label.replace(/[^a-z0-9_]/gi, '_')}_${suffix}`,
                displayName: `${label} acceptance`,
                email,
                password: 'AcceptancePassword1!',
                acceptTerms: true,
                acceptPrivacy: true,
            },
        }),
        200,
        `${label} register`,
    );
    const mailbox = expectStatus(
        await inject({ method: 'POST', url: '/api/v1/dev/mailbox', headers: headers(), payload: { email } }),
        200,
        `${label} mailbox`,
    );
    const token = mailbox.json().data.messages.find((message) => message.kind === 'verify')?.token;
    assert.ok(token, `${label}: verification token`);
    expectStatus(
        await inject({ method: 'POST', url: '/api/v1/auth/email/verify', headers: headers(), payload: { token } }),
        200,
        `${label} verify`,
    );
    const login = expectStatus(
        await inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            headers: headers(),
            payload: { email, password: 'AcceptancePassword1!' },
        }),
        200,
        `${label} login`,
    );
    for (const cookie of login.cookies) cookies.set(cookie.name, cookie.value);
    return { headers, userId: login.json().data.user.id };
};

export async function runPlanningPreservesCookingAcceptance({
    app,
    pool,
    ownerPool,
    frontendOrigin,
    headers,
    userId,
    suffix,
    ingredientId,
    locationId,
    recipeId,
    revisionId,
    plusSubscriptionId,
    proSubscriptionId,
}) {
    const ownerWrite = async (statement, values = []) => {
        const client = await ownerPool.connect();
        try {
            await client.query('begin isolation level serializable');
            const result = await client.query(statement, values);
            await client.query('commit');
            return result;
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    };
    let requestIndex = 0;
    const request = (method, url, payload, requestHeaders = headers()) =>
        app.inject({
            method,
            url,
            headers: requestHeaders,
            remoteAddress: `198.32.0.${(++requestIndex % 240) + 1}`,
            ...(payload === undefined ? {} : { payload }),
        });
    const expectError = async (promise, status, label) => {
        const response = await promise;
        expectStatus(response, status, label);
        assert.ok(response.json().error?.code, `${label}: error envelope`);
        return response;
    };
    const activate = async (subscriptionId) => {
        const periodId = randomUUID();
        await ownerWrite(
            `insert into meal.subscription_periods(id,starts_at,ends_at,grant_kind,price_snapshot,subscription_id)
             values($1,now()-interval '1 minute',now()+interval '2 days','paid',null,$2)`,
            [periodId, subscriptionId],
        );
        return periodId;
    };
    const expire = (periodId) =>
        ownerWrite(`update meal.subscription_periods set ends_at=now()-interval '1 minute' where id=$1`, [periodId]);

    await expectError(request('GET', '/api/v1/preserves?localDate=2026-10-14', undefined, {}), 401, 'preserves auth');
    await expectError(
        request('GET', '/api/v1/meal-plan?date=2026-10-14&timezone=UTC', undefined, {}),
        401,
        'plan auth',
    );
    await expectError(request('GET', '/api/v1/cooking-attempts', undefined, {}), 401, 'cooking auth');

    const scopeRow = await pool.query(`select id from meal.data_scopes where kind='private' and user_id=$1`, [userId]);
    const privateScopeId = scopeRow.rows[0].id;
    const familyRow = await pool.query(
        `select fm.family_id,ds.id scope_id from meal.family_memberships fm join meal.data_scopes ds on ds.family_id=fm.family_id
         where fm.user_id=$1 and fm.left_at is null and ds.kind='family'`,
        [userId],
    );
    assert.equal(familyRow.rows.length, 1, 'owner family fixture');
    const familyId = familyRow.rows[0].family_id;
    const familyScopeId = familyRow.rows[0].scope_id;

    const acceptanceIngredientId = randomUUID();
    const unitRow = await pool.query(`select id from meal.units where code='pcs'`);
    const unitId = unitRow.rows[0].id;
    const categoryRow = await pool.query(`select primary_category_id from meal.ingredients where id=$1`, [
        ingredientId,
    ]);
    await ownerWrite(
        `insert into meal.ingredients(id,name,aliases,status,default_storage_type,primary_category_id,default_unit_id)
         values($1,$2,'[]'::jsonb,'published','pantry',$3,$4)`,
        [acceptanceIngredientId, `Planning ingredient ${suffix}`, categoryRow.rows[0].primary_category_id, unitId],
    );
    await ownerWrite(
        `insert into meal.recipe_ingredients(id,position,quantity,optional,revision_id,ingredient_id,unit_id)
         values($1,1,4,false,$2,$3,$4)`,
        [randomUUID(), revisionId, acceptanceIngredientId, unitId],
    );
    await ownerWrite(
        `insert into meal.recipe_steps(id,position,text,duration_seconds,revision_id)
         values($1,1,'Acceptance cooking step',60,$2)`,
        [randomUUID(), revisionId],
    );

    const preserveFields = {
        name: `Acceptance preserve ${suffix}`,
        type: 'jam',
        createdOn: '2026-10-01',
        expiryOn: '2027-10-01',
        shelfLifeDays: 365,
        locationId,
        unit: 'pcs',
        volumePerUnit: '1',
        notes: 'Initial preserve note',
        tags: ['acceptance'],
        ingredients: [
            { name: `Planning ingredient ${suffix}`, ingredientId: acceptanceIngredientId, quantity: '2', unit: 'pcs' },
        ],
        imageUrl: null,
    };
    const preserveCreateKey = randomUUID();
    const preserveCreate = {
        ...preserveFields,
        scope: 'private',
        recipeRevisionId: null,
        containers: [
            { label: 'A', quantity: '5' },
            { label: 'B', quantity: null },
        ],
        idempotencyKey: preserveCreateKey,
    };
    const createdPreserve = expectStatus(
        await request('POST', '/api/v1/preserves', preserveCreate),
        200,
        'preserve create',
    ).json().data.preserve;
    assert.equal(createdPreserve.quantity, null);
    assert.equal(createdPreserve.capabilities.qr, false);
    assert.equal(
        expectStatus(await request('POST', '/api/v1/preserves', preserveCreate), 200, 'preserve create replay').json()
            .data.preserve.id,
        createdPreserve.id,
    );
    await expectError(
        request('POST', '/api/v1/preserves', { ...preserveCreate, name: `${preserveCreate.name} changed` }),
        409,
        'preserve changed replay',
    );
    const preserveId = createdPreserve.id;
    const firstContainer = createdPreserve.containers.find((container) => container.label === 'A');
    const unknownContainer = createdPreserve.containers.find((container) => container.label === 'B');
    assert.ok(firstContainer && unknownContainer, 'preserve containers projected by identity');
    expectStatus(
        await request(
            'GET',
            `/api/v1/preserves?q=${encodeURIComponent(preserveFields.name)}&localDate=2026-10-14&scope=private&limit=1`,
        ),
        200,
        'preserve list filters',
    );
    expectStatus(await request('GET', `/api/v1/preserves/${preserveId}?scope=private`), 200, 'preserve detail');
    const freeQr = expectStatus(
        await request('GET', `/api/v1/preserves/${preserveId}/qr-label?scope=private`),
        200,
        'free qr read',
    ).json().data;
    assert.equal(freeQr.capability.available, false);
    await expectError(
        request('POST', `/api/v1/preserves/${preserveId}/qr-label`, {
            preserveVersion: 1,
            scope: 'private',
            idempotencyKey: randomUUID(),
        }),
        403,
        'free qr issue gate',
    );
    const editKey = randomUUID();
    const edited = expectStatus(
        await request('POST', `/api/v1/preserves/${preserveId}/edit`, {
            version: 1,
            scope: 'private',
            idempotencyKey: editKey,
            fields: { ...preserveFields, notes: 'Edited preserve note' },
        }),
        200,
        'preserve edit',
    ).json().data.preserve;
    assert.equal(edited.version, 2);
    const stalePreserveKey = randomUUID();
    await expectError(
        request('POST', `/api/v1/preserves/${preserveId}/edit`, {
            version: 1,
            scope: 'private',
            idempotencyKey: stalePreserveKey,
            fields: preserveFields,
        }),
        412,
        'preserve stale edit rollback',
    );
    await expectError(
        request('POST', `/api/v1/preserves/${preserveId}/containers/${firstContainer.id}/open`, {
            version: 2,
            containerVersion: 1,
            openedAt: '2099-01-01T00:00:00.000Z',
            timezone: 'UTC',
            scope: 'private',
            idempotencyKey: randomUUID(),
        }),
        422,
        'preserve future opening rollback',
    );
    const opened = expectStatus(
        await request('POST', `/api/v1/preserves/${preserveId}/containers/${firstContainer.id}/open`, {
            version: 2,
            containerVersion: 1,
            openedAt: '2026-10-10T12:00:00.000Z',
            timezone: 'UTC',
            scope: 'private',
            idempotencyKey: randomUUID(),
        }),
        200,
        'preserve open',
    ).json().data.preserve;
    const resolved = expectStatus(
        await request('POST', `/api/v1/preserves/${preserveId}/containers/${unknownContainer.id}/quantity`, {
            version: opened.version,
            containerVersion: 1,
            quantity: '3',
            scope: 'private',
            idempotencyKey: randomUUID(),
        }),
        200,
        'preserve quantity resolution',
    ).json().data.preserve;
    assert.equal(Number(resolved.quantity), 8);
    const consumeInput = {
        version: resolved.version,
        containerId: firstContainer.id,
        containerVersion: 2,
        quantity: '2',
        scope: 'private',
    };
    const preview = expectStatus(
        await request('POST', `/api/v1/preserves/${preserveId}/consume-preview`, consumeInput),
        200,
        'preserve consume preview',
    ).json().data;
    assert.equal(Number(preview.before), 5);
    const beforePreview = await pool.query(
        `select remaining_quantity::text from meal.preserve_containers where id=$1`,
        [firstContainer.id],
    );
    assert.equal(Number(beforePreview.rows[0].remaining_quantity), 5);
    const consumeKey = randomUUID();
    const consumePayload = { ...consumeInput, previewToken: preview.previewToken, idempotencyKey: consumeKey };
    const consumed = expectStatus(
        await request('POST', `/api/v1/preserves/${preserveId}/consume`, consumePayload),
        200,
        'preserve consume',
    ).json().data.preserve;
    assert.equal(Number(consumed.quantity), 6);
    expectStatus(
        await request('POST', `/api/v1/preserves/${preserveId}/consume`, consumePayload),
        200,
        'preserve consume replay',
    );
    await expectError(
        request('POST', `/api/v1/preserves/${preserveId}/consume`, { ...consumePayload, quantity: '1' }),
        409,
        'preserve consume altered replay',
    );
    const recipeBaseKey = randomUUID();
    const recipeBasePayload = { version: consumed.version, scope: 'private', idempotencyKey: recipeBaseKey };
    const recipeBase = expectStatus(
        await request('POST', `/api/v1/preserves/${preserveId}/recipe-base`, recipeBasePayload),
        200,
        'preserve recipe base',
    ).json().data;
    assert.ok(recipeBase.recipeId);
    assert.deepEqual(
        expectStatus(
            await request('POST', `/api/v1/preserves/${preserveId}/recipe-base`, recipeBasePayload),
            200,
            'preserve recipe replay',
        ).json().data,
        recipeBase,
    );

    const plusPeriod = await activate(plusSubscriptionId);
    const qrKey = randomUUID();
    const qrPayload = { preserveVersion: consumed.version + 1, scope: 'private', idempotencyKey: qrKey };
    const qrIssued = expectStatus(
        await request('POST', `/api/v1/preserves/${preserveId}/qr-label`, qrPayload),
        200,
        'plus qr issue',
    ).json().data;
    assert.equal(qrIssued.capability.available, true);
    assert.equal(qrIssued.label.revision, 1);
    assert.equal(
        expectStatus(
            await request('POST', `/api/v1/preserves/${preserveId}/qr-label`, qrPayload),
            200,
            'qr replay',
        ).json().data.label.id,
        qrIssued.label.id,
    );
    const qrRead = expectStatus(
        await request('GET', `/api/v1/preserves/${preserveId}/qr-label?scope=private`),
        200,
        'qr read',
    ).json().data;
    assert.equal(qrRead.label.id, qrIssued.label.id);
    const archiveKey = randomUUID();
    const archived = expectStatus(
        await request('POST', `/api/v1/preserves/${preserveId}/archive`, {
            version: consumed.version + 1,
            scope: 'private',
            idempotencyKey: archiveKey,
        }),
        200,
        'preserve archive',
    ).json().data.preserve;
    assert.ok(archived.archivedAt);
    const restored = expectStatus(
        await request('POST', `/api/v1/preserves/${preserveId}/restore`, {
            version: archived.version,
            scope: 'private',
            idempotencyKey: randomUUID(),
        }),
        200,
        'preserve restore',
    ).json().data.preserve;
    assert.equal(restored.archivedAt, null);
    const preserveHistory = expectStatus(
        await request('GET', `/api/v1/preserves/${preserveId}/history?scope=private&page=1&limit=100`),
        200,
        'preserve history',
    ).json().data;
    assert.ok(preserveHistory.total >= 8);

    const member = await createAuthenticatedUser(app, frontendOrigin, 'planning-member');
    const outsider = await createAuthenticatedUser(app, frontendOrigin, 'planning-outsider');
    const memberProfile = randomUUID();
    await ownerWrite(
        `insert into meal.family_profiles(id,name,family_id,linked_user_id) values($1,'Planning member',$2,$3)`,
        [memberProfile, familyId, member.userId],
    );
    await ownerWrite(
        `insert into meal.family_memberships(id,joined_at,left_at,stable_order,family_id,user_id,profile_id)
         values($1,now(),null,900,$2,$3,$4)`,
        [randomUUID(), familyId, member.userId, memberProfile],
    );
    const familyPreservePayload = {
        ...preserveCreate,
        name: `Family preserve ${suffix}`,
        locationId: null,
        scope: 'family',
        idempotencyKey: randomUUID(),
    };
    const familyPreserve = expectStatus(
        await request('POST', '/api/v1/preserves', familyPreservePayload),
        200,
        'family preserve create',
    ).json().data.preserve;
    const concurrentPreserveKeys = [randomUUID(), randomUUID()];
    const concurrentFamilyEdits = await Promise.all(
        concurrentPreserveKeys.map((idempotencyKey, index) =>
            request('POST', `/api/v1/preserves/${familyPreserve.id}/edit`, {
                version: 1,
                scope: 'family',
                idempotencyKey,
                fields: {
                    ...preserveFields,
                    name: familyPreservePayload.name,
                    locationId: null,
                    notes: `Concurrent family preserve ${index + 1}`,
                },
            }),
        ),
    );
    assert.deepEqual(
        concurrentFamilyEdits.map((response) => response.statusCode).sort((left, right) => left - right),
        [200, 412],
        'preserve optimistic concurrency has one winner',
    );
    const concurrentFailure = concurrentFamilyEdits.find((response) => response.statusCode === 412);
    assert.ok(concurrentFailure?.json().error?.code, 'preserve concurrent loser error envelope');
    expectStatus(
        await request('GET', `/api/v1/preserves/${familyPreserve.id}?scope=family`, undefined, member.headers()),
        200,
        'family member preserve read',
    );
    await expectError(
        request('GET', `/api/v1/preserves/${familyPreserve.id}?scope=family`, undefined, outsider.headers()),
        404,
        'family outsider isolation',
    );
    await expire(plusPeriod);

    const preferenceKey = randomUUID();
    expectStatus(await request('GET', '/api/v1/cooking-attempts/reminder-preferences'), 200, 'cooking preferences');
    const preferencePayload = { enabled: true, timezone: 'Asia/Yekaterinburg', idempotencyKey: preferenceKey };
    expectStatus(
        await request('POST', '/api/v1/cooking-attempts/reminder-preferences', preferencePayload),
        200,
        'save cooking preferences',
    );
    expectStatus(
        await request('POST', '/api/v1/cooking-attempts/reminder-preferences', preferencePayload),
        200,
        'cooking preferences replay',
    );
    await expectError(
        request('POST', '/api/v1/cooking-attempts/reminder-preferences', { ...preferencePayload, enabled: false }),
        409,
        'cooking preferences altered replay',
    );
    const stock = expectStatus(
        await request('GET', '/api/v1/cooking-attempts/stock-options'),
        200,
        'cooking stock options',
    ).json().data.items;
    const sourceBatch = stock.find(
        (item) => item.ingredientId === ingredientId && item.quantity !== null && Number(item.quantity) > 0,
    );
    assert.ok(sourceBatch, 'cooking source batch');
    const startKey = randomUUID();
    const startPayload = { recipeId, revisionId, servings: 2, idempotencyKey: startKey };
    const attempt = expectStatus(
        await request('POST', '/api/v1/cooking-attempts', startPayload),
        200,
        'cooking start',
    ).json().data;
    assert.equal(attempt.steps.length, 1);
    assert.equal(
        expectStatus(
            await request('POST', '/api/v1/cooking-attempts', startPayload),
            200,
            'cooking start replay',
        ).json().data.id,
        attempt.id,
    );
    await expectError(
        request('POST', '/api/v1/cooking-attempts', { ...startPayload, servings: 3 }),
        409,
        'cooking altered start replay',
    );
    expectStatus(await request('GET', `/api/v1/cooking-attempts/${attempt.id}`), 200, 'cooking detail');
    expectStatus(await request('GET', '/api/v1/cooking-attempts'), 200, 'cooking list after start');
    await expectError(
        request('GET', `/api/v1/cooking-attempts/${attempt.id}`, undefined, outsider.headers()),
        404,
        'cooking object isolation',
    );
    await expectError(
        request('POST', `/api/v1/cooking-attempts/${attempt.id}/progress`, {
            version: 1,
            idempotencyKey: randomUUID(),
            occurredAt: '2099-01-01T00:00:00.000Z',
            status: 'active',
            steps: [{ position: attempt.steps[0].position, status: 'pending', privateNote: null }],
            timer: null,
        }),
        422,
        'cooking future occurrence rollback',
    );
    const progressPayload = {
        version: 1,
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        status: 'paused',
        steps: [{ position: attempt.steps[0].position, status: 'completed', privateNote: 'done' }],
        timer: null,
    };
    const progressed = expectStatus(
        await request('POST', `/api/v1/cooking-attempts/${attempt.id}/progress`, progressPayload),
        200,
        'cooking progress',
    ).json().data;
    assert.equal(progressed.version, 2);
    expectStatus(
        await request('POST', `/api/v1/cooking-attempts/${attempt.id}/progress`, progressPayload),
        200,
        'cooking progress replay',
    );
    expectStatus(await request('GET', '/api/v1/cooking-attempts?view=current'), 200, 'cooking list after progress');
    const finalizeKey = randomUUID();
    const finalizePayload = {
        version: 2,
        idempotencyKey: finalizeKey,
        outcome: 'completed',
        confirmedDuration: 120,
        privateNote: 'completed acceptance cooking',
        inputs: [{ batchId: sourceBatch.id, version: sourceBatch.version, quantity: '1' }],
        outputs: [
            {
                name: `Prepared acceptance ${suffix}`,
                quantity: '2',
                unit: 'pcs',
                locationId,
                expiryOn: '2026-10-20',
                precision: 'exact',
                portionQuantity: '1',
            },
        ],
    };
    await expectError(
        request('POST', `/api/v1/cooking-attempts/${attempt.id}/finalize`, {
            ...finalizePayload,
            version: 1,
            idempotencyKey: randomUUID(),
        }),
        412,
        'cooking stale finalize rollback',
    );
    const finalized = expectStatus(
        await request('POST', `/api/v1/cooking-attempts/${attempt.id}/finalize`, finalizePayload),
        200,
        'cooking finalize',
    ).json().data;
    assert.equal(finalized.status, 'completed');
    assert.equal(finalized.outputBatchIds.length, 1);
    assert.equal(
        expectStatus(
            await request('POST', `/api/v1/cooking-attempts/${attempt.id}/finalize`, finalizePayload),
            200,
            'cooking finalize replay',
        ).json().data.outputBatchIds[0],
        finalized.outputBatchIds[0],
    );
    expectStatus(await request('GET', '/api/v1/cooking-attempts?view=all'), 200, 'cooking list after finalize');

    const statisticsAttemptA = randomUUID();
    const statisticsAttemptB = randomUUID();
    await ownerWrite(
        `insert into meal.cooking_attempts(id,status,started_at,completed_at,recipe_snapshot,confirmed_duration,scope_id,actor_id,revision_id)
         values($1,'completed',now()-interval '3 hours',now()-interval '2 hours',$2::jsonb,180,$3,$4,$5),
               ($6,'completed',now()-interval '2 hours',now()-interval '1 hour',$2::jsonb,240,$3,$4,$5)`,
        [
            statisticsAttemptA,
            JSON.stringify({
                recipeId,
                revisionId,
                title: 'Statistics fixture',
                servings: 2,
                method: 'Приёмочный способ',
                steps: [{ position: 0, text: 'Acceptance cooking step', durationSeconds: 60 }],
            }),
            privateScopeId,
            userId,
            revisionId,
            statisticsAttemptB,
        ],
    );
    await ownerWrite(
        `insert into meal.cooking_steps(id,position,status,attempt_id) values($1,0,'completed',$2),($3,0,'completed',$4)`,
        [randomUUID(), statisticsAttemptA, randomUUID(), statisticsAttemptB],
    );
    const statistics = expectStatus(
        await request('GET', `/api/v1/recipes/${recipeId}/cooking-statistics?servings=2`),
        200,
        'cooking statistics',
    ).json().data;
    assert.equal(statistics.sampleSize, 4);
    assert.equal(statistics.medianSeconds, 150);

    const selection = { scope: 'private', view: 'week', date: '2026-10-14', timezone: 'Asia/Yekaterinburg' };
    const mutation = {
        action: 'upsert',
        entryId: null,
        date: '2026-10-14',
        meal: 'dinner',
        portions: 2,
        locked: false,
        slotState: 'recipe',
        recipeId,
        revisionId,
        note: 'Acceptance plan',
    };
    const emptyPlan = expectStatus(
        await request('GET', '/api/v1/meal-plan?scope=private&view=week&date=2026-10-14&timezone=Asia%2FYekaterinburg'),
        200,
        'free plan detail',
    ).json().data;
    assert.equal(emptyPlan.version, 0);
    const planPreview = expectStatus(
        await request('POST', '/api/v1/meal-plan/change-preview', { version: 0, selection, mutation }),
        200,
        'plan change preview',
    ).json().data;
    assert.equal(Number(planPreview.impact.items[0].missingQuantity), 4);
    const planKey = randomUUID();
    const planCommitPayload = {
        version: 0,
        selection,
        mutation,
        previewToken: planPreview.previewToken,
        idempotencyKey: planKey,
    };
    const plan = expectStatus(
        await request('POST', '/api/v1/meal-plan/change-commit', planCommitPayload),
        200,
        'plan commit',
    ).json().data;
    assert.equal(plan.version, 1);
    assert.equal(plan.entries.length, 1);
    assert.equal('key' in plan.entries[0], false);
    assert.deepEqual(Object.keys(plan.entries[0].recipe).sort(), ['id', 'revisionId', 'title']);
    assert.equal(
        expectStatus(
            await request('POST', '/api/v1/meal-plan/change-commit', planCommitPayload),
            200,
            'plan commit replay',
        ).json().data.id,
        plan.id,
    );
    await expectError(
        request('POST', '/api/v1/meal-plan/change-commit', {
            ...planCommitPayload,
            mutation: { ...mutation, note: 'changed' },
        }),
        409,
        'plan altered replay',
    );
    const stalePlanKey = randomUUID();
    await expectError(
        request('POST', '/api/v1/meal-plan/change-preview', {
            version: 0,
            selection,
            mutation: { ...mutation, entryId: plan.entries[0].id },
        }),
        412,
        'plan stale preview rollback',
    );
    const shoppingRequest = { version: 1, selection };
    await expectError(
        request('POST', '/api/v1/meal-plan/shopping-preview', shoppingRequest),
        403,
        'free smart shopping gate',
    );
    const planningPlusPeriod = await activate(plusSubscriptionId);
    const shoppingPreview = expectStatus(
        await request('POST', '/api/v1/meal-plan/shopping-preview', shoppingRequest),
        200,
        'plus shopping preview',
    ).json().data;
    assert.equal(shoppingPreview.items.length, 1);
    const shoppingKey = randomUUID();
    const shoppingCommitPayload = {
        ...shoppingRequest,
        previewToken: shoppingPreview.previewToken,
        title: `Plan shopping ${suffix}`,
        idempotencyKey: shoppingKey,
    };
    const shopping = expectStatus(
        await request('POST', '/api/v1/meal-plan/shopping-commit', shoppingCommitPayload),
        200,
        'plan shopping commit',
    ).json().data;
    assert.ok(shopping.listId);
    assert.equal(
        expectStatus(
            await request('POST', '/api/v1/meal-plan/shopping-commit', shoppingCommitPayload),
            200,
            'plan shopping replay',
        ).json().data.listId,
        shopping.listId,
    );

    const range = { scope: 'private', view: 'range', date: '2026-10-15', endDate: '2026-10-21', timezone: 'UTC' };
    const automationRule = {
        recipeId,
        revisionId,
        meal: 'lunch',
        weekdays: [4],
        portions: 1,
        conflictPolicy: 'skip-existing',
    };
    const automationInput = { version: 1, selection: range, rule: automationRule };
    const automationPreview = expectStatus(
        await request('POST', '/api/v1/meal-plan/automation-preview', automationInput),
        200,
        'plus automation preview',
    ).json().data;
    assert.ok(automationPreview.occurrences >= 1);
    assert.equal('key' in automationPreview.proposedEntries[0], false);
    assert.deepEqual(Object.keys(automationPreview.proposedEntries[0].recipe).sort(), ['id', 'revisionId', 'title']);
    const automationKey = randomUUID();
    const automationCommitPayload = {
        ...automationInput,
        previewToken: automationPreview.previewToken,
        idempotencyKey: automationKey,
    };
    const automated = expectStatus(
        await request('POST', '/api/v1/meal-plan/automation-commit', automationCommitPayload),
        200,
        'plus automation commit',
    ).json().data;
    assert.equal(automated.version, 2);
    assert.equal(
        automated.entries.some((entry) => 'key' in entry),
        false,
    );
    expectStatus(
        await request('POST', '/api/v1/meal-plan/automation-commit', automationCommitPayload),
        200,
        'automation replay',
    );

    const familySelection = { scope: 'family', view: 'week', date: '2026-10-14', timezone: 'UTC' };
    const familyMutation = {
        ...mutation,
        date: '2026-10-15',
        meal: 'breakfast',
        assignments: [
            { userId, portions: 1 },
            { userId: member.userId, portions: 1 },
        ],
    };
    const familyPreview = expectStatus(
        await request('POST', '/api/v1/meal-plan/change-preview', {
            version: 0,
            selection: familySelection,
            mutation: familyMutation,
        }),
        200,
        'family plan preview',
    ).json().data;
    const familyPlan = expectStatus(
        await request('POST', '/api/v1/meal-plan/change-commit', {
            version: 0,
            selection: familySelection,
            mutation: familyMutation,
            previewToken: familyPreview.previewToken,
            idempotencyKey: randomUUID(),
        }),
        200,
        'family plan commit',
    ).json().data;
    assert.equal(familyPlan.entries[0].assignments.length, 2);
    expectStatus(
        await request(
            'GET',
            '/api/v1/meal-plan?scope=family&view=week&date=2026-10-14&timezone=UTC',
            undefined,
            member.headers(),
        ),
        200,
        'family member plan read',
    );
    await expectError(
        request(
            'GET',
            '/api/v1/meal-plan?scope=family&view=week&date=2026-10-14&timezone=UTC',
            undefined,
            outsider.headers(),
        ),
        404,
        'family plan outsider isolation',
    );

    const proPeriod = await activate(proSubscriptionId);
    const optimizationAlternative = { recipeId: randomUUID(), revisionId: randomUUID() };
    await ownerWrite(
        `insert into meal.recipes(id,title,status,archived_at,author_id,scope_id)
         values($1,$2,'draft',null,$3,$4)`,
        [optimizationAlternative.recipeId, `Optimization alternative ${suffix}`, userId, privateScopeId],
    );
    await ownerWrite(
        `insert into meal.recipe_revisions(id,revision,title,portions,method,nutrition_snapshot,timing,change_kind,recipe_id,created_by)
         values($1,1,$2,2,'Optimization fixture method',null,null,'acceptance',$3,$4)`,
        [
            optimizationAlternative.revisionId,
            `Optimization alternative ${suffix}`,
            optimizationAlternative.recipeId,
            userId,
        ],
    );
    const optimizationPreview = expectStatus(
        await request('POST', '/api/v1/meal-plan/automation-preview', {
            version: 2,
            selection: {
                scope: 'private',
                view: 'range',
                date: '2026-12-01',
                endDate: '2026-12-07',
                timezone: 'UTC',
            },
            rule: {
                ...automationRule,
                alternatives: [optimizationAlternative],
                optimization: {
                    priorities: ['expiry', 'nutrition', 'budget'],
                    maxBudgetMinor: 10000,
                    targetMealSharePercent: 30,
                },
            },
        }),
        200,
        'pro deterministic optimization preview',
    ).json().data;
    assert.equal(optimizationPreview.optimization.mode, 'deterministic-v1');
    assert.equal(optimizationPreview.optimization.candidates.length, 2);
    assert.deepEqual(
        optimizationPreview.optimization.candidates.map((candidate) => candidate.rank),
        [1, 2],
    );
    assert.equal(
        optimizationPreview.proposedEntries.some((entry) => 'key' in entry),
        false,
    );
    assert.equal(
        optimizationPreview.proposedEntries.every(
            (entry) =>
                JSON.stringify(Object.keys(entry.recipe).sort()) === JSON.stringify(['id', 'revisionId', 'title']),
        ),
        true,
    );
    const proRange = { scope: 'private', view: 'calendar', date: '2026-11-01', timezone: 'UTC' };
    expectStatus(
        await request('GET', '/api/v1/meal-plan?scope=private&view=calendar&date=2026-11-01&timezone=UTC'),
        200,
        'pro calendar plan',
    );
    await expire(proPeriod);
    await expectError(
        request('GET', '/api/v1/meal-plan?scope=private&view=calendar&date=2026-11-01&timezone=UTC'),
        403,
        'former pro calendar gate',
    );
    await expire(planningPlusPeriod);
    await expectError(
        request('GET', '/api/v1/meal-plan?scope=family&view=week&date=2026-10-14&timezone=UTC'),
        403,
        'expired family plan gate',
    );
    await expectError(
        request('GET', `/api/v1/preserves/${familyPreserve.id}?scope=family`),
        403,
        'expired family preserve gate',
    );

    const effects = await pool.query(
        `select
           (select count(*)::int from meal.preserve_details where id=any($1::uuid[])) preserves,
           (select count(*)::int from meal.preserve_containers where preserve_id=$2) preserve_containers,
           (select count(*)::int from meal.qr_labels where preserve_id=$2) qr_labels,
           (select count(*)::int from meal.audit_events where actor_id=$3 and target_type='preserve') preserve_audits,
           (select count(*)::int from meal.cooking_attempts where actor_id=$3 and revision_id=$4) cooking_attempts,
           (select count(*)::int from meal.cooking_inputs where attempt_id=$5) cooking_inputs,
           (select count(*)::int from meal.cooking_outputs where attempt_id=$5) cooking_outputs,
           (select count(*)::int from meal.meal_plans where scope_id in($6,$7)) meal_plans,
           (select count(*)::int from meal.plan_revisions pr join meal.meal_plans mp on mp.id=pr.plan_id where mp.scope_id in($6,$7)) plan_revisions,
           (select count(*)::int from meal.plan_rules pr join meal.plan_revisions rev on rev.id=pr.revision_id join meal.meal_plans mp on mp.id=rev.plan_id where mp.scope_id=$6) plan_rules,
           (select count(*)::int from meal.shopping_lists where id=$8) shopping_lists,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$9 and operation in('preserve','preserve-qr','cooking','cooking-reminder-preferences','meal-plan')) idempotency,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$9 and key=$10) stale_idempotency,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$9 and key=any($11::text[])) concurrent_preserve_idempotency`,
        [
            [preserveId, familyPreserve.id],
            preserveId,
            userId,
            revisionId,
            attempt.id,
            privateScopeId,
            familyScopeId,
            shopping.listId,
            `user:${userId}`,
            stalePlanKey,
            concurrentPreserveKeys,
        ],
    );
    assert.equal(effects.rows[0].preserves, 2);
    assert.equal(effects.rows[0].preserve_containers, 2);
    assert.equal(effects.rows[0].qr_labels, 1);
    assert.ok(effects.rows[0].preserve_audits >= 8);
    assert.equal(effects.rows[0].cooking_inputs, 1);
    assert.equal(effects.rows[0].cooking_outputs, 1);
    assert.equal(effects.rows[0].meal_plans, 2);
    assert.ok(effects.rows[0].plan_revisions >= 3);
    assert.equal(effects.rows[0].plan_rules, 1);
    assert.equal(effects.rows[0].shopping_lists, 1);
    assert.equal(effects.rows[0].stale_idempotency, 0);
    assert.equal(effects.rows[0].concurrent_preserve_idempotency, 1);

    console.log(
        `PLANNING_PRESERVES_COOKING_EVIDENCE ${JSON.stringify({
            schema: 'planning-preserves-cooking-live-v1',
            operationIds: [
                'CookingController_list',
                'CookingController_start',
                'CookingController_preferences',
                'CookingController_savePreferences',
                'CookingController_stockOptions',
                'CookingController_detail',
                'CookingController_progress',
                'CookingController_finalize',
                'CookingStatisticsController_statistics',
                'MealPlanController_detail',
                'MealPlanController_preview',
                'MealPlanController_commit',
                'MealPlanController_shoppingPreview',
                'MealPlanController_shoppingCommit',
                'MealPlanController_automationPreview',
                'MealPlanController_automationCommit',
                'PreservesController_list',
                'PreservesController_create',
                'PreservesController_detail',
                'PreservesController_qrLabel',
                'PreservesController_issueQrLabel',
                'PreservesController_edit',
                'PreservesController_archive',
                'PreservesController_restore',
                'PreservesController_open',
                'PreservesController_quantity',
                'PreservesController_preview',
                'PreservesController_consume',
                'PreservesController_recipeBase',
                'PreservesController_history',
            ],
            effects: effects.rows[0],
            assertions: {
                exactResponses: true,
                unauthenticated: true,
                freePrivateSuccess: true,
                plusFamilyOwnerMemberSuccess: true,
                outsiderIsolation: true,
                plusQrAndPlanningSuccess: true,
                proCalendarSuccess: true,
                expiredEntitlementGates: true,
                previewNoMutation: true,
                optimisticConcurrency: true,
                idempotentReplay: true,
                alteredReplayConflict: true,
                failedCommandRollback: true,
                offlineOccurredAtBounds: true,
                inventoryMovementsAndOutputs: true,
                archiveRestoreAndHistory: true,
                deterministicAutomation: true,
                databaseAuditAndIdempotencyReadback: true,
            },
        })}`,
    );
}
