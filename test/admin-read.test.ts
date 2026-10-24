import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminSearchSchema, adminSectionSchema } from '../src/modules/admin/admin-read.contracts.js';
import { cursorBinding, decodeAdminCursor, projectAdminRecord } from '../src/modules/admin/admin-read.service.js';
import type { Principal } from '../src/modules/auth/auth.service.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { adminSources } from '../src/modules/admin/admin-read.sources.js';

const actor: Principal = {
    id: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    displayName: 'Admin',
    context: 'admin',
    expiresAt: '2030-01-01T00:00:00.000Z',
};
await test('admin read inputs are bounded and reject arbitrary table names', () => {
    assert.equal(adminSectionSchema.options.length, 17);
    assert.equal(adminSectionSchema.safeParse('password_credentials').success, false);
    assert.equal(adminSearchSchema.safeParse({ limit: 51 }).success, false);
    assert.equal(adminSearchSchema.safeParse({ table: 'users' }).success, false);
});
await test('admin cursor binds filters, actor, session and section', () => {
    const binding = cursorBinding('users', { query: 'user1' }, actor);
    const cursor = Buffer.from(JSON.stringify({ id: actor.id, binding })).toString('base64url');
    assert.equal(decodeAdminCursor(cursor, binding), actor.id);
    assert.throws(() => decodeAdminCursor(cursor, cursorBinding('users', { query: 'user2' }, actor)));
    assert.throws(() => decodeAdminCursor(cursor, cursorBinding('access', { query: 'user1' }, actor)));
    assert.throws(() =>
        decodeAdminCursor(cursor, cursorBinding('users', { query: 'user1' }, { ...actor, sessionId: actor.id })),
    );
    assert.throws(() => decodeAdminCursor('broken', binding));
});
await test('safe projection never leaks account secrets or invents update time', () => {
    const item = projectAdminRecord('users', {
        id: actor.id,
        login: 'admin',
        display_name: 'Admin',
        status: 'active',
        version: '1',
        created_at: new Date('2026-01-01T00:00:00Z'),
        email_verified_at: null,
        password_hash: 'SECRET',
        email_normalized: 'private@example.test',
    });
    assert.equal(item.updatedAt, null);
    assert.equal(JSON.stringify(item).includes('SECRET'), false);
    assert.equal(JSON.stringify(item).includes('private@example.test'), false);
    assert.equal(item.fields.find((field) => field.key === 'email_verified_at')?.value, null);
    assert.equal(item.actions[0]?.enabled, false);
});
await test('future sanctions are scheduled, revoked overrides dates', () => {
    const row = {
        id: actor.id,
        scope: 'publication',
        starts_at: '2999-01-01T00:00:00Z',
        ends_at: null,
        revoked_at: null,
        reason: 'Reason',
        user_id: actor.id,
    };
    assert.equal(projectAdminRecord('sanctions', row).status, 'scheduled');
    assert.equal(projectAdminRecord('sanctions', { ...row, revoked_at: '2026-01-01T00:00:00Z' }).status, 'revoked');
});
await test('admin projection identifiers exist in prepared SQL, without querying a database', () => {
    const root = new URL('../../database/', import.meta.url);
    const ddl = ['001_initial.sql', '004_admin_observability.sql']
        .map((file) => readFileSync(new URL(`migrations/${file}`, root), 'utf8'))
        .join('\n');
    for (const [section, source] of Object.entries(adminSources)) {
        const block = new RegExp(`CREATE TABLE meal\\.\\"?${source.table}\\"? \\(([\\s\\S]*?)\\n\\);`).exec(ddl)?.[1];
        assert.ok(block, `${section}: source table exists`);
        for (const column of [
            'id',
            'version',
            source.title,
            ...(source.status ? [source.status] : []),
            ...source.fields.map(([key]) => key),
            ...(source.related ?? []).map(([key]) => key),
        ]) {
            assert.match(block, new RegExp(`(?:^|[\\s,])\\"?${column}\\"?\\s`), `${section}.${column}`);
        }
    }
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8')) as {
        migrations: { file: string; sha256: string }[];
    };
    for (const migration of manifest.migrations)
        assert.equal(
            createHash('sha256')
                .update(readFileSync(new URL(`migrations/${migration.file}`, root)))
                .digest('hex'),
            migration.sha256,
        );
});
