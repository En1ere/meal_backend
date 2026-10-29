import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const expectStatus = (response, status, label) => {
    assert.equal(response.statusCode, status, `${label}: ${response.body}`);
    return response;
};

const keys = (value) => Object.keys(value).sort();

export async function runAiProDomainAcceptance({
    app,
    pool,
    ownerPool,
    headers,
    userId,
    sessionId,
    suffix,
    privateScopeId,
    ingredientId,
    inventoryBatchId,
    recipeId,
    revisionId,
    authorUsername,
    familyId,
    familyRecipient,
    familyDonor,
    personalizationService,
}) {
    let requestIndex = 0;
    const request = (method, url, payload, extraHeaders = {}) =>
        app.inject({
            method,
            url,
            headers: { ...headers(), ...extraHeaders },
            remoteAddress: `198.33.0.${(++requestIndex % 240) + 1}`,
            ...(payload === undefined ? {} : { payload }),
        });
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
    const ownerBatch = async (statements) => {
        const client = await ownerPool.connect();
        try {
            await client.query('begin isolation level serializable');
            for (const [statement, values] of statements) await client.query(statement, values);
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    };

    // Dedicated active Pro fixture. Existing subscriptions in the aggregate runner have intentionally
    // crossed several active/former-Pro boundaries, so this package must not depend on their current clock state.
    const proSubscriptionId = randomUUID();
    const proPeriodId = randomUUID();
    await ownerBatch([
        [
            `insert into meal.subscriptions(id,status,auto_renew,billing_anchor,billing_timezone,owner_id,product_id)
             select $1,'active',false,now(),'Europe/Moscow',$2,id from meal.billing_products where code='pro'`,
            [proSubscriptionId, userId],
        ],
        [
            `insert into meal.subscription_periods(id,starts_at,ends_at,grant_kind,price_snapshot,subscription_id)
             values($1,now()-interval '1 day',now()+interval '30 days','paid',null,$2)`,
            [proPeriodId, proSubscriptionId],
        ],
    ]);

    const consentState = expectStatus(
        await request('GET', '/api/v1/settings/legal-consents'),
        200,
        'legal consent state',
    ).json().data;
    const special = consentState.consents.find((item) => item.kind === 'special_category');
    assert.ok(special, 'special-category consent state');
    if (!special.enabled) {
        const manifest = expectStatus(await request('GET', '/api/v1/legal/manifest'), 200, 'legal manifest').json()
            .data;
        const document = manifest.documents.find((item) => item.kind === 'special_category')?.document;
        assert.ok(document, 'special-category document');
        expectStatus(
            await request('POST', '/api/v1/settings/legal-consents/special_category/accept', {
                accepted: true,
                document,
                expectedRevision: special.revision,
                idempotencyKey: randomUUID(),
            }),
            200,
            'special-category consent accept',
        );
    }

    // Personalization: strict read projections, CAS rollback, idempotent replay and consent-protected allergens.
    const personalization = expectStatus(
        await request('GET', '/api/v1/personalization'),
        200,
        'personalization detail',
    ).json().data;
    assert.deepEqual(keys(personalization), ['catalog', 'onboarding', 'preferences']);
    const onboardingPayload = {
        flow: 'quick',
        status: 'in_progress',
        step: 1,
        expectedVersion: personalization.onboarding.version,
        idempotencyKey: randomUUID(),
    };
    const onboardingResponse = await request('PUT', '/api/v1/personalization/onboarding', onboardingPayload);
    if (onboardingResponse.statusCode === 500)
        try {
            await personalizationService.updateOnboarding(userId, onboardingPayload);
        } catch (error) {
            const classification =
                error && typeof error === 'object' && 'code' in error
                    ? `${String(error.code)}:${'column' in error ? String(error.column) : ''}:${'constraint' in error ? String(error.constraint) : ''}:${'message' in error ? String(error.message).slice(0, 240) : ''}`
                    : (error?.constructor?.name ?? 'UnknownError');
            throw new Error(`PersonalizationController_onboarding: ${classification}`);
        }
    const onboarding = expectStatus(onboardingResponse, 200, 'personalization onboarding').json().data;
    assert.deepEqual(keys(onboarding), ['flow', 'status', 'step', 'totalSteps', 'version']);
    assert.equal(onboarding.version, personalization.onboarding.version + 1);
    assert.deepEqual(
        expectStatus(
            await request('PUT', '/api/v1/personalization/onboarding', onboardingPayload),
            200,
            'personalization onboarding replay',
        ).json().data,
        onboarding,
    );
    const preferencesPayload = {
        diets: [],
        allergens: ['milk'],
        dislikes: ['celery'],
        allergenMode: 'warn',
        equipment: { oven: 'yes', grill: 'no' },
        goals: ['less_waste'],
        expectedVersion: onboarding.version,
        idempotencyKey: randomUUID(),
    };
    const preferences = expectStatus(
        await request('PUT', '/api/v1/personalization/preferences', preferencesPayload),
        200,
        'personalization preferences',
    ).json().data;
    assert.equal(preferences.version, onboarding.version + 1);
    assert.deepEqual(
        expectStatus(
            await request('PUT', '/api/v1/personalization/preferences', preferencesPayload),
            200,
            'personalization preferences replay',
        ).json().data,
        preferences,
    );
    expectStatus(
        await request('PUT', '/api/v1/personalization/preferences', {
            ...preferencesPayload,
            expectedVersion: onboarding.version,
            idempotencyKey: randomUUID(),
        }),
        412,
        'personalization stale CAS',
    );
    const home = expectStatus(await request('GET', '/api/v1/home'), 200, 'personalization home').json().data;
    assert.deepEqual(keys(home), [
        'activeShoppingLists',
        'expiring',
        'inventoryCount',
        'onboarding',
        'plan',
        'recommendations',
    ]);

    // Recommendations: issued recommendation binding, event replay/changed-replay rollback and follow lifecycle.
    const recommendations = expectStatus(
        await request('GET', '/api/v1/recommendations?type=recipe&scope=private&surface=recipes&limit=5'),
        200,
        'recommendations list',
    ).json().data;
    assert.equal(recommendations.algorithm, 'personalized-v1');
    assert.ok(recommendations.items.length > 0, 'at least one published recipe recommendation');
    const recommendation = recommendations.items[0];
    const recommendationEvent = {
        event: 'open',
        recommendationId: recommendation.recommendationId,
        entityType: 'recipe',
        entityId: recommendation.recipe.id,
        algorithm: recommendation.algorithmVersion,
        surface: 'recipes',
        position: 0,
        reasonCodes: recommendation.reasonCodes,
        idempotencyKey: randomUUID(),
    };
    expectStatus(
        await request('POST', '/api/v1/recommendations/events', recommendationEvent),
        202,
        'recommendation event',
    );
    expectStatus(
        await request('POST', '/api/v1/recommendations/events', recommendationEvent),
        202,
        'recommendation event replay',
    );
    expectStatus(
        await request('POST', '/api/v1/recommendations/events', {
            ...recommendationEvent,
            event: 'not_interested',
        }),
        409,
        'recommendation changed replay',
    );
    const followPayload = { following: true, idempotencyKey: randomUUID() };
    const followed = expectStatus(
        await request('PUT', `/api/v1/authors/${authorUsername}/follow`, followPayload),
        200,
        'author follow',
    ).json().data;
    assert.deepEqual(followed, { username: authorUsername, following: true });
    assert.deepEqual(
        expectStatus(
            await request('PUT', `/api/v1/authors/${authorUsername}/follow`, followPayload),
            200,
            'author follow replay',
        ).json().data,
        followed,
    );
    assert.equal(
        expectStatus(
            await request('GET', `/api/v1/authors/${authorUsername}/follow`),
            200,
            'author follow state',
        ).json().data.following,
        true,
    );
    const following = expectStatus(
        await request('GET', '/api/v1/profile/following?limit=1'),
        200,
        'following list',
    ).json().data;
    assert.equal(following.items[0].username, authorUsername);

    // Diary: sources, create/update/archive and a real portion-decision graph with exact DB readback.
    const ingredientSource = expectStatus(
        await request('GET', '/api/v1/diary/sources?type=ingredient&q=&limit=20'),
        200,
        'diary sources',
    )
        .json()
        .data.items.find((item) => item.id === ingredientId);
    assert.ok(ingredientSource, 'ingredient source is visible');
    const diaryCreatePayload = {
        eatenAt: '2026-10-14T08:30:00.000Z',
        meal: 'breakfast',
        note: 'Exact diary entry',
        components: [
            {
                id: randomUUID(),
                source: { type: 'manual', name: 'Exact oatmeal' },
                quantity: '150',
                unit: 'g',
            },
        ],
        idempotencyKey: randomUUID(),
    };
    const diaryCreated = expectStatus(
        await request('POST', '/api/v1/diary', diaryCreatePayload),
        200,
        'diary create',
    ).json().data.entry;
    assert.equal(diaryCreated.version, 1);
    assert.deepEqual(
        expectStatus(await request('POST', '/api/v1/diary', diaryCreatePayload), 200, 'diary create replay').json().data
            .entry,
        diaryCreated,
    );
    const diaryUpdatePayload = {
        eatenAt: '2026-10-14T09:00:00.000Z',
        meal: 'snack',
        note: 'Exact diary entry updated',
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
    };
    const diaryUpdated = expectStatus(
        await request('PUT', `/api/v1/diary/${diaryCreated.id}`, diaryUpdatePayload, { 'if-match': '"1"' }),
        200,
        'diary update',
    ).json().data.entry;
    assert.equal(diaryUpdated.version, 2);
    expectStatus(
        await request('POST', `/api/v1/diary/${diaryCreated.id}/media`, {
            fileName: 'acceptance.webp',
            mimeType: 'image/webp',
            sizeBytes: 1024,
            idempotencyKey: randomUUID(),
        }),
        503,
        'diary media provider fail closed',
    );
    expectStatus(
        await request(
            'PUT',
            `/api/v1/diary/${diaryCreated.id}`,
            { ...diaryUpdatePayload, idempotencyKey: randomUUID() },
            { 'if-match': '"1"' },
        ),
        412,
        'diary update stale CAS',
    );
    const proposalId = randomUUID();
    const attemptId = randomUUID();
    const movementFixture = await pool.query(
        `select movement.operation_id, movement.id movement_id, batch.unit_id
         from meal.inventory_movements movement join meal.inventory_batches batch on batch.id=movement.batch_id
         where movement.batch_id=$1 order by movement.created_at desc limit 1`,
        [inventoryBatchId],
    );
    assert.equal(movementFixture.rows.length, 1, 'portion allocation movement fixture');
    await ownerBatch([
        [
            `insert into meal.cooking_attempts(id,status,started_at,completed_at,recipe_snapshot,output_snapshot,confirmed_duration,private_note,scope_id,actor_id,revision_id)
             values($1,'completed',now()-interval '1 hour',now()-interval '30 minutes',$2::jsonb,'{}'::jsonb,1800,null,$3,$4,$5)`,
            [
                attemptId,
                JSON.stringify({ title: 'Exact portion fixture', servings: 1, steps: [] }),
                privateScopeId,
                userId,
                revisionId,
            ],
        ],
        [
            `insert into meal.portion_proposals(id,allocation_key,available_at,due_at,state,decision_at,confirmation_method,nutrition_snapshot,quantity_snapshot,recipient_id,attempt_id,output_id,profile_id,allocation_operation_id,issued_quantity,issued_unit_id)
             values($1,$2,now(),now()+interval '1 day','pending',null,null,$3::jsonb,$4::jsonb,$5,$6,null,null,$7,'1',$8)`,
            [
                proposalId,
                `exact:${proposalId}`,
                JSON.stringify({ name: 'Exact portion', energyKcal: '100' }),
                JSON.stringify({ quantity: '1', unit: 'g' }),
                userId,
                attemptId,
                movementFixture.rows[0].operation_id,
                movementFixture.rows[0].unit_id,
            ],
        ],
    ]);
    const portionPayload = { decision: 'confirmed', expectedVersion: 1, idempotencyKey: randomUUID() };
    const portion = expectStatus(
        await request('POST', `/api/v1/diary/portions/${proposalId}/decision`, portionPayload, {
            'if-match': '"1"',
        }),
        200,
        'diary portion decision',
    ).json().data.proposal;
    assert.equal(portion.state, 'confirmed');
    assert.deepEqual(
        expectStatus(
            await request('POST', `/api/v1/diary/portions/${proposalId}/decision`, portionPayload, {
                'if-match': '"1"',
            }),
            200,
            'diary portion decision replay',
        ).json().data.proposal,
        portion,
    );

    // Nutrition: consent + Pro gates, profile/target CAS and analytics over the diary data.
    const initialNutrition = expectStatus(
        await request('GET', '/api/v1/nutrition/settings'),
        200,
        'nutrition settings initial',
    ).json().data;
    assert.equal(initialNutrition.access.mode, 'active');
    const nutritionProfilePayload = {
        goal: 'maintain',
        expectedVersion: null,
        idempotencyKey: randomUUID(),
    };
    const nutritionProfile = expectStatus(
        await request('PUT', '/api/v1/nutrition/profile', nutritionProfilePayload),
        200,
        'nutrition profile',
    ).json().data;
    assert.equal(nutritionProfile.profile.version, 1);
    assert.deepEqual(
        expectStatus(
            await request('PUT', '/api/v1/nutrition/profile', nutritionProfilePayload),
            200,
            'nutrition profile replay',
        ).json().data,
        nutritionProfile,
    );
    const targetPayload = {
        effectiveFrom: '2026-10-01',
        energyKcal: '2100',
        proteinG: '100',
        fatG: '70',
        carbohydrateG: '250',
        fiberG: '30',
        expectedProfileVersion: 1,
        idempotencyKey: randomUUID(),
    };
    const nutritionTarget = expectStatus(
        await request('POST', '/api/v1/nutrition/targets', targetPayload, { 'if-match': '"1"' }),
        200,
        'nutrition target',
    ).json().data;
    assert.equal(nutritionTarget.profile.version, 2);
    assert.equal(nutritionTarget.currentTarget.effectiveFrom, '2026-10-01');
    expectStatus(
        await request(
            'POST',
            '/api/v1/nutrition/targets',
            { ...targetPayload, effectiveFrom: '2026-10-02', idempotencyKey: randomUUID() },
            { 'if-match': '"1"' },
        ),
        412,
        'nutrition target stale CAS',
    );
    const analytics = expectStatus(
        await request('GET', '/api/v1/nutrition/analytics?from=2026-10-01&to=2026-10-15'),
        200,
        'nutrition analytics',
    ).json().data;
    assert.equal(analytics.disclaimer, 'informational_not_medical');
    assert.ok(analytics.summary.entryCount >= 1);
    const diaryArchived = expectStatus(
        await request(
            'POST',
            `/api/v1/diary/${diaryCreated.id}/archive`,
            { archived: true, expectedVersion: 2, idempotencyKey: randomUUID() },
            { 'if-match': '"2"' },
        ),
        200,
        'diary archive',
    ).json().data.entry;
    assert.equal(diaryArchived.state, 'archived');

    // Export: preview, single-use critical grant, idempotent create and cursor-based list.
    const previewSelection = {
        scope: 'private',
        domain: 'nutrition',
        format: 'json',
        startsOn: '2026-10-01',
        endsOn: '2026-10-14',
    };
    const exportPreview = expectStatus(
        await request('POST', '/api/v1/exports/preview', previewSelection),
        200,
        'export preview',
    ).json().data;
    assert.equal(exportPreview.canCreate, true);
    assert.equal(exportPreview.manifest.schemaVersion, '2026-10-09');
    const reauthToken = randomBytes(32).toString('base64url');
    await ownerWrite(
        `insert into meal.user_critical_grants(id,user_id,session_id,token_hash,purpose,expires_at)
         values($1,$2,$3,$4,'export',now()+interval '10 minutes')`,
        [randomUUID(), userId, sessionId, createHash('sha256').update(reauthToken).digest('hex')],
    );
    const exportCreatePayload = {
        previewId: exportPreview.previewId,
        idempotencyKey: randomUUID(),
        reauthToken,
    };
    const exportCreated = expectStatus(
        await request('POST', '/api/v1/exports', exportCreatePayload),
        201,
        'export create',
    ).json().data.job;
    assert.equal(exportCreated.status, 'queued');
    assert.deepEqual(
        expectStatus(await request('POST', '/api/v1/exports', exportCreatePayload), 201, 'export create replay').json()
            .data.job,
        exportCreated,
    );
    const exportsList = expectStatus(await request('GET', '/api/v1/exports?limit=1'), 200, 'exports list').json().data;
    assert.equal(exportsList.items[0].id, exportCreated.id);
    await ownerWrite(
        `update meal.export_jobs set status='ready',expires_at=now()+interval '10 minutes',version=version+1 where id=$1`,
        [exportCreated.id],
    );
    expectStatus(
        await request('GET', `/api/v1/exports/${exportCreated.id}/download-content`),
        503,
        'export storage provider fail closed',
    );

    // Local AI reads and history are executable without a provider. Seed one completed conversation to
    // exercise the exact projections while provider-backed preview/run/continue stay honestly unavailable.
    const capabilities = expectStatus(await request('GET', '/api/v1/ai/capabilities'), 200, 'AI capabilities').json()
        .data;
    assert.equal(capabilities.provider.configured, false);
    assert.equal(capabilities.executionAvailable, false);
    const aiBalance = expectStatus(await request('GET', '/api/v1/ai/balance'), 200, 'AI balance').json().data;
    assert.ok(aiBalance.total >= 0);
    const aiIds = {
        conversation: randomUUID(),
        task: randomUUID(),
        interval: randomUUID(),
        userMessage: randomUUID(),
        assistantMessage: randomUUID(),
        operation: randomUUID(),
    };
    const aiRule = await pool.query(
        `select id from meal.ai_rule_versions where kind='cost' order by effective_at desc limit 1`,
    );
    assert.equal(aiRule.rows.length, 1, 'AI cost rule fixture');
    await ownerBatch([
        [
            `insert into meal.ai_conversations(id,title,archived_at,user_id,scope_id) values($1,$2,null,$3,$4)`,
            [aiIds.conversation, 'Exact local conversation', userId, privateScopeId],
        ],
        [
            `insert into meal.ai_tasks(id,goal,status,preview,accepted_at,accepted_cost,agreement_snapshot,conversation_id,rule_id)
             values($1,'Exact local task','completed',$2::jsonb,now(),1,$3::jsonb,$4,$5)`,
            [
                aiIds.task,
                JSON.stringify({ taskType: 'culinary_question' }),
                JSON.stringify({ accepted: true }),
                aiIds.conversation,
                aiRule.rows[0].id,
            ],
        ],
        [
            `insert into meal.ai_intervals(id,starts_at,ends_at,clarifications_used,cost,status,task_id)
             values($1,now()-interval '5 minutes',now()+interval '5 minutes',0,1,'completed',$2)`,
            [aiIds.interval, aiIds.task],
        ],
        [
            `insert into meal.ai_messages(id,role,body,client_message_key,conversation_id,interval_id)
             values($1,'user','Exact question',$2,$3,$4),($5,'assistant','Exact answer',$6,$3,$4)`,
            [
                aiIds.userMessage,
                `user:${aiIds.userMessage}`,
                aiIds.conversation,
                aiIds.interval,
                aiIds.assistantMessage,
                `assistant:${aiIds.assistantMessage}`,
            ],
        ],
        [
            `insert into meal.ai_operations(id,status,result_snapshot,started_at,finished_at,provider_cost,idempotency_key,interval_id,message_id)
             values($1,'completed',$2::jsonb,now()-interval '4 minutes',now()-interval '3 minutes',null,$3,$4,$5)`,
            [
                aiIds.operation,
                JSON.stringify({ text: 'Exact answer' }),
                `operation:${aiIds.operation}`,
                aiIds.interval,
                aiIds.userMessage,
            ],
        ],
    ]);
    const aiHistory = expectStatus(
        await request('GET', '/api/v1/ai/history?archived=active&limit=1'),
        200,
        'AI history',
    ).json().data;
    assert.equal(aiHistory.items[0].id, aiIds.task);
    const conversation = expectStatus(
        await request('GET', `/api/v1/ai/tasks/${aiIds.task}`),
        200,
        'AI conversation',
    ).json().data;
    assert.equal(conversation.messages.length, 2);
    assert.equal(conversation.item.result, 'Exact answer');
    const archivePayload = { archived: true, expectedVersion: 1, idempotencyKey: randomUUID() };
    const archivedAi = expectStatus(
        await request('PUT', `/api/v1/ai/history/${aiIds.task}/archive`, archivePayload),
        200,
        'AI history archive',
    ).json().data;
    assert.equal(archivedAi.item.archived, true);
    assert.deepEqual(
        expectStatus(
            await request('PUT', `/api/v1/ai/history/${aiIds.task}/archive`, archivePayload),
            200,
            'AI history archive replay',
        ).json().data,
        archivedAi,
    );
    expectStatus(
        await request('PUT', `/api/v1/ai/history/${aiIds.task}/archive`, {
            ...archivePayload,
            idempotencyKey: randomUUID(),
        }),
        409,
        'AI history stale CAS',
    );
    expectStatus(
        await request('POST', '/api/v1/ai/preview', {
            taskType: 'culinary_question',
            prompt: 'Exact provider boundary',
            usePersonalData: false,
            agreementAccepted: true,
        }),
        503,
        'AI provider preview fail closed',
    );
    expectStatus(
        await request('POST', `/api/v1/ai/tasks/${aiIds.task}/messages`, {
            message: 'Provider-bound continuation',
            idempotencyKey: randomUUID(),
            familyReserveAccepted: false,
        }),
        503,
        'AI provider continuation fail closed',
    );
    expectStatus(
        await request('POST', '/api/v1/ai/package/purchase', {
            idempotencyKey: randomUUID(),
            acceptedAmountMinor: 19900,
        }),
        503,
        'AI purchase fail closed',
    );

    // Family AI sharing uses a real selected family coverage. Recipient has exhausted their own share;
    // donor approval atomically moves ledger/bucket balance and both commands replay exactly.
    const familySubscriptionId = randomUUID();
    const familyPeriodId = randomUUID();
    const coverageId = randomUUID();
    const quotaId = randomUUID();
    const donorBucketId = randomUUID();
    const recipientBucketId = randomUUID();
    const donorGrantId = randomUUID();
    const recipientGrantId = randomUUID();
    await ownerBatch([
        [
            `update meal.subscription_periods period set ends_at=now()-interval '1 day',version=period.version+1
             from meal.subscriptions subscription where period.subscription_id=subscription.id and subscription.owner_id=$1 and period.ends_at>now()`,
            [familyRecipient.userId],
        ],
        [
            `insert into meal.subscriptions(id,status,auto_renew,billing_anchor,billing_timezone,owner_id,product_id)
             select $1,'active',false,now(),'Europe/Moscow',$2,id from meal.billing_products where code='pro'`,
            [familySubscriptionId, familyDonor.userId],
        ],
        [
            `insert into meal.subscription_periods(id,starts_at,ends_at,grant_kind,price_snapshot,subscription_id)
             values($1,now()-interval '1 day',now()+interval '30 days','paid',null,$2)`,
            [familyPeriodId, familySubscriptionId],
        ],
        [
            `insert into meal.family_coverages(id,reason,starts_at,ends_at,selected_at,family_id,subscription_id,combination_id)
             values($1,'owner_subscription',now()-interval '1 day',now()+interval '30 days',now(),$2,$3,null)`,
            [coverageId, familyId, familySubscriptionId],
        ],
        [
            `insert into meal.ai_quota_periods(id,starts_at,ends_at,granted_actions,allocation_snapshot,subscription_id,family_coverage_id,trial_claim_id)
             values($1,now()-interval '1 day',now()+interval '30 days',120,$2::jsonb,null,$3,null)`,
            [quotaId, JSON.stringify({ acceptance: true }), coverageId],
        ],
        [
            `insert into meal.ai_buckets(id,kind,granted,expires_at,balance_projection,reserved_projection,user_id,family_id,quota_period_id,order_id)
             values($1,'subscription',60,now()+interval '30 days',60,0,$2,null,$3,null),
                   ($4,'subscription',60,now()+interval '30 days',0,0,$5,null,$3,null)`,
            [donorBucketId, familyDonor.userId, quotaId, recipientBucketId, familyRecipient.userId],
        ],
        [
            `insert into meal.ai_ledger(id,kind,delta,reserved_delta,recorded_at,idempotency_key,bucket_id,operation_id,compensates_id)
             values($1,'grant',60,0,now(),$2,$3,null,null),($4,'grant',0,0,now(),$5,$6,null,null)`,
            [
                donorGrantId,
                `quota:${quotaId}:${familyDonor.userId}`,
                donorBucketId,
                recipientGrantId,
                `quota:${quotaId}:${familyRecipient.userId}`,
                recipientBucketId,
            ],
        ],
    ]);
    const sharing = expectStatus(
        await familyRecipient.request('GET', '/api/v1/ai/family-sharing'),
        200,
        'AI family sharing',
    ).json().data;
    assert.equal(sharing.members.length, 2);
    const transferPayload = { donorId: familyDonor.userId, amount: 5, idempotencyKey: randomUUID() };
    const transfer = expectStatus(
        await familyRecipient.request('POST', '/api/v1/ai/transfers', transferPayload),
        200,
        'AI transfer request',
    ).json().data;
    assert.equal(transfer.transfer.status, 'pending');
    assert.deepEqual(
        expectStatus(
            await familyRecipient.request('POST', '/api/v1/ai/transfers', transferPayload),
            200,
            'AI transfer request replay',
        ).json().data,
        transfer,
    );
    const decisionPayload = { decision: 'accept', expectedVersion: 1, idempotencyKey: randomUUID() };
    const transferDecision = expectStatus(
        await familyDonor.request('POST', `/api/v1/ai/transfers/${transfer.transfer.id}/decision`, decisionPayload),
        200,
        'AI transfer decision',
    ).json().data;
    assert.equal(transferDecision.transfer.status, 'accepted');
    assert.deepEqual(
        expectStatus(
            await familyDonor.request('POST', `/api/v1/ai/transfers/${transfer.transfer.id}/decision`, decisionPayload),
            200,
            'AI transfer decision replay',
        ).json().data,
        transferDecision,
    );

    // Revoke active Pro after writes: diary/nutrition/history remain readable, while fresh writes are rejected.
    await ownerWrite(
        `update meal.subscription_periods set ends_at=now()-interval '1 second',version=version+1 where id=$1`,
        [proPeriodId],
    );
    const formerDiary = expectStatus(
        await request('GET', '/api/v1/diary?date=2026-10-14'),
        200,
        'former-Pro diary read',
    ).json().data;
    assert.equal(formerDiary.access.mode, 'read_only');
    const formerNutrition = expectStatus(
        await request('GET', '/api/v1/nutrition/settings'),
        200,
        'former-Pro nutrition read',
    ).json().data;
    assert.equal(formerNutrition.access.mode, 'read_only');
    const formerExports = expectStatus(
        await request('GET', '/api/v1/exports?limit=1'),
        200,
        'former-Pro export history read',
    ).json().data;
    assert.equal(formerExports.items[0].id, exportCreated.id);
    expectStatus(await request('POST', '/api/v1/diary', diaryCreatePayload), 403, 'former-Pro replay is write-gated');
    expectStatus(
        await request('POST', '/api/v1/diary', { ...diaryCreatePayload, idempotencyKey: randomUUID() }),
        403,
        'former-Pro diary write blocked',
    );

    // AI appeal is intentionally last: the active AI sanction must block unrelated AI mutations but permit appeal.
    const sanctionId = randomUUID();
    await ownerWrite(
        `insert into meal.sanctions(id,scope,starts_at,ends_at,reason,revoked_at,rule_version,user_id,issued_by,case_id,safety_event_id,approved_by)
         values($1,'ai',now()-interval '1 minute',now()+interval '7 days','acceptance safety restriction',null,'acceptance-v1',$2,null,null,null,null)`,
        [sanctionId, userId],
    );
    const appealsBefore = expectStatus(await request('GET', '/api/v1/ai/appeals'), 200, 'AI appeals list before').json()
        .data;
    assert.equal(appealsBefore.restriction.id, sanctionId);
    assert.deepEqual(appealsBefore.items, []);
    const appealPayload = {
        sanctionId,
        body: 'Прошу пересмотреть AI-ограничение.',
        idempotencyKey: randomUUID(),
    };
    const appeal = expectStatus(
        await request('POST', '/api/v1/ai/appeals', appealPayload),
        200,
        'AI appeal create',
    ).json().data;
    assert.equal(appeal.appeal.status, 'pending');
    assert.deepEqual(
        expectStatus(await request('POST', '/api/v1/ai/appeals', appealPayload), 200, 'AI appeal replay').json().data,
        appeal,
    );
    const appealDetail = expectStatus(
        await request('GET', `/api/v1/ai/appeals/${appeal.appeal.id}`),
        200,
        'AI appeal detail',
    ).json().data;
    assert.equal(appealDetail.messages.length, 1);
    expectStatus(
        await request('POST', '/api/v1/ai/appeals', { ...appealPayload, body: 'Changed replay' }),
        409,
        'AI appeal changed replay',
    );

    const effects = await ownerPool.query(
        `select
           (select count(*)::int from meal.idempotency_records where actor_namespace=$1 and operation in('settings.onboarding','settings.preferences')) personalization_idempotency,
           (select count(*)::int from meal.recommendation_events where user_id=$2) recommendation_events,
           (select count(*)::int from meal.author_follows where follower_id=$2 and removed_at is null) follows,
           (select count(*)::int from meal.diary_entries where owner_id=$2) diary_entries,
           (select count(*)::int from meal.audit_events where actor_id=$2 and (action like 'diary.%' or action='portion.decided')) diary_audits,
           (select count(*)::int from meal.nutrition_profiles where user_id=$2) nutrition_profiles,
           (select count(*)::int from meal.nutrition_targets where profile_id in(select id from meal.nutrition_profiles where user_id=$2)) nutrition_targets,
           (select count(*)::int from meal.audit_events where actor_id=$2 and action like 'nutrition.%') nutrition_audits,
           (select count(*)::int from meal.export_jobs where user_id=$2) export_jobs,
           (select count(*)::int from meal.ai_transfers where id=$3 and status='accepted') accepted_transfers,
           (select count(*)::int from meal.ai_ledger where idempotency_key in($4,$5)) transfer_ledger,
           (select count(*)::int from meal.appeals where user_id=$2 and sanction_id=$6 and status='pending') appeals,
           (select count(*)::int from meal.support_tickets where requester_id=$2 and category='ai_appeal') appeal_tickets,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$1 and operation='ai-appeal-create') appeal_idempotency`,
        [
            `user:${userId}`,
            userId,
            transfer.transfer.id,
            `${transfer.transfer.id}:out`,
            `${transfer.transfer.id}:in`,
            sanctionId,
        ],
    );
    assert.deepEqual(effects.rows[0], {
        personalization_idempotency: 2,
        recommendation_events: 1,
        follows: 1,
        diary_entries: 2,
        diary_audits: 4,
        nutrition_profiles: 1,
        nutrition_targets: 1,
        nutrition_audits: 2,
        export_jobs: 1,
        accepted_transfers: 1,
        transfer_ledger: 2,
        appeals: 1,
        appeal_tickets: 1,
        appeal_idempotency: 1,
    });

    const operationIds = [
        'PersonalizationController_home',
        'PersonalizationController_detail',
        'PersonalizationController_onboarding',
        'PersonalizationController_preferences',
        'AiController_capabilities',
        'AiController_balance',
        'AiController_history',
        'AiController_archiveHistory',
        'AiController_familySharing',
        'AiController_requestTransfer',
        'AiController_decideTransfer',
        'AiController_task',
        'AiAppealsController_list',
        'AiAppealsController_create',
        'AiAppealsController_detail',
        'DiaryController_create',
        'DiaryController_sources',
        'DiaryController_decidePortion',
        'DiaryController_update',
        'DiaryController_archive',
        'ExportsController_list',
        'ExportsController_create',
        'ExportsController_preview',
        'NutritionController_settings',
        'NutritionController_profile',
        'NutritionController_target',
        'NutritionController_analytics',
        'RecommendationsController_list',
        'RecommendationsController_event',
        'RecommendationsController_follow',
        'RecommendationsController_followState',
        'RecommendationsController_following',
    ];
    assert.equal(operationIds.length, 32);
    console.log(
        `AI_PRO_DOMAIN_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'ai-pro-domain-live-v1',
            operationIds,
            effects: effects.rows[0],
            assertions: {
                exactResponses: true,
                databaseReadback: true,
                auditEffects: true,
                idempotentReplay: true,
                changedReplayRollback: true,
                optimisticConcurrency: true,
                consentGate: true,
                activeProAndFormerPro: true,
                familyTransferAtomicity: true,
                providerBoundariesFailClosed: true,
            },
        })}`,
    );
}
