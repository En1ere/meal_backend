import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    familyCreateSchema,
    familyInvitationAcceptSchema,
    familyInvitationCreateSchema,
    familyInvitationDecisionSchema,
    familyLeaveSchema,
} from '../src/modules/family/family.contracts.js';
import { entitlementCapabilities } from '../src/modules/entitlements/entitlements.service.js';
import { selectFamilySuccessor } from '../src/modules/family/family.service.js';
import {
    planMutationSchema,
    planQuerySchema,
    portionAssignSchema,
    portionDecisionSchema,
    planAutomationPreviewSchema,
} from '../src/modules/meal-plan/meal-plan.contracts.js';
import { planRange, weeklyDates } from '../src/modules/meal-plan/meal-plan.domain.js';
import { familyNoteCreateSchema, familyNoteToggleSchema } from '../src/modules/family-notes/family-notes.contracts.js';
import {
    chatDraftCommandSchema,
    chatMessageCreateSchema,
    chatMessageUpdateSchema,
    chatReactionCommandSchema,
} from '../src/modules/family-chat/family-chat.contracts.js';

await test('Plus and Pro capabilities preserve the agreed tariff boundary', () => {
    assert.deepEqual(entitlementCapabilities('free'), {
        family: false,
        qr: false,
        planningRange: false,
        smartShopping: false,
        familyChat: false,
        familyNotes: false,
        calendar: false,
        finance: false,
        diary: false,
        aiMonthlyAllowance: 0,
    });
    assert.equal(entitlementCapabilities('plus').family, true);
    assert.equal(entitlementCapabilities('plus').aiMonthlyAllowance, 40);
    assert.equal(entitlementCapabilities('plus').calendar, false);
    assert.equal(entitlementCapabilities('pro').aiMonthlyAllowance, 120);
    assert.equal(entitlementCapabilities('pro').calendar, true);
});

await test('family creation trims names and rejects injected or malformed fields', () => {
    const valid = familyCreateSchema.parse({
        name: '  Наш дом  ',
        idempotencyKey: '90000000-0000-4000-8000-000000000001',
    });
    assert.equal(valid.name, 'Наш дом');
    assert.equal(familyCreateSchema.safeParse({ ...valid, role: 'owner' }).success, false);
    assert.equal(familyCreateSchema.safeParse({ ...valid, name: ' ' }).success, false);
    assert.equal(familyCreateSchema.safeParse({ ...valid, idempotencyKey: 'not-a-uuid' }).success, false);
});

await test('automatic ownership transfer selects longest continuous membership then stable order', () => {
    const result = selectFamilySuccessor([
        { id: 'c', joinedAt: '2026-01-01T00:00:00.000Z', stableOrder: 3 },
        { id: 'b', joinedAt: '2025-01-01T00:00:00.000Z', stableOrder: 2 },
        { id: 'a', joinedAt: '2025-01-01T00:00:00.000Z', stableOrder: 1 },
    ]);
    assert.equal(result?.id, 'a');
    assert.equal(selectFamilySuccessor([]), null);
});

await test('owner leave contract requires either an explicit successor or automatic selection', () => {
    const base = { expectedVersion: 1, idempotencyKey: '90000000-0000-4000-8000-000000000001' };
    assert.equal(
        familyLeaveSchema.safeParse({ ...base, selection: 'automatic', successorMembershipId: null }).success,
        true,
    );
    assert.equal(
        familyLeaveSchema.safeParse({ ...base, selection: 'manual', successorMembershipId: null }).success,
        false,
    );
    assert.equal(
        familyLeaveSchema.safeParse({ ...base, selection: 'automatic', successorMembershipId: crypto.randomUUID() })
            .success,
        false,
    );
});

await test('family invitations bind exact login, optimistic versions and one idempotent acceptance', () => {
    assert.equal(
        familyInvitationCreateSchema.safeParse({
            login: 'user1',
            expectedVersion: 1,
            idempotencyKey: crypto.randomUUID(),
        }).success,
        true,
    );
    assert.equal(
        familyInvitationCreateSchema.safeParse({
            login: 'user@example.test',
            expectedVersion: 1,
            idempotencyKey: crypto.randomUUID(),
        }).success,
        false,
    );
    assert.equal(
        familyInvitationDecisionSchema.safeParse({ expectedVersion: 1, idempotencyKey: crypto.randomUUID() }).success,
        true,
    );
    assert.equal(
        familyInvitationAcceptSchema.safeParse({
            token: 'a'.repeat(64),
            expectedFamilyVersion: 1,
            idempotencyKey: crypto.randomUUID(),
        }).success,
        true,
    );
});

await test('Plus range planning follows real dates and validates distributed portions', () => {
    const selection = planQuerySchema.parse({
        scope: 'family',
        view: 'range',
        date: '2026-01-01',
        endDate: '2026-12-31',
        timezone: 'Europe/Moscow',
    });
    assert.deepEqual(planRange(selection), { startsOn: '2026-01-01', endsOn: '2026-12-31' });
    const base = {
        action: 'upsert',
        entryId: null,
        date: '2026-01-01',
        meal: 'dinner',
        portions: 2,
        locked: false,
        slotState: 'outside',
        recipeId: null,
        revisionId: null,
        note: null,
    } as const;
    assert.equal(
        planMutationSchema.safeParse({ ...base, assignments: [{ userId: crypto.randomUUID(), portions: 2 }] }).success,
        true,
    );
    assert.equal(
        planMutationSchema.safeParse({ ...base, assignments: [{ userId: crypto.randomUUID(), portions: 3 }] }).success,
        false,
    );
});

await test('Pro calendar projects the exact selected month', () => {
    const selection = planQuerySchema.parse({
        scope: 'private',
        view: 'calendar',
        date: '2026-02-18',
        timezone: 'Europe/Moscow',
    });
    assert.deepEqual(planRange(selection), { startsOn: '2026-02-01', endsOn: '2026-02-28' });
    const leapSelection = planQuerySchema.parse({ ...selection, date: '2028-02-10' });
    assert.deepEqual(planRange(leapSelection), { startsOn: '2028-02-01', endsOn: '2028-02-29' });
});

await test('weekly automation counts real dates and accepts only explicit skip-existing conflicts', () => {
    assert.equal(weeklyDates('2026-01-01', '2026-12-31', [4]).length, 53);
    assert.equal(weeklyDates('2025-01-01', '2025-12-31', [4]).length, 52);
    const input = {
        version: 1,
        selection: {
            scope: 'private',
            view: 'range',
            date: '2026-01-01',
            endDate: '2026-12-31',
            timezone: 'Europe/Moscow',
        },
        rule: {
            recipeId: crypto.randomUUID(),
            revisionId: crypto.randomUUID(),
            meal: 'dinner',
            weekdays: [4],
            portions: 2,
            conflictPolicy: 'skip-existing',
        },
    };
    assert.equal(planAutomationPreviewSchema.safeParse(input).success, true);
    assert.equal(
        planAutomationPreviewSchema.safeParse({
            ...input,
            rule: { ...input.rule, conflictPolicy: 'replace-existing' },
        }).success,
        false,
    );
});

await test('Pro optimization contract requires distinct candidates and an explicit budget', () => {
    const recipes = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const base = {
        version: 1,
        selection: {
            scope: 'private' as const,
            view: 'range' as const,
            date: '2026-10-01',
            endDate: '2026-10-31',
            timezone: 'Europe/Moscow',
        },
        rule: {
            recipeId: recipes[0]!,
            revisionId: recipes[1]!,
            meal: 'dinner' as const,
            weekdays: [1, 4],
            portions: 2,
            alternatives: [{ recipeId: recipes[2]!, revisionId: recipes[3]! }],
            optimization: {
                priorities: ['expiry', 'nutrition', 'budget'] as const,
                maxBudgetMinor: 150000,
                targetMealSharePercent: 33,
            },
            conflictPolicy: 'skip-existing' as const,
        },
    };
    assert.equal(planAutomationPreviewSchema.safeParse(base).success, true);
    assert.equal(
        planAutomationPreviewSchema.safeParse({
            ...base,
            rule: { ...base.rule, alternatives: [{ recipeId: recipes[0]!, revisionId: recipes[1]! }] },
        }).success,
        false,
    );
    assert.equal(
        planAutomationPreviewSchema.safeParse({
            ...base,
            rule: { ...base.rule, optimization: { ...base.rule.optimization, maxBudgetMinor: null } },
        }).success,
        false,
    );
});

await test('prepared portion contracts require optimistic versions and only agreed decisions', () => {
    assert.equal(
        portionAssignSchema.safeParse({
            scope: 'family',
            batchId: crypto.randomUUID(),
            recipientUserId: crypto.randomUUID(),
            quantity: '1.5',
            expectedBatchVersion: 1,
            idempotencyKey: crypto.randomUUID(),
        }).success,
        true,
    );
    assert.equal(
        portionDecisionSchema.safeParse({
            scope: 'family',
            decision: 'cancelled',
            expectedVersion: 1,
            idempotencyKey: crypto.randomUUID(),
        }).success,
        true,
    );
    assert.equal(
        portionDecisionSchema.safeParse({
            scope: 'family',
            decision: 'restore',
            expectedVersion: 1,
            idempotencyKey: crypto.randomUUID(),
        }).success,
        false,
    );
});

await test('family note contracts separate author content from collaborative checklist decisions', () => {
    assert.equal(
        familyNoteCreateSchema.safeParse({
            kind: 'checklist',
            title: 'Список',
            body: '',
            items: [{ text: 'Пункт' }],
            idempotencyKey: crypto.randomUUID(),
        }).success,
        true,
    );
    assert.equal(
        familyNoteCreateSchema.safeParse({
            kind: 'checklist',
            title: 'Список',
            body: '',
            items: [],
            idempotencyKey: crypto.randomUUID(),
        }).success,
        false,
    );
    assert.equal(
        familyNoteCreateSchema.safeParse({
            kind: 'note',
            title: 'Текст',
            body: 'Описание',
            items: [{ text: 'Инъекция списка' }],
            idempotencyKey: crypto.randomUUID(),
        }).success,
        false,
    );
    assert.equal(
        familyNoteToggleSchema.safeParse({
            expectedNoteVersion: 1,
            expectedItemVersion: 1,
            checked: true,
            idempotencyKey: crypto.randomUUID(),
        }).success,
        true,
    );
});

await test('family chat contracts bind replies, active mentions, versions and bounded drafts', () => {
    const memberId = crypto.randomUUID();
    assert.equal(
        chatMessageCreateSchema.safeParse({
            body: 'Ответ',
            replyToId: crypto.randomUUID(),
            mentionUserIds: [memberId],
            idempotencyKey: crypto.randomUUID(),
        }).success,
        true,
    );
    assert.equal(
        chatMessageUpdateSchema.safeParse({
            body: ' ',
            mentionUserIds: [],
            expectedVersion: 1,
            idempotencyKey: crypto.randomUUID(),
        }).success,
        false,
    );
    assert.equal(
        chatReactionCommandSchema.safeParse({
            reaction: 'arbitrary-emoji',
            active: true,
            idempotencyKey: crypto.randomUUID(),
        }).success,
        false,
    );
    assert.equal(
        chatDraftCommandSchema.safeParse({
            body: 'a'.repeat(4_001),
            expectedVersion: null,
            idempotencyKey: crypto.randomUUID(),
        }).success,
        false,
    );
});

await test('prepared family chat migration binds mentions without applying PostgreSQL state', () => {
    const migration = readFileSync('database/migrations/014_family_chat_mentions.sql', 'utf8');
    const manifest = JSON.parse(readFileSync('database/manifest.json', 'utf8')) as {
        migrations: Array<{ version: number; file: string; sha256: string }>;
    };
    assert.match(migration, /UNIQUE \(message_id, user_id\)/);
    assert.match(migration, /REFERENCES meal\.chat_messages\(id\)/);
    assert.match(migration, /REFERENCES meal\.users\(id\)/);
    assert.deepEqual(
        manifest.migrations.find((item) => item.version === 14),
        {
            version: 14,
            file: '014_family_chat_mentions.sql',
            sha256: 'eef73de3ca5125edb482a71d84d53d16ac0295f64e19e11b3b89c5c12ef8ea4b',
        },
    );
    assert.ok((manifest.migrations.at(-1)?.version ?? 0) >= 24);
});

await test('scheduled account ban keeps a durable family Plus transfer effect', () => {
    const migration = readFileSync('database/migrations/022_scheduled_sanction_effects.sql', 'utf8');
    assert.match(migration, /CREATE TABLE IF NOT EXISTS meal\.scheduled_sanction_effects/);
    assert.match(migration, /REFERENCES meal\.sanctions\(id\) ON DELETE CASCADE/);
    assert.match(migration, /kind IN \('family_plus_transfer'\)/);
    assert.match(migration, /status IN \('scheduled','applied','skipped','failed'\)/);
});
