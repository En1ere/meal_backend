import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { adminDeletionDecisionSchema } from '../src/modules/account-lifecycle/account-lifecycle.contracts.js';

const source = readFileSync(
    new URL('../../src/modules/account-lifecycle/account-lifecycle.service.ts', import.meta.url),
    'utf8',
);
const adminAccessSource = readFileSync(
    new URL('../../src/modules/admin-auth/admin-access.service.ts', import.meta.url),
    'utf8',
);
const grants = readFileSync(new URL('../../database/application-grants.sql', import.meta.url), 'utf8');
const migration = readFileSync(
    new URL('../../database/migrations/027_account_deletion_guards.sql', import.meta.url),
    'utf8',
);

void test('account deletion revokes every authentication and staff access surface', () => {
    for (const table of [
        'password_credentials',
        'sessions',
        'account_tokens',
        'account_email_changes',
        'account_devices',
        'mfa_recovery_codes',
        'mfa_factors',
        'user_critical_grants',
        'staff_role_assignments',
        'staff_grants',
    ])
        assert.match(source, new RegExp(`update meal\\.${table} `));
    assert.match(grants, /UPDATE \(password_hash,changed_at,version\) ON meal\.password_credentials/);
});

void test('account deletion is gated by a linked ready export and persists blocked attempts', () => {
    assert.match(source, /e\.kind='personal_data' and e\.format='json'/);
    assert.match(source, /e\.status='ready' and e\.file_id is not null and e\.expires_at>now\(\)/);
    assert.match(source, /account\.deletion\.blocked/);
    assert.match(source, /\['requested', 'retention_wait', 'ready', 'blocked'\]\.includes\(existing\.status\)/);
    assert.match(source, /export_id=\$\{exportJob\.rows\[0\]\?\.id \?\? null\}::uuid/);
    assert.match(migration, /status IN\('active','archived','blocked','pending','deleted'\)/);
});

void test('admin deletion review has actor-bound transactional idempotency', () => {
    assert.match(source, /const namespace = `admin:\$\{actor\.id\}`/);
    assert.match(source, /const operation = 'admin\.account-deletion\.review'/);
    assert.match(source, /pg_advisory_xact_lock\(hashtextextended/);
    assert.match(source, /\.selectFrom\('idempotency_records'\)/);
    assert.match(source, /return deletionRequestSchema\.parse\(replay\.response_snapshot\)/);
    assert.match(source, /\.insertInto\('idempotency_records'\)/);
    assert.match(source, /const updated = await this\.deletionById\(id, tx, true\)/);
    assert.doesNotMatch(source, /const updated = await this\.current\(row\.user_id, tx, true\)/);
    const roleCheck = source.indexOf('await this.adminAccess.assertAdminRole(tx, actor)');
    const replayRead = source.indexOf(".selectFrom('idempotency_records')", roleCheck);
    assert.ok(roleCheck >= 0 && replayRead > roleCheck, 'admin role must be revalidated before replay');
    assert.match(adminAccessSource, /where\('role', '=', 'admin'\)/);
    assert.match(adminAccessSource, /if \(!role\) throw new ForbiddenException\(\)/);
});

void test('admin deletion review requires a strict UUID idempotency key', () => {
    const decision = {
        decision: 'approve',
        expectedVersion: 1,
        reason: 'Administrative approval reason',
    } as const;
    assert.equal(adminDeletionDecisionSchema.safeParse(decision).success, false);
    assert.equal(adminDeletionDecisionSchema.safeParse({ ...decision, idempotencyKey: 'not-a-uuid' }).success, false);
    assert.equal(
        adminDeletionDecisionSchema.safeParse({
            ...decision,
            idempotencyKey: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
        }).success,
        true,
    );
});
