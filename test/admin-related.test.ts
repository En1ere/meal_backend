import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { Kysely, DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { adminRelatedSources, relatedCollections } from '../src/modules/admin/admin-related.sources.js';
import { adminRelatedSearchSchema, adminSearchSchema } from '../src/modules/admin/admin-read.contracts.js';
import { cursorBinding, decodeAdminCursor } from '../src/modules/admin/admin-read.service.js';
import type { Principal } from '../src/modules/auth/auth.service.js';

await test('curated related projections use real columns without secret or JSON payload fields', () => {
    const ddl = readFileSync(new URL('../../database/migrations/001_initial.sql', import.meta.url), 'utf8');
    const authDdl = readFileSync(new URL('../../database/migrations/002_auth_context.sql', import.meta.url), 'utf8');
    const forbidden =
        /token|secret|password|payload|snapshot|provider_ref|external_id|evidence|error_redacted|draft|provenance|idempotency|result$/;
    let count = 0;
    for (const [section, collections] of Object.entries(adminRelatedSources)) {
        assert.equal(
            relatedCollections(section as keyof typeof adminRelatedSources).length,
            Object.keys(collections).length,
        );
        for (const [key, source] of Object.entries(collections)) {
            count++;
            const block = new RegExp(`CREATE TABLE meal\\.\\"?${source.table}\\"? \\(([\\s\\S]*?)\\n\\);`).exec(
                ddl,
            )?.[1];
            assert.ok(block, `${section}/${key}`);
            for (const column of [
                'id',
                'version',
                'created_at',
                source.title,
                ...(source.status ? [source.status] : []),
                ...source.fields.map(([field]) => field),
            ]) {
                assert.ok(
                    new RegExp(`(?:^|[\\s,])\\"?${column}\\"?\\s`).test(block) ||
                        new RegExp(`ALTER TABLE meal\\.${source.table} ADD COLUMN ${column} `).test(authDdl),
                    `${section}/${key}.${column}`,
                );
                assert.doesNotMatch(column, forbidden);
            }
        }
    }
    assert.equal(count, 34);
});
await test('related predicates bind UUID values as parameters without SQL interpolation', async () => {
    const db = new Kysely<Record<string, never>>({
        dialect: {
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => new DummyDriver(),
            createIntrospector: (value) => new PostgresIntrospector(value),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    const id = randomUUID();
    try {
        for (const sources of Object.values(adminRelatedSources))
            for (const source of Object.values(sources)) {
                const compiled = source.predicate(id).compile(db);
                assert.ok(compiled.parameters.length > 0);
                assert.equal(
                    compiled.parameters.every((parameter) => parameter === id),
                    true,
                );
                assert.equal(compiled.sql.includes(id), false);
            }
    } finally {
        await db.destroy();
    }
});
await test('related cursor and recipe queue contexts reject collection/session/filter changes', () => {
    const id = randomUUID(),
        actor: Principal = {
            id: randomUUID(),
            sessionId: randomUUID(),
            context: 'admin',
            displayName: 'Admin',
            expiresAt: '2030-01-01T00:00:00Z',
        };
    const binding = (collection: string, session = actor.sessionId) =>
        createHash('sha256')
            .update(JSON.stringify(['payments', id, collection, 25, actor.id, session]))
            .digest('hex');
    const cursor = Buffer.from(JSON.stringify({ id: randomUUID(), binding: binding('attempts') })).toString(
        'base64url',
    );
    assert.ok(decodeAdminCursor(cursor, binding('attempts')));
    assert.throws(() => decodeAdminCursor(cursor, binding('refunds')));
    assert.throws(() => decodeAdminCursor(cursor, binding('attempts', randomUUID())));
    assert.notEqual(cursorBinding('queues', {}, actor), cursorBinding('queues', { queue: 'recipes' }, actor));
    assert.equal(adminRelatedSearchSchema.safeParse({ limit: 51 }).success, false);
    assert.equal(adminRelatedSearchSchema.safeParse({ table: 'users' }).success, false);
    assert.equal(adminSearchSchema.safeParse({ queue: 'unknown' }).success, false);
});
