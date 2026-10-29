import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizePublicReviewReason } from '../src/modules/recipe-lifecycle/recipe-lifecycle.service.js';
import { workspaceRecipeSchema } from '../src/modules/recipe-workspace/recipe-workspace.contracts.js';
import { contentResultSchema } from '../src/modules/admin-content/admin-content.contracts.js';

void test('author review reason is bounded and strips control characters', () => {
    assert.equal(sanitizePublicReviewReason('  Исправьте\n\tописание\u0000 ', 'rejected'), 'Исправьте описание');
    assert.equal(sanitizePublicReviewReason(null, 'rejected'), 'Рецепт требует исправлений перед повторной отправкой.');
    assert.equal(sanitizePublicReviewReason('[internal] operational note', 'pending'), '[internal] operational note');
});

void test('workspace recipe exposes only additive review and publication lifecycle fields', () => {
    const base = {
        id: '70000000-0000-4000-8000-000000000001',
        status: 'rejected',
        archived: false,
        version: 2,
        revisionId: '71000000-0000-4000-8000-000000000001',
        revision: 2,
        baseRecipeId: null,
        availabilityScope: 'private',
        authorLogin: 'author',
        canEdit: true,
        document: {},
        nutrition: { status: 'unavailable', base: null, uncoveredIngredientIds: [] },
        review: {
            revisionId: '71000000-0000-4000-8000-000000000001',
            status: 'rejected',
            publicReason: 'Исправьте описание',
        },
        publication: null,
    };
    assert.equal(workspaceRecipeSchema.safeParse(base).success, true);
    const parsed = workspaceRecipeSchema.parse({ ...base, internalNote: 'staff only' });
    assert.equal('internalNote' in parsed, false);
    assert.equal(
        workspaceRecipeSchema.safeParse({
            ...base,
            review: { ...base.review, internalReason: 'staff only' },
        }).success,
        false,
    );
});

void test('admin content exposes independent review and publication axes for every recipe lifecycle state', () => {
    const publishedRevision = {
        id: '72000000-0000-4000-8000-000000000001',
        version: 1,
        fields: { title: 'r1' },
    };
    const reviewedRevision = {
        id: '72000000-0000-4000-8000-000000000002',
        version: 2,
        fields: { title: 'r2' },
    };
    const base = {
        section: 'queues',
        id: '73000000-0000-4000-8000-000000000001',
        version: 2,
        current: publishedRevision,
        pending: null,
        review: {
            revisionId: reviewedRevision.id,
            status: 'rejected',
            publicReason: 'Исправьте описание',
            revision: reviewedRevision,
        },
        publication: {
            revisionId: publishedRevision.id,
            publishedAt: '2026-10-28T00:00:00.000Z',
            revision: publishedRevision,
        },
        status: 'rejected',
        history: [],
        cards: [],
        comparison: null,
        message: '',
    };
    assert.equal(contentResultSchema.safeParse(base).success, true);
    for (const status of ['hidden', 'unpublished'])
        assert.equal(
            contentResultSchema.safeParse({
                ...base,
                status,
                current: null,
                review: { ...base.review, status, publicReason: 'Публикация закрыта' },
                publication: null,
            }).success,
            true,
        );
    assert.equal(
        contentResultSchema.safeParse({
            ...base,
            status: 'published',
            review: {
                ...base.review,
                revisionId: publishedRevision.id,
                status: 'published',
                publicReason: null,
                revision: publishedRevision,
            },
        }).success,
        true,
    );
    assert.equal(
        contentResultSchema.safeParse({
            ...base,
            status: 'pending',
            current: null,
            pending: reviewedRevision,
            review: { ...base.review, status: 'pending', publicReason: null },
            publication: null,
        }).success,
        true,
    );
    assert.equal(
        contentResultSchema.safeParse({
            ...base,
            review: { ...base.review, internalNote: 'staff only' },
        }).success,
        false,
    );
});
