import { workspaceNutrition } from '../src/modules/recipe-workspace/recipe-workspace.domain.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
    Kysely,
    DummyDriver,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type CompiledQuery,
    type QueryResult,
} from 'kysely';
import type { DatabaseSchema } from '../src/infrastructure/database/schema.generated.js';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import type { RecipePolicyService } from '../src/modules/recipe-policy/recipe-policy.service.js';
import type { EntitlementsService } from '../src/modules/entitlements/entitlements.service.js';
import { RecipeWorkspaceService } from '../src/modules/recipe-workspace/recipe-workspace.service.js';
import {
    workspaceDocumentSchema,
    workspaceRatingSchema,
    workspaceSaveSchema,
    assertSubmittable,
    workspaceReportSchema,
} from '../src/modules/recipe-workspace/recipe-workspace.contracts.js';
const user = '10000000-0000-4000-8000-000000000001',
    id = '70000000-0000-4000-8000-000000000001',
    revision = '71000000-0000-4000-8000-000000000001',
    key = '90000000-0000-4000-8000-000000000001';
function harness(
    options: {
        banned?: boolean;
        missing?: boolean;
        cooked?: boolean;
        rated?: boolean;
        version?: number;
        prior?: { input: object; result: object };
        pending?: boolean;
        noScope?: boolean;
        hierarchy?: boolean;
        family?: boolean;
        authorId?: string;
    } = {},
) {
    const queries: CompiledQuery[] = [];
    const allowances: string[] = [];
    const consentFeatures: string[] = [];
    class Driver extends DummyDriver {
        override acquireConnection() {
            return Promise.resolve({
                async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
                    queries.push(query);
                    await Promise.resolve();
                    let rows: unknown[] = [];
                    const s = query.sql;
                    if (s.includes('from meal.users')) rows = [{ id: user }];
                    else if (s.includes('from meal.sanctions')) rows = options.banned ? [{ id }] : [];
                    else if (s.includes('from "idempotency_records"') && options.prior)
                        rows = [
                            {
                                request_hash: createHash('sha256')
                                    .update(JSON.stringify(options.prior.input))
                                    .digest('hex'),
                                response_snapshot: options.prior.result,
                            },
                        ];
                    else if (s.includes('from meal.recipes r'))
                        rows = options.missing
                            ? []
                            : [
                                  {
                                      id,
                                      status: 'draft',
                                      archived_at: null,
                                      version: options.version ?? 1,
                                      base_recipe_id: null,
                                      scope_id: user,
                                      scope_kind: options.family ? 'family' : 'private',
                                      family_id: options.family ? id : null,
                                      author_login: 'user',
                                      author_id: options.authorId ?? user,
                                      viewer_id: user,
                                      revision_id: revision,
                                  },
                              ];
                    else if (s.includes('from meal.family_memberships fm join meal.families'))
                        rows = options.family ? [{ id: user, familyId: id }] : [];
                    else if (s.includes('from meal.recipe_revisions where recipe_id'))
                        rows = [
                            {
                                id: revision,
                                revision: 1,
                                title: 'Soup',
                                portions: 2,
                                method: 'boil',
                                description: null,
                                category: null,
                                tags: [],
                            },
                        ];
                    else if (s.includes('from meal.recipe_ingredients'))
                        rows = [
                            {
                                ingredientId: user,
                                variantId: options.hierarchy ? revision : null,
                                productId: options.hierarchy ? key : null,
                                sourceRecipeId: null,
                                quantity: '1',
                                unit: 'g',
                                optional: false,
                            },
                        ];
                    else if (s.includes('from meal.recipe_steps'))
                        rows = [{ text: 'Cook', durationSeconds: null, temperature: null }];
                    else if (s.includes('from meal.cooking_attempts')) rows = options.cooked ? [{ id: key }] : [];
                    else if (s.includes('from meal.recipe_ratings'))
                        rows = options.rated ? [{ id: key, value: 5 }] : [];
                    else if (s.includes('from meal.moderation_cases')) rows = options.pending ? [{ id }] : [];
                    else if (s.includes('from meal.data_scopes') && options.noScope) rows = [];
                    else if (
                        s.includes('from meal.units') ||
                        s.includes('from meal.brand_products p') ||
                        s.includes('from meal.ingredients i') ||
                        s.includes('from meal.data_scopes')
                    )
                        rows = [{ id: user }];
                    return { rows: rows as R[] };
                },
                async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
                    await Promise.resolve();
                    throw Error('unused');
                },
            });
        }
    }
    const db = new Kysely<DatabaseSchema>({
        dialect: {
            createDriver: () => new Driver(),
            createAdapter: () => new PostgresAdapter(),
            createIntrospector: (db) => new PostgresIntrospector(db),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    const database = {
        db,
        ready: () => Promise.resolve(true),
        transaction: <T>(run: (tx: unknown) => Promise<T>) => db.transaction().execute(run),
    } as unknown as DatabaseService;
    const policy = {
        assertAllowance: async (_tx: unknown, _user: string, kind: string) => {
            allowances.push(kind);
            await Promise.resolve();
        },
    } as unknown as RecipePolicyService;
    const entitlements = {
        resolveFamily: () => Promise.resolve({ capabilities: { family: true } }),
    } as unknown as EntitlementsService;
    const legalConsents = {
        assertFeatureAccess: (_userId: string, _kind: string, feature: string) => {
            consentFeatures.push(feature);
            return Promise.resolve();
        },
    } as never;
    return {
        service: new RecipeWorkspaceService(database, policy, entitlements, legalConsents),
        db,
        queries,
        allowances,
        consentFeatures,
    };
}
const status = (expected: number) => (error: unknown) =>
    error instanceof HttpException && error.getStatus() === expected;
void test('incomplete drafts valid; publish completeness and explicit immutable rating confirmation enforced', () => {
    const draft = workspaceDocumentSchema.parse({});
    assert.equal(draft.title, '');
    assert.throws(() => assertSubmittable(draft));
    assert.equal(workspaceRatingSchema.safeParse({ idempotencyKey: key, attemptId: key, value: 5 }).success, false);
    assert.equal(
        workspaceDocumentSchema.safeParse({ ingredients: [{ ingredientId: user, productId: id }] }).success,
        false,
    );
    assert.equal(workspaceDocumentSchema.safeParse({ baseServings: 0 }).success, false);
    assert.equal(workspaceReportSchema.safeParse({ idempotencyKey: key, reason: 'anything' }).success, false);
});
void test('ownership failure and optimistic version conflict write nothing', async () => {
    for (const options of [{ missing: true }, { version: 2 }]) {
        const h = harness(options);
        try {
            await assert.rejects(
                h.service.save(
                    user,
                    id,
                    workspaceSaveSchema.parse({ expectedVersion: 1, idempotencyKey: key, document: {} }),
                ),
                status(options.missing ? 404 : 409),
            );
            assert.equal(
                h.queries.some((q) => q.sql.startsWith('insert') || q.sql.startsWith('update')),
                false,
            );
        } finally {
            await h.db.destroy();
        }
    }
});
void test('save creates immutable revision and child rows instead of changing published snapshots', async () => {
    const h = harness();
    try {
        await h.service.save(
            user,
            id,
            workspaceSaveSchema.parse({
                expectedVersion: 1,
                idempotencyKey: key,
                document: {
                    title: 'Changed',
                    ingredients: [{ ingredientId: user, quantity: '1', unit: 'g' }],
                    steps: [{ text: 'Mix' }],
                },
            }),
        );
        assert.ok(h.queries.some((q) => q.sql.startsWith('insert into meal.recipe_revisions')));
        assert.equal(
            h.queries.some((q) => q.sql.startsWith('update meal.recipe_revisions')),
            false,
        );
        assert.equal(
            h.queries.some((q) => q.sql.includes('recipe_publications')),
            false,
        );
    } finally {
        await h.db.destroy();
    }
});
void test('submission consumes one policy allowance and queues exact immutable revision', async () => {
    const h = harness();
    try {
        await h.service.command(user, id, 'submit', { expectedVersion: 1, idempotencyKey: key });
        assert.deepEqual(h.consentFeatures, ['recipe.publication']);
        assert.deepEqual(h.allowances, ['submission']);
        const insert = h.queries.find((q) => q.sql.startsWith('insert into meal.moderation_cases'));
        assert.ok(insert?.parameters.includes(revision));
        assert.equal(
            h.queries.some((q) => q.sql.startsWith('insert into meal.recipe_publications')),
            false,
        );
    } finally {
        await h.db.destroy();
    }
});
void test('pending revision is not resubmitted or charged another allowance', async () => {
    const h = harness({ pending: true });
    try {
        await assert.rejects(
            h.service.command(user, id, 'submit', { expectedVersion: 1, idempotencyKey: key }),
            status(409),
        );
        assert.deepEqual(h.allowances, []);
    } finally {
        await h.db.destroy();
    }
});
void test('idempotent replay skips allowance and all writes but account ban still wins', async () => {
    const input = { expectedVersion: 1, idempotencyKey: key };
    for (const banned of [false, true]) {
        const h = harness({ banned, prior: { input, result: { recipe: { id } } } });
        try {
            if (banned) await assert.rejects(h.service.command(user, id, 'submit', input), status(403));
            else assert.deepEqual(await h.service.command(user, id, 'submit', input), { recipe: { id } });
            assert.deepEqual(h.allowances, []);
            assert.equal(
                h.queries.some((q) => q.sql.startsWith('insert')),
                false,
            );
        } finally {
            await h.db.destroy();
        }
    }
});
void test('rating requires confirmed cooking owned by actor and rejects second fixed vote', async () => {
    for (const options of [{}, { cooked: true, rated: true }, { cooked: true }]) {
        const h = harness(options);
        try {
            const action = h.service.rating(user, id, {
                idempotencyKey: key,
                attemptId: key,
                value: 4,
                confirmed: true,
            });
            if (!options.cooked) await assert.rejects(action, status(403));
            else if (options.rated) await assert.rejects(action, status(409));
            else {
                await action;
                assert.ok(h.queries.some((q) => q.sql.startsWith('insert into meal.recipe_ratings')));
            }
            assert.deepEqual(h.consentFeatures, ['recipe.rating']);
            const evidence = h.queries.find((q) => q.sql.includes('from meal.cooking_attempts'));
            assert.match(evidence!.sql, /a.actor_id=.*r.recipe_id=.*a.status='completed'/);
        } finally {
            await h.db.destroy();
        }
    }
});
void test('critical report consumes report allowance, hides content and does not expose reporter publicly', async () => {
    const h = harness();
    try {
        await h.service.report(user, id, {
            idempotencyKey: key,
            reason: 'personal-data',
            comment: null,
            commentId: null,
        });
        assert.deepEqual(h.allowances, ['report']);
        assert.ok(h.queries.some((q) => q.sql.includes("set status='hidden'")));
    } finally {
        await h.db.destroy();
    }
});
void test('comments require completed cooking before consuming allowance', async () => {
    const h = harness();
    try {
        await assert.rejects(
            h.service.comment(user, id, { idempotencyKey: key, attemptId: key, body: 'Hello', replyToId: null }),
            status(403),
        );
        assert.deepEqual(h.consentFeatures, ['recipe.comment']);
        assert.deepEqual(h.allowances, []);
    } finally {
        await h.db.destroy();
    }
});

void test('nutrition recalculates exact compatible quantities and never presents partial totals as complete', () => {
    const document = workspaceDocumentSchema.parse({
        ingredients: [{ ingredientId: user, quantity: '0.5', unit: 'kg' }],
    });
    const composition = { kcal: '100', protein: '10', fat: '2', carbs: '5', quantity: '100', unit: 'g' };
    assert.deepEqual(workspaceNutrition(document, [composition], null), {
        status: 'calculated',
        base: { kcal: '500', protein: '50', fat: '10', carbs: '25', basis: 'recipe' },
        uncoveredIngredientIds: [],
    });
    const fallback = workspaceNutrition(document, [null], {
        kcal: '400',
        protein: '30',
        fat: '20',
        carbs: '50',
        basis: 'recipe',
    });
    assert.equal(fallback.status, 'base-unadjusted');
    assert.deepEqual(fallback.uncoveredIngredientIds, [user]);
    assert.equal(workspaceNutrition(document, [{ ...composition, unit: 'ml' }], null).status, 'unavailable');
});
void test('archive ends active publications; restore does not silently republish', async () => {
    for (const action of ['archive', 'restore'] as const) {
        const h = harness();
        try {
            await h.service.command(user, id, action, { expectedVersion: 1, idempotencyKey: key });
            assert.equal(
                h.queries.some((q) => q.sql.startsWith('update meal.recipe_publications')),
                action === 'archive',
            );
            assert.equal(
                h.queries.some((q) => q.sql.startsWith('insert into meal.recipe_publications')),
                false,
            );
        } finally {
            await h.db.destroy();
        }
    }
});

void test('fresh accounts lazily receive private scope inside actor transaction', async () => {
    const h = harness({ noScope: true });
    try {
        await h.service.create(user, {
            idempotencyKey: key,
            scope: 'private',
            document: workspaceDocumentSchema.parse({}),
        });
        const actor = h.queries.findIndex((q) => q.sql.includes('from meal.users')),
            scope = h.queries.findIndex((q) => q.sql.startsWith('insert into meal.data_scopes')),
            recipe = h.queries.findIndex((q) => q.sql.startsWith('insert into meal.recipes'));
        assert.ok(actor >= 0 && scope > actor && recipe > scope);
    } finally {
        await h.db.destroy();
    }
});
void test('family workspace lists shared recipes while authorship alone grants editing', async () => {
    const author = '10000000-0000-4000-8000-000000000006';
    const h = harness({ family: true, authorId: author });
    try {
        const list = await h.service.list(user, { q: '', scope: 'family', status: 'active', page: 1, limit: 20 });
        assert.equal(list.items[0]?.availabilityScope, 'family');
        assert.equal(list.items[0]?.canEdit, false);
        const detail = await h.service.detail(user, id, { scope: 'family' });
        assert.equal(detail.recipe.authorLogin, 'user');
        assert.equal(detail.recipe.canEdit, false);
        assert.ok(
            h.queries.some(
                (query) => query.sql.includes('fm.left_at is null') && query.sql.includes("f.status='active'"),
            ),
        );
    } finally {
        await h.db.destroy();
    }
});
void test('variant source access constrains unpublished ownership to personal scope', async () => {
    const h = harness();
    try {
        await h.service.variant(user, id, { idempotencyKey: key });
        const query = h.queries.find((q) => q.sql.includes('join lateral(select x.id'))!;
        assert.match(query.sql, /s.kind='private' and s.user_id=/);
        assert.match(query.sql, /p.published_at<=now\(\)/);
        assert.match(query.sql, /r.status not in \('hidden','deleted','unpublished'\)/);
    } finally {
        await h.db.destroy();
    }
});

void test('published hierarchy is normalized to SKU before variant serialization', async () => {
    const h = harness({ hierarchy: true });
    try {
        const detail = await h.service.detail(user, id, { scope: 'private' });
        assert.equal(detail.recipe.document.ingredients[0]?.productId, key);
        assert.equal(detail.recipe.document.ingredients[0]?.ingredientId, null);
        assert.equal(detail.recipe.document.ingredients[0]?.variantId, null);
        const variant = await h.service.variant(user, id, { idempotencyKey: key });
        assert.equal(variant.recipe.document.ingredients[0]?.productId, key);
        const insert = h.queries.find((q) => q.sql.startsWith('insert into meal.recipe_ingredients'))!;
        assert.ok(insert.parameters.includes(key));
        assert.equal(insert.parameters.includes(revision), false);
    } finally {
        await h.db.destroy();
    }
});
