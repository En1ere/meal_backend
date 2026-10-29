import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { adminFreeAiGrantSchema, adminFreeAiViewSchema } from '../src/modules/admin-free-ai/admin-free-ai.contracts.js';
import {
    notificationCenterSchema,
    notificationQuietNow,
    validNotificationTimeZone,
} from '../src/modules/admin-notifications/notification-center.contracts.js';
import { defaultAdminNotificationSettings } from '../src/modules/admin-notifications/notification-center.service.js';
import { operationAvailability } from '../src/modules/admin-operations/operations.service.js';
import {
    compareContentCards,
    notDuplicateDecisionApplies,
} from '../src/modules/admin-content/admin-content.service.js';
import { governanceCommandSchema } from '../src/modules/admin-governance/admin-governance.contracts.js';
import { supportManageSchema } from '../src/modules/admin-support/admin-support.contracts.js';

await test('Free AI grant contract requires bounded quota, audit reason and explicit confirmation', () => {
    const base = {
        expectedUserVersion: '1',
        actions: 10,
        expiresAt: null,
        reason: 'Проверка бесплатного тарифа',
        idempotencyKey: randomUUID(),
        confirmed: true,
    };
    assert.equal(adminFreeAiGrantSchema.safeParse(base).success, true);
    assert.equal(adminFreeAiGrantSchema.safeParse({ ...base, actions: 0 }).success, false);
    assert.equal(adminFreeAiGrantSchema.safeParse({ ...base, actions: 10001 }).success, false);
    assert.equal(adminFreeAiGrantSchema.safeParse({ ...base, reason: ' ' }).success, false);
    assert.equal(adminFreeAiGrantSchema.safeParse({ ...base, confirmed: false }).success, false);
    assert.equal(
        adminFreeAiViewSchema.safeParse({
            user: { id: randomUUID(), login: 'free1', displayName: 'Free', status: 'active', version: '1' },
            buckets: [],
            total: 0,
            reserved: 0,
            available: 0,
            recentOperations: [],
        }).success,
        true,
    );
});

await test('admin notification defaults are off and security bypasses quiet hours only', () => {
    const settings = defaultAdminNotificationSettings();
    assert.equal(notificationCenterSchema.shape.settings.safeParse(settings).success, true);
    for (const item of Object.values(settings.categories))
        assert.deepEqual(item, {
            browser: false,
            mobilePush: false,
            email: false,
        });
    assert.equal(validNotificationTimeZone('Europe/Moscow'), true);
    assert.equal(validNotificationTimeZone('not/a-zone'), false);
    const duringQuietHours = new Date('2026-10-01T20:30:00.000Z');
    assert.equal(notificationQuietNow(settings, 'operations', duringQuietHours), true);
    assert.equal(notificationQuietNow(settings, 'security', duringQuietHours), false);
});

await test('Free admin operations permit only bounded recipe-import retries and lifecycle-only error changes', () => {
    assert.equal(operationAvailability('operations', 'recipe_import', 'failed')[0]?.enabled, true);
    assert.equal(operationAvailability('operations', 'payment', 'failed')[0]?.enabled, false);
    assert.equal(operationAvailability('operations', 'recipe_import', 'running')[1]?.enabled, false);
    assert.deepEqual(
        operationAvailability('errors', 'IMPORT_TIMEOUT', 'new').map((item) => item.operation),
        ['new', 'in_progress', 'resolved', 'ignored'],
    );
});

await test('catalog comparison binds versions, resolves every selected conflict and blocks uncertain composition', () => {
    const left = {
        id: randomUUID(),
        version: 2,
        name: 'Молоко A',
        fields: { name: 'Молоко A', composition: 'молоко' },
        variants: [],
        authors: [],
        sources: [],
        aliasOf: null,
    };
    const right = { ...left, id: randomUUID(), name: 'Молоко B', fields: { name: 'Молоко B', composition: 'молоко' } };
    const comparison = compareContentCards(left, right, {
        leftId: left.id,
        rightId: right.id,
        leftVersion: 2,
        rightVersion: 2,
        canonicalId: left.id,
        choices: { name: 'left' },
    });
    assert.equal(comparison.resolved.name, 'Молоко A');
    assert.equal(comparison.blockedReason, null);
    assert.equal(comparison.previewKey.length, 64);
    assert.throws(() =>
        compareContentCards(left, right, {
            leftId: left.id,
            rightId: right.id,
            leftVersion: 1,
            rightVersion: 2,
            canonicalId: left.id,
            choices: {},
        }),
    );
    assert.ok(
        compareContentCards(
            left,
            { ...right, fields: { ...right.fields, composition: null } },
            {
                leftId: left.id,
                rightId: right.id,
                leftVersion: 2,
                rightVersion: 2,
                canonicalId: left.id,
                choices: { name: 'left', composition: 'left' },
            },
        ).blockedReason,
    );
});

await test('not-duplicate decision binds an unordered product pair to exact versions', () => {
    const left = { id: randomUUID(), version: 3 };
    const right = { id: randomUUID(), version: 7 };
    const direct = {
        source_product_id: left.id,
        target_product_id: right.id,
        preview: { leftVersion: left.version, rightVersion: right.version },
    };
    assert.equal(notDuplicateDecisionApplies(direct, left, right), true);
    assert.equal(notDuplicateDecisionApplies(direct, { ...left, version: 4 }, right), false);
    assert.equal(notDuplicateDecisionApplies(direct, right, left), true);
    assert.equal(
        notDuplicateDecisionApplies(
            { ...direct, source_product_id: randomUUID(), target_product_id: randomUUID() },
            left,
            right,
        ),
        false,
    );
});

await test('governance and support commands require explicit safe inputs', () => {
    const governance = {
        version: '1',
        idempotencyKey: randomUUID(),
        action: 'ban',
        appealId: undefined,
        appealVersion: undefined,
        category: null,
        scope: 'account',
        startsAt: null,
        endsAt: null,
        reason: 'Нарушение',
        privateNote: '',
        allowTemporaryBan: false,
        subscriptionDisposition: 'keep',
        subscriptionRecipientUserId: null,
        confirmed: true,
    };
    assert.equal(governanceCommandSchema.safeParse(governance).success, false);
    assert.equal(governanceCommandSchema.safeParse({ ...governance, category: 'rules' }).success, true);
    assert.equal(
        governanceCommandSchema.safeParse({
            ...governance,
            category: 'rules',
            subscriptionDisposition: 'transfer',
            subscriptionRecipientUserId: randomUUID(),
        }).success,
        true,
    );
    assert.equal(
        governanceCommandSchema.safeParse({
            ...governance,
            category: 'rules',
            subscriptionDisposition: 'transfer',
            subscriptionRecipientUserId: null,
        }).success,
        false,
    );
    assert.equal(governanceCommandSchema.safeParse({ ...governance, confirmed: false }).success, false);
    assert.equal(
        supportManageSchema.safeParse({
            version: '1',
            idempotencyKey: randomUUID(),
            action: 'attach',
            targetId: null,
            text: '',
            attachments: [{ name: 'evidence.mp4', type: 'video/mp4', size: 1024, duration: 11 }],
        }).success,
        false,
    );
});
