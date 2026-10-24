import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
    new URL('../../src/modules/account-lifecycle/account-lifecycle.service.ts', import.meta.url),
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
    assert.match(source, /export_id=\$\{exportJob\.rows\[0\]\?\.id \?\? null\}::uuid/);
    assert.match(migration, /status IN\('active','archived','blocked','pending','deleted'\)/);
});
