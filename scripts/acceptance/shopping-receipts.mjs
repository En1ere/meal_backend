import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

const expectStatus = (response, status, label) => {
    assert.equal(response.statusCode, status, `${label}: ${response.body}`);
    return response;
};

const createAuthenticatedUser = async (app, frontendOrigin, label) => {
    let requestIndex = 0;
    const inject = (options) => app.inject({ ...options, remoteAddress: `198.28.0.${(++requestIndex % 240) + 1}` });
    const csrf = expectStatus(await inject({ method: 'GET', url: '/api/v1/auth/csrf' }), 200, `${label} csrf`);
    const cookies = new Map(csrf.cookies.map((cookie) => [cookie.name, cookie.value]));
    const suffix = randomBytes(6).toString('hex');
    const usernameLabel = label.replace(/[^a-z0-9_]/gi, '_');
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
                username: `${usernameLabel}_${suffix}`,
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
        await inject({
            method: 'POST',
            url: '/api/v1/auth/email/verify',
            headers: headers(),
            payload: { token },
        }),
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

export async function runShoppingReceiptsAcceptance({
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
    plusSubscriptionId,
    proSubscriptionId,
}) {
    const ownerWrite = async (statement, values) => {
        const client = await ownerPool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(statement, values);
            await client.query('commit');
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
            remoteAddress: `198.29.0.${(++requestIndex % 240) + 1}`,
            ...(payload === undefined ? {} : { payload }),
        });
    const expectError = async (promise, status, label) => {
        const response = await promise;
        expectStatus(response, status, label);
        assert.ok(response.json().error?.code, `${label}: error envelope`);
        return response;
    };
    const item = (overrides = {}) => ({
        name: `Acceptance shopping item ${suffix}`,
        quantity: '2',
        unit: 'pcs',
        ingredientId,
        productId: null,
        allowAnalog: true,
        recipeOrigin: [],
        requirements: {},
        estimatedPriceMinor: 15000,
        ...overrides,
    });
    const purchaseLine = (overrides = {}) => ({
        id: randomUUID(),
        name: `Acceptance purchase line ${suffix}`,
        quantity: '3',
        unit: 'pcs',
        ingredientId,
        productId: null,
        locationId,
        isFood: true,
        intake: true,
        shoppingItemId: null,
        expiryOn: null,
        amountMinor: null,
        originalAmountMinor: null,
        discountMinor: null,
        ...overrides,
    });

    await expectError(request('GET', '/api/v1/shopping-lists', undefined, {}), 401, 'shopping unauthenticated');
    await expectError(
        request('POST', '/api/v1/shopping-lists', {
            title: 'Forbidden family list',
            scope: 'family',
            idempotencyKey: randomUUID(),
        }),
        403,
        'free family write gate',
    );

    const createKey = randomUUID();
    const createPayload = { title: `Acceptance list ${suffix}`, scope: 'private', idempotencyKey: createKey };
    const created = expectStatus(
        await request('POST', '/api/v1/shopping-lists', createPayload),
        200,
        'shopping create',
    );
    const list = created.json().data;
    assert.equal(list.version, 1);
    assert.equal(list.scope, 'private');
    const createReplay = expectStatus(
        await request('POST', '/api/v1/shopping-lists', createPayload),
        200,
        'shopping create replay',
    );
    assert.equal(createReplay.json().data.id, list.id);
    await expectError(
        request('POST', '/api/v1/shopping-lists', { ...createPayload, title: `${createPayload.title} changed` }),
        409,
        'shopping create altered replay',
    );
    expectStatus(
        await request(
            'GET',
            `/api/v1/shopping-lists?q=${encodeURIComponent(createPayload.title)}&status=active&limit=1&scope=private`,
        ),
        200,
        'shopping list query',
    );
    expectStatus(await request('GET', `/api/v1/shopping-lists/${list.id}?scope=private`), 200, 'shopping detail');

    const addKey = randomUUID();
    const addPayload = {
        version: 1,
        idempotencyKey: addKey,
        scope: 'private',
        items: [item(), item({ name: `Unknown quantity ${suffix}`, quantity: null })],
    };
    const added = expectStatus(
        await request('POST', `/api/v1/shopping-lists/${list.id}/items`, addPayload),
        200,
        'shopping add',
    ).json().data;
    assert.equal(added.version, 2);
    assert.equal(added.items.length, 2);
    expectStatus(
        await request('POST', `/api/v1/shopping-lists/${list.id}/items`, addPayload),
        200,
        'shopping add replay',
    );
    await expectError(
        request('POST', `/api/v1/shopping-lists/${list.id}/items`, {
            ...addPayload,
            items: [item({ name: 'Changed replay line' })],
        }),
        409,
        'shopping add altered replay',
    );
    const firstItem = added.items[0];
    const secondItem = added.items[1];
    const editPayload = {
        version: firstItem.version,
        idempotencyKey: randomUUID(),
        status: 'pending',
        fields: item({ name: `${firstItem.name} edited` }),
        scope: 'private',
    };
    const edited = expectStatus(
        await request('POST', `/api/v1/shopping-lists/${list.id}/items/${firstItem.id}`, editPayload),
        200,
        'shopping edit',
    ).json().data;
    assert.equal(edited.version, 3);
    const staleEditKey = randomUUID();
    await expectError(
        request('POST', `/api/v1/shopping-lists/${list.id}/items/${firstItem.id}`, {
            ...editPayload,
            idempotencyKey: staleEditKey,
        }),
        412,
        'shopping stale edit',
    );
    const reordered = expectStatus(
        await request('POST', `/api/v1/shopping-lists/${list.id}/reorder`, {
            version: 3,
            itemIds: [secondItem.id, firstItem.id],
            scope: 'private',
            idempotencyKey: randomUUID(),
        }),
        200,
        'shopping reorder',
    ).json().data;
    assert.deepEqual(
        reordered.items.map((value) => value.id),
        [secondItem.id, firstItem.id],
    );
    const rename = expectStatus(
        await request('POST', `/api/v1/shopping-lists/${list.id}/command`, {
            action: 'rename',
            title: `${createPayload.title} renamed`,
            version: 4,
            scope: 'private',
            idempotencyKey: randomUUID(),
        }),
        200,
        'shopping rename',
    ).json().data;
    const archived = expectStatus(
        await request('POST', `/api/v1/shopping-lists/${list.id}/command`, {
            action: 'archive',
            version: rename.version,
            scope: 'private',
            idempotencyKey: randomUUID(),
        }),
        200,
        'shopping archive',
    ).json().data;
    await expectError(
        request('POST', `/api/v1/shopping-lists/${list.id}/items`, {
            version: archived.version,
            idempotencyKey: randomUUID(),
            scope: 'private',
            items: [item()],
        }),
        409,
        'archived shopping mutation',
    );
    const restored = expectStatus(
        await request('POST', `/api/v1/shopping-lists/${list.id}/command`, {
            action: 'restore',
            version: archived.version,
            scope: 'private',
            idempotencyKey: randomUUID(),
        }),
        200,
        'shopping restore',
    ).json().data;
    const history = expectStatus(
        await request('GET', `/api/v1/shopping-lists/${list.id}/history?scope=private`),
        200,
        'shopping history',
    );
    assert.ok(history.json().data.items.length >= 6);
    expectStatus(
        await request('GET', `/api/v1/shopping-lists/recipe-preview?recipeId=${recipeId}&servings=2&scope=private`),
        200,
        'shopping recipe preview',
    );

    const shoppingKnownLine = purchaseLine({ shoppingItemId: firstItem.id });
    const shoppingUnknownLine = purchaseLine({
        name: `Unknown purchase ${suffix}`,
        quantity: null,
        locationId: null,
        intake: false,
        shoppingItemId: secondItem.id,
    });
    const shoppingReview = {
        version: restored.version,
        purchasedAt: new Date().toISOString(),
        lines: [shoppingKnownLine, shoppingUnknownLine],
        scope: 'private',
    };
    const shoppingPreview = expectStatus(
        await request('POST', `/api/v1/shopping-lists/${list.id}/purchase-preview`, shoppingReview),
        200,
        'shopping purchase preview',
    ).json().data;
    assert.equal(shoppingPreview.lines[0].allocatedQuantity, '2');
    assert.equal(shoppingPreview.lines[0].overage, '1');
    const shoppingCommitKey = randomUUID();
    const shoppingCommitPayload = {
        ...shoppingReview,
        previewToken: shoppingPreview.previewToken,
        idempotencyKey: shoppingCommitKey,
    };
    const shoppingCommit = expectStatus(
        await request('POST', `/api/v1/shopping-lists/${list.id}/purchase-commit`, shoppingCommitPayload),
        200,
        'shopping purchase commit',
    ).json().data;
    assert.equal(shoppingCommit.batchIds.length, 1);
    assert.equal(shoppingCommit.unknownLineIds.length, 1);
    const shoppingCommitReplay = expectStatus(
        await request('POST', `/api/v1/shopping-lists/${list.id}/purchase-commit`, shoppingCommitPayload),
        200,
        'shopping purchase replay',
    );
    assert.deepEqual(shoppingCommitReplay.json().data, shoppingCommit);
    await expectError(
        request('POST', `/api/v1/shopping-lists/${list.id}/purchase-commit`, {
            ...shoppingCommitPayload,
            purchasedAt: new Date(Date.now() - 1000).toISOString(),
        }),
        409,
        'shopping purchase altered replay',
    );
    await expectError(
        request('POST', `/api/v1/shopping-lists/${list.id}/purchase-preview`, shoppingReview),
        412,
        'shopping stale purchase preview',
    );

    const purchaseDetail = expectStatus(
        await request('GET', `/api/v1/purchases/${shoppingCommit.purchaseId}?scope=private`),
        200,
        'purchase detail',
    ).json().data;
    const unknownLine = purchaseDetail.lines.find((line) => line.id === shoppingCommit.unknownLineIds[0]);
    assert.ok(unknownLine);
    const { version: unknownLineVersion, batchIds: unknownBatchIds, ...unknownLineInput } = unknownLine;
    void unknownBatchIds;
    const resolveLine = {
        ...unknownLineInput,
        quantity: '4',
        locationId,
        intake: true,
    };
    const resolvePayload = { version: unknownLineVersion, line: resolveLine, scope: 'private' };
    const resolvePreview = expectStatus(
        await request('POST', `/api/v1/purchases/${shoppingCommit.purchaseId}/resolve-preview`, resolvePayload),
        200,
        'purchase resolve preview',
    ).json().data;
    const resolveKey = randomUUID();
    const resolveCommitPayload = {
        ...resolvePayload,
        previewToken: resolvePreview.previewToken,
        idempotencyKey: resolveKey,
    };
    const resolved = expectStatus(
        await request('POST', `/api/v1/purchases/${shoppingCommit.purchaseId}/resolve-commit`, resolveCommitPayload),
        200,
        'purchase resolve commit',
    ).json().data;
    assert.equal(resolved.version, 2);
    assert.equal(resolved.lines.find((line) => line.id === unknownLine.id).batchIds.length, 1);
    expectStatus(
        await request('POST', `/api/v1/purchases/${shoppingCommit.purchaseId}/resolve-commit`, resolveCommitPayload),
        200,
        'purchase resolve replay',
    );
    await expectError(
        request('POST', `/api/v1/purchases/${shoppingCommit.purchaseId}/resolve-commit`, {
            ...resolveCommitPayload,
            line: { ...resolveLine, quantity: '5' },
        }),
        409,
        'purchase resolve altered replay',
    );
    await expectError(
        request('POST', `/api/v1/purchases/${shoppingCommit.purchaseId}/resolve-preview`, {
            ...resolvePayload,
            version: unknownLineVersion + 1,
        }),
        409,
        'purchase already resolved',
    );

    const capabilities = expectStatus(
        await request('GET', '/api/v1/receipts/capabilities'),
        200,
        'receipt capabilities',
    ).json().data;
    assert.deepEqual(capabilities, {
        photo: true,
        electronicLink: true,
        pdfUpload: false,
        ocrAdapter: false,
        pdfUnavailableReason: 'storage_not_configured',
    });
    await expectError(
        request('POST', '/api/v1/receipts', {
            idempotencyKey: randomUUID(),
            source: { kind: 'electronic_link', storageStatus: 'not_required', reference: 'https://example.test/r' },
            ocrText: '',
            lines: [purchaseLine({ intake: false, locationId: null })],
            financial: null,
            scope: 'private',
        }),
        403,
        'former pro receipt write gate',
    );
    const receiptCreateKey = randomUUID();
    const receiptCreatePayload = {
        idempotencyKey: receiptCreateKey,
        source: { kind: 'photo', storageStatus: 'deferred', reference: 'local-preview-only' },
        ocrText: `OCR acceptance ${suffix}`,
        lines: [purchaseLine({ intake: false, locationId: null, quantity: '1' })],
        financial: null,
        scope: 'private',
    };
    const receiptCreated = expectStatus(
        await request('POST', '/api/v1/receipts', receiptCreatePayload),
        200,
        'receipt create',
    ).json().data.receipt;
    const receiptCreateReplay = expectStatus(
        await request('POST', '/api/v1/receipts', receiptCreatePayload),
        200,
        'receipt create replay',
    );
    assert.equal(receiptCreateReplay.json().data.receipt.id, receiptCreated.id);
    expectStatus(await request('GET', `/api/v1/receipts/${receiptCreated.id}?scope=private`), 200, 'receipt detail');
    const receiptEditedLine = purchaseLine({ intake: true, quantity: '2' });
    const receiptEditPayload = {
        version: 1,
        idempotencyKey: randomUUID(),
        lines: [receiptEditedLine],
        scope: 'private',
    };
    const receiptEdited = expectStatus(
        await request('POST', `/api/v1/receipts/${receiptCreated.id}/edit`, receiptEditPayload),
        200,
        'receipt edit',
    ).json().data.receipt;
    assert.equal(receiptEdited.version, 2);
    const duplicates = expectStatus(
        await request('GET', `/api/v1/receipts/${receiptCreated.id}/duplicates?scope=private`),
        200,
        'receipt duplicates',
    );
    assert.ok(duplicates.json().data.items.some((candidate) => candidate.purchaseId === shoppingCommit.purchaseId));
    const receiptReview = {
        version: receiptEdited.version,
        purchasedAt: new Date().toISOString(),
        lines: [receiptEditedLine],
        scope: 'private',
    };
    const receiptPreview = expectStatus(
        await request('POST', `/api/v1/receipts/${receiptCreated.id}/intake-preview`, receiptReview),
        200,
        'receipt intake preview',
    ).json().data;
    const receiptCommitPayload = {
        ...receiptReview,
        previewToken: receiptPreview.previewToken,
        idempotencyKey: randomUUID(),
    };
    const receiptCommitted = expectStatus(
        await request('POST', `/api/v1/receipts/${receiptCreated.id}/commit`, receiptCommitPayload),
        200,
        'receipt commit',
    ).json().data.receipt;
    assert.equal(receiptCommitted.status, 'committed');
    assert.equal(receiptCommitted.result.batchIds.length, 1);
    expectStatus(
        await request('POST', `/api/v1/receipts/${receiptCreated.id}/commit`, receiptCommitPayload),
        200,
        'receipt commit replay',
    );
    await expectError(
        request('POST', `/api/v1/receipts/${receiptCreated.id}/commit`, {
            ...receiptCommitPayload,
            idempotencyKey: randomUUID(),
            version: receiptCommitted.version,
        }),
        409,
        'receipt duplicate commit',
    );

    const linkDraft = expectStatus(
        await request('POST', '/api/v1/receipts', {
            ...receiptCreatePayload,
            idempotencyKey: randomUUID(),
            ocrText: `Duplicate OCR ${suffix}`,
        }),
        200,
        'receipt link draft',
    ).json().data.receipt;
    const linkPayload = {
        version: linkDraft.version,
        idempotencyKey: randomUUID(),
        purchaseId: shoppingCommit.purchaseId,
        scope: 'private',
    };
    const linked = expectStatus(
        await request('POST', `/api/v1/receipts/${linkDraft.id}/link-purchase`, linkPayload),
        200,
        'receipt link purchase',
    ).json().data.receipt;
    assert.equal(linked.status, 'linked');
    assert.equal(linked.result.purchaseId, shoppingCommit.purchaseId);
    expectStatus(
        await request('POST', `/api/v1/receipts/${linkDraft.id}/link-purchase`, linkPayload),
        200,
        'receipt link replay',
    );

    const foreign = await createAuthenticatedUser(app, frontendOrigin, 'commerce-idor');
    for (const [url, label] of [
        [`/api/v1/shopping-lists/${list.id}?scope=private`, 'foreign shopping list'],
        [`/api/v1/receipts/${receiptCreated.id}?scope=private`, 'foreign receipt'],
        [`/api/v1/purchases/${shoppingCommit.purchaseId}?scope=private`, 'foreign purchase'],
    ]) {
        await expectError(request('GET', url, undefined, foreign.headers()), 404, label);
    }

    const familyPeriodId = randomUUID();
    await ownerWrite(
        `insert into meal.subscription_periods(id,starts_at,ends_at,grant_kind,price_snapshot,subscription_id)
         values($1,now()-interval '1 minute',now()+interval '1 day','paid',null,$2)`,
        [familyPeriodId, plusSubscriptionId],
    );
    const familyList = expectStatus(
        await request('POST', '/api/v1/shopping-lists', {
            title: `Family acceptance ${suffix}`,
            scope: 'family',
            idempotencyKey: randomUUID(),
        }),
        200,
        'plus family shopping create',
    ).json().data;
    assert.equal(familyList.scope, 'family');
    expectStatus(
        await request('GET', `/api/v1/shopping-lists/${familyList.id}?scope=family`),
        200,
        'plus family shopping detail',
    );
    const familyReceipt = expectStatus(
        await request('POST', '/api/v1/receipts', {
            idempotencyKey: randomUUID(),
            source: { kind: 'photo', storageStatus: 'deferred', reference: null },
            ocrText: `Family OCR ${suffix}`,
            lines: [
                purchaseLine({
                    name: `Family nonfood ${suffix}`,
                    quantity: null,
                    unit: null,
                    ingredientId: null,
                    locationId: null,
                    isFood: false,
                    intake: false,
                }),
            ],
            financial: null,
            scope: 'family',
        }),
        200,
        'plus family receipt create',
    ).json().data.receipt;
    assert.equal(familyReceipt.status, 'draft');
    await ownerWrite(`update meal.subscription_periods set ends_at=now()-interval '1 minute' where id=$1`, [
        familyPeriodId,
    ]);
    await expectError(
        request('GET', `/api/v1/shopping-lists/${familyList.id}?scope=family`),
        403,
        'expired family scope gate',
    );

    const proPeriodId = randomUUID();
    await ownerWrite(
        `insert into meal.subscription_periods(id,starts_at,ends_at,grant_kind,price_snapshot,subscription_id)
         values($1,now()-interval '1 minute',now()+interval '1 day','paid',null,$2)`,
        [proPeriodId, proSubscriptionId],
    );
    const proLine = purchaseLine({ amountMinor: 25000, originalAmountMinor: 30000, discountMinor: 5000 });
    const proReceipt = expectStatus(
        await request('POST', '/api/v1/receipts', {
            idempotencyKey: randomUUID(),
            source: {
                kind: 'electronic_link',
                storageStatus: 'not_required',
                reference: 'https://example.test/acceptance-receipt',
            },
            ocrText: `Electronic receipt ${suffix}`,
            lines: [proLine],
            financial: {
                currency: 'RUB',
                storeName: 'Acceptance store',
                totalMinor: 25000,
                discountMinor: 5000,
                paymentMethod: 'card',
                fiscalNumber: null,
                fiscalDocumentNumber: null,
                financeConsent: true,
                consentedAt: null,
            },
            scope: 'private',
        }),
        200,
        'active pro financial receipt',
    ).json().data.receipt;
    assert.equal(proReceipt.source.kind, 'electronic_link');
    await ownerWrite(`update meal.subscription_periods set ends_at=now()-interval '1 minute' where id=$1`, [
        proPeriodId,
    ]);

    const effects = await pool.query(
        `select
           (select count(*)::int from meal.shopping_lists where id=any($1::uuid[])) lists,
           (select count(*)::int from meal.shopping_items where list_id=$2) shopping_items,
           (select count(*)::int from meal.receipts where id=any($3::uuid[])) receipts,
           (select count(*)::int from meal.purchases where id in($4,$5)) purchases,
           (select count(*)::int from meal.purchase_lines where purchase_id in($4,$5)) purchase_lines,
           (select count(*)::int from meal.stock_intakes si join meal.purchase_lines pl on pl.id=si.purchase_line_id where pl.purchase_id in($4,$5)) stock_intakes,
           (select count(*)::int from meal.shopping_allocations sa join meal.purchase_lines pl on pl.id=sa.purchase_line_id where pl.purchase_id=$4) allocations,
           (select count(*)::int from meal.audit_events where actor_id=$6 and target_type in('shopping_list','receipt','purchase')) audits,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$7 and operation in('shopping','receipt','purchase')) idempotency,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$7 and key=$8) stale_idempotency`,
        [
            [list.id, familyList.id],
            list.id,
            [receiptCreated.id, linkDraft.id, familyReceipt.id, proReceipt.id],
            shoppingCommit.purchaseId,
            receiptCommitted.result.purchaseId,
            userId,
            `user:${userId}`,
            staleEditKey,
        ],
    );
    assert.deepEqual(effects.rows[0], {
        lists: 2,
        shopping_items: 2,
        receipts: 4,
        purchases: 2,
        purchase_lines: 3,
        stock_intakes: 3,
        allocations: 1,
        audits: 17,
        idempotency: 17,
        stale_idempotency: 0,
    });
    console.log(
        `SHOPPING_RECEIPTS_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'shopping-receipts-live-v1',
            operationIds: [
                'ShoppingController_command',
                'ShoppingController_reorder',
                'ShoppingController_purchasePreview',
                'ShoppingController_purchaseCommit',
                'ShoppingController_list',
                'ShoppingController_create',
                'ShoppingController_preview',
                'ShoppingController_history',
                'ShoppingController_detail',
                'ShoppingController_add',
                'ShoppingController_edit',
                'ReceiptsController_capabilities',
                'ReceiptsController_detail',
                'ReceiptsController_create',
                'ReceiptsController_edit',
                'ReceiptsController_preview',
                'ReceiptsController_commit',
                'ReceiptsController_duplicates',
                'ReceiptsController_link',
                'PurchasesController_detail',
                'PurchasesController_preview',
                'PurchasesController_commit',
            ],
            effects: effects.rows[0],
            assertions: {
                freePrivateSuccess: true,
                plusFamilySuccessAndExpiryGate: true,
                activeProFinancialSuccess: true,
                formerProWriteGate: true,
                unauthenticated: true,
                objectIsolation: true,
                optimisticConcurrency: true,
                idempotentReplay: true,
                alteredReplayConflict: true,
                staleFailureRollback: true,
                unknownQuantityResolveOnce: true,
                duplicateReceiptLinkNoDuplicateIntake: true,
                allocationPartialAndOverage: true,
                storageAndOcrFailClosed: true,
                auditAndHistory: true,
                queryAndPagination: true,
                databaseEffects: true,
            },
        })}`,
    );
}
