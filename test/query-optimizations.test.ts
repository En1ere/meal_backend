import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const shopping = readFileSync(new URL('../../src/modules/shopping/shopping.service.ts', import.meta.url), 'utf8');
const notes = readFileSync(new URL('../../src/modules/family-notes/family-notes.service.ts', import.meta.url), 'utf8');
const moderator = readFileSync(new URL('../../src/modules/moderator/moderator.service.ts', import.meta.url), 'utf8');
const migration = readFileSync(
    new URL('../../database/migrations/028_query_optimization_indexes.sql', import.meta.url),
    'utf8',
);

void test('shopping list summaries are loaded by one bounded aggregate query', () => {
    assert.match(shopping, /with page as \(/);
    assert.match(shopping, /count\(i\.id\) filter\(where i\.status<>'removed'\)/);
    assert.doesNotMatch(shopping, /for \(const r of rows\.rows\.slice/);
});

void test('family-note filters run before the batched item lookup', () => {
    assert.match(notes, /n\.archived_at is not null/);
    assert.match(notes, /n\.archived_at is null/);
    assert.match(notes, /item\.note_id=any\(\$\{ids\}::uuid\[\]\)/);
    assert.match(notes, /new Map<string, typeof items\.rows>/);
    assert.doesNotMatch(notes, /items\.rows\s*\.filter/);
});

void test('moderator queues filter and page in SQL without a pre-filter 500-row cap', () => {
    assert.match(moderator, /where \$\{sql\.join\(conditions, sql` and `\)\}/);
    assert.match(moderator, /limit \$\{page\.limit\} offset \$\{page\.offset\}/);
    assert.match(moderator, /group by kind/);
    assert.doesNotMatch(moderator, /limit 500`\.execute/);
});

void test('query-optimization indexes are additive and avoid unproven trigram dependencies', () => {
    for (const index of [
        'ix_family_notes_active_list',
        'ix_family_notes_archived_list',
        'ix_moderation_cases_queue_order',
        'ix_moderation_cases_sla',
        'ix_support_tickets_moderator_queue',
    ])
        assert.match(migration, new RegExp(`CREATE INDEX ${index}`));
    assert.doesNotMatch(migration, /pg_trgm|gin_trgm_ops/i);
});
