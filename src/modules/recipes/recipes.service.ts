import { Injectable, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import {
    recipeSummarySchema,
    recipeDetailSchema,
    recipeIngredientSchema,
    recipeNutritionSchema,
    recipeBookmarkSchema,
    type RecipeSummary,
    type RecipeIngredient,
    type RecipesQuery,
} from './recipes.contracts.js';
import { recipeAvailability, publicRecipeImage, type RecipeStock } from './recipes.domain.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { RecommendationsService } from '../recommendations/recommendations.service.js';
import { AllergenIntelligenceService } from '../allergen-intelligence/allergen-intelligence.service.js';
type Tx = Transaction<DatabaseSchema>;
const published = sql`with published as (select distinct on(r.id) r.id,r.author_id,r.base_recipe_id,rr.id as revision_id,rr.title,rr.portions,rr.method,rr.description,rr.category,rr.image_url,rr.tags,rr.nutrition_snapshot,rr.timing,p.published_at from meal.recipes r join meal.recipe_revisions rr on rr.recipe_id=r.id join meal.recipe_publications p on p.revision_id=rr.id where p.unpublished_at is null and p.published_at<=now() and r.archived_at is null and r.status not in ('hidden','unpublished','deleted','archived') order by r.id,p.published_at desc,p.id desc)`;
const summarySql = sql`p.id,p.revision_id as "revisionId",p.title,p.description,p.category,p.image_url as "imageUrl",p.tags,p.portions as "baseServings",p.published_at as "publishedAt",p.timing,(select u.login from meal.users u where u.id=p.author_id and u.status='active' and u.archived_at is null and u.email_verified_at is not null) as "authorLogin",(select avg(r.value)::float8 from meal.recipe_ratings r where r.recipe_id=p.id) as rating,(select count(*)::integer from meal.recipe_ratings r where r.recipe_id=p.id) as "ratingCount"`;
const stockMatch = sql`(b.quantity is null or b.quantity>0) and ((ri.product_id is not null and b.product_id=ri.product_id) or (ri.product_id is null and ri.variant_id is not null and coalesce(b.variant_id,bp.variant_id)=ri.variant_id) or (ri.product_id is null and ri.variant_id is null and ri.ingredient_id is not null and coalesce(b.ingredient_id,bv.ingredient_id,pv.ingredient_id)=ri.ingredient_id) or (ri.product_id is null and ri.variant_id is null and ri.ingredient_id is null and ri.source_recipe_id is not null and (exists(select 1 from meal.cooking_outputs co join meal.cooking_attempts ca on ca.id=co.attempt_id join meal.recipe_revisions cr on cr.id=ca.revision_id where co.batch_id=b.id and cr.recipe_id=ri.source_recipe_id) or exists(select 1 from meal.preserve_details pd join meal.recipe_revisions pr on pr.id=pd.recipe_revision_id where pd.batch_id=b.id and pr.recipe_id=ri.source_recipe_id))))`;
function card(row: Record<string, unknown>): RecipeSummary {
    const timing = z
        .object({ durationMinutes: z.number().int().nonnegative().nullable().optional() })
        .safeParse(row.timing);
    return recipeSummarySchema.parse({
        ...row,
        publishedAt: row.publishedAt instanceof Date ? row.publishedAt.toISOString() : row.publishedAt,
        imageUrl: publicRecipeImage(row.imageUrl),
        tags: Array.isArray(row.tags) ? row.tags : [],
        durationMinutes: timing.success ? (timing.data.durationMinutes ?? null) : null,
        availability: null,
    });
}
@Injectable()
export class RecipesService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements?: EntitlementsService,
        private readonly recommendations?: RecommendationsService,
        private readonly allergenIntelligence?: AllergenIntelligenceService,
    ) {}
    private async run<T>(userId: string | undefined, write: boolean, work: (tx: Tx) => Promise<T>): Promise<T> {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.transaction(async (tx) => {
            if (userId) {
                const user = await tx
                    .selectFrom('users')
                    .select('id')
                    .where('id', '=', userId)
                    .where('status', '=', 'active')
                    .where('archived_at', 'is', null)
                    .forUpdate()
                    .executeTakeFirst();
                if (!user) throw new HttpException('Аккаунт недоступен', 403);
            }
            if (write) {
                const ban =
                    await sql`select id from meal.sanctions where user_id=${userId}::uuid and scope='account' and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                        tx,
                    );
                if (ban.rows.length) throw new HttpException('Доступен только просмотр', 403);
            }
            return work(tx);
        });
    }
    private async publicRow(tx: Tx, id: string) {
        const result = await sql<
            Record<string, unknown>
        >`${published} select ${summarySql},p.method,p.nutrition_snapshot from published p where p.id=${id}::uuid`.execute(
            tx,
        );
        if (!result.rows[0]) throw new HttpException('Рецепт не опубликован', 404);
        return result.rows[0];
    }
    private async ingredients(tx: Tx, revisions: string[]): Promise<Array<RecipeIngredient & { revisionId: string }>> {
        if (!revisions.length) return [];
        const rows = await sql<
            Record<string, unknown>
        >`select ri.id,ri.revision_id as "revisionId",ri.position,coalesce(bp.name,v.name,i.name,public_source.title,'Ингредиент') as name,ri.ingredient_id as "ingredientId",ri.variant_id as "variantId",ri.product_id as "productId",ri.source_recipe_id as "sourceRecipeId",ri.quantity::text,u.code as unit,ri.optional from meal.recipe_ingredients ri left join meal.ingredients i on i.id=ri.ingredient_id left join meal.ingredient_variants v on v.id=ri.variant_id left join meal.brand_products bp on bp.id=ri.product_id left join meal.units u on u.id=ri.unit_id left join lateral(select sr.title from meal.recipe_revisions sr join meal.recipe_publications sp on sp.revision_id=sr.id join meal.recipes source on source.id=sr.recipe_id where sr.recipe_id=ri.source_recipe_id and sp.unpublished_at is null and sp.published_at<=now() and source.archived_at is null and source.status not in ('hidden','unpublished','deleted','archived') order by sp.published_at desc,sp.id desc limit 1) public_source on true where ri.revision_id=any(${revisions}::uuid[]) order by ri.position,ri.id`.execute(
            tx,
        );
        return rows.rows.map((row) => ({ ...recipeIngredientSchema.parse(row), revisionId: String(row.revisionId) }));
    }
    private async stocks(tx: Tx, userId: string, scope: 'private' | 'family'): Promise<RecipeStock[]> {
        const result =
            await sql<RecipeStock>`select coalesce(b.ingredient_id,bv.ingredient_id,pv.ingredient_id) as "ingredientId",coalesce(b.variant_id,bp.variant_id) as "variantId",b.product_id as "productId",coalesce(preserve_source.recipe_id,source.recipe_id) as "sourceRecipeId",b.quantity::text,u.code as unit from meal.inventory_batches b join meal.data_scopes ds on ds.id=b.scope_id left join meal.units u on u.id=b.unit_id left join meal.brand_products bp on bp.id=b.product_id left join meal.ingredient_variants bv on bv.id=b.variant_id left join meal.ingredient_variants pv on pv.id=bp.variant_id left join meal.preserve_details pd on pd.batch_id=b.id left join meal.recipe_revisions preserve_source on preserve_source.id=pd.recipe_revision_id left join lateral(select rr.recipe_id from meal.cooking_outputs co join meal.cooking_attempts ca on ca.id=co.attempt_id join meal.recipe_revisions rr on rr.id=ca.revision_id where co.batch_id=b.id order by co.created_at desc,co.id desc limit 1) source on true where ds.kind=${scope} and ((${scope}='private' and ds.user_id=${userId}::uuid) or (${scope}='family' and exists(select 1 from meal.family_memberships fm join meal.families f on f.id=fm.family_id where fm.family_id=ds.family_id and fm.user_id=${userId}::uuid and fm.left_at is null and f.status='active' and f.archived_at is null))) and b.archived_at is null and (b.quantity is null or b.quantity>0)`.execute(
                tx,
            );
        return result.rows;
    }
    list(query: RecipesQuery, userId?: string) {
        if (query.tab === 'inventory' && !userId) throw new HttpException('Требуется вход', 401);
        if (query.tab === 'for-you' && userId && this.recommendations)
            return this.recommendations.recipes(userId, query.scope, query.limit).then((recommendations) => ({
                items: recommendations.map((item) => item.recipe),
                total: recommendations.length,
                page: query.page,
                limit: query.limit,
                recommendationMode: 'personalized-v1' as const,
            }));
        return this.run(userId, false, async (tx) => {
            if (query.scope === 'family') {
                if (!userId) throw new HttpException('Требуется вход', 401);
                const membership = await tx
                    .selectFrom('family_memberships')
                    .innerJoin('families', 'families.id', 'family_memberships.family_id')
                    .select('family_memberships.family_id as familyId')
                    .where('family_memberships.user_id', '=', userId)
                    .where('family_memberships.left_at', 'is', null)
                    .where('families.status', '=', 'active')
                    .where('families.archived_at', 'is', null)
                    .executeTakeFirst();
                if (!membership) throw new HttpException('Семья не найдена', 404);
                if (!this.entitlements) throw new ServiceUnavailableException();
                if (!(await this.entitlements.resolveFamily(userId, membership.familyId, tx)).capabilities.family)
                    throw new HttpException('Семейный доступ приостановлен', 403);
            }
            const present = sql`(select count(*) from meal.recipe_ingredients ri where ri.revision_id=p.revision_id and not ri.optional and exists(select 1 from meal.inventory_batches b join meal.data_scopes ds on ds.id=b.scope_id left join meal.brand_products bp on bp.id=b.product_id left join meal.ingredient_variants bv on bv.id=b.variant_id left join meal.ingredient_variants pv on pv.id=bp.variant_id where ds.kind=${query.scope} and ((${query.scope}='private' and ds.user_id=${userId ?? null}::uuid) or (${query.scope}='family' and exists(select 1 from meal.family_memberships fm join meal.families f on f.id=fm.family_id where fm.family_id=ds.family_id and fm.user_id=${userId ?? null}::uuid and fm.left_at is null and f.status='active' and f.archived_at is null))) and b.archived_at is null and ${stockMatch}))`;
            const required = sql`(select count(*) from meal.recipe_ingredients ri where ri.revision_id=p.revision_id and not ri.optional)`;
            const order =
                query.tab === 'inventory'
                    ? sql`case when ${required}=0 then 1 else ${present}::numeric/${required} end desc,p.published_at desc,p.id`
                    : sql`p.published_at desc,p.id`;
            const filter = sql`position(lower(${query.q}) in lower(p.title||' '||coalesce(p.description,'')))>0 and (${query.category ?? null}::text is null or p.category=${query.category ?? null})`;
            const rows = await sql<
                Record<string, unknown>
            >`${published} select ${summarySql} from published p where ${filter} order by ${order} limit ${query.limit} offset ${(query.page - 1) * query.limit}`.execute(
                tx,
            );
            const count = await sql<{
                total: number;
            }>`${published} select count(*)::integer as total from published p where ${filter}`.execute(tx);
            const items = rows.rows.map(card);
            if (userId && items.length) {
                const lines = await this.ingredients(
                    tx,
                    items.map((item) => item.revisionId),
                );
                const stocks = await this.stocks(tx, userId, query.scope);
                for (const item of items) {
                    const { items: ignored, ...availability } = recipeAvailability(
                        lines.filter((line) => line.revisionId === item.revisionId),
                        stocks,
                        item.baseServings,
                        item.baseServings,
                    );
                    void ignored;
                    item.availability = availability;
                }
            }
            return {
                items,
                total: count.rows[0]?.total ?? 0,
                page: query.page,
                limit: query.limit,
                recommendationMode: 'inventory-presence-v1' as const,
            };
        });
    }
    detail(id: string) {
        return this.run(undefined, false, async (tx) => {
            const row = await this.publicRow(tx, id);
            const summary = card(row);
            const lines = await this.ingredients(tx, [summary.revisionId]);
            const ingredients = lines.map(({ revisionId, ...line }) => {
                void revisionId;
                return line;
            });
            const steps =
                await sql`select id,position,text,duration_seconds as "durationSeconds",temperature::text from meal.recipe_steps where revision_id=${summary.revisionId}::uuid order by position,id`.execute(
                    tx,
                );
            const variants = await sql<
                Record<string, unknown>
            >`${published} select ${summarySql} from published p where p.base_recipe_id=${id}::uuid order by p.published_at desc,p.id limit 100`.execute(
                tx,
            );
            const comments = await sql<
                Record<string, unknown>
            >`select c.id,c.body,case when u.status='active' and u.archived_at is null and u.email_verified_at is not null then u.login else null end as "authorLogin",c.created_at as "createdAt",c.edited_at is not null as edited,c.reply_to_id as "replyToId" from meal.recipe_comments c left join meal.users u on u.id=c.author_id where c.recipe_id=${id}::uuid and c.removed_at is null order by c.created_at,c.id limit 100`.execute(
                tx,
            );
            const count = await sql<{
                total: number;
            }>`select count(*)::integer as total from meal.recipe_comments where recipe_id=${id}::uuid and removed_at is null`.execute(
                tx,
            );
            if (!this.allergenIntelligence) throw new ServiceUnavailableException();
            const allergenProjection = await this.allergenIntelligence.recipeProjection(tx, summary.revisionId);
            const nutrition = recipeNutritionSchema.safeParse(row.nutrition_snapshot);
            return {
                recipe: recipeDetailSchema.parse({
                    ...summary,
                    method: row.method,
                    ingredients,
                    steps: steps.rows,
                    nutrition: nutrition.success ? nutrition.data : null,
                    variants: variants.rows.map(card),
                    comments: comments.rows.map((c) => ({
                        ...c,
                        createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
                    })),
                    commentsTotal: count.rows[0]?.total ?? 0,
                    allergens: allergenProjection.allergens,
                    allergensComplete: allergenProjection.complete,
                    allergenCompleteness: {
                        complete: allergenProjection.complete,
                        unknownIngredients: allergenProjection.unknownIngredients,
                    },
                }),
            };
        });
    }
    personal(userId: string, id: string, servings: number) {
        return this.run(userId, false, async (tx) => {
            const row = await this.publicRow(tx, id);
            const recipe = card(row);
            const ingredients = await this.ingredients(tx, [recipe.revisionId]);
            const stocks = await this.stocks(tx, userId, 'private');
            const bookmark = await tx
                .selectFrom('recipe_bookmarks')
                .select('id')
                .where('user_id', '=', userId)
                .where('recipe_id', '=', id)
                .where('removed_at', 'is', null)
                .executeTakeFirst();
            return {
                recipeId: id,
                servings,
                bookmarked: !!bookmark,
                availability: recipeAvailability(ingredients, stocks, recipe.baseServings, servings),
            };
        });
    }
    bookmark(userId: string, id: string, input: z.infer<typeof recipeBookmarkSchema>) {
        return this.run(userId, true, async (tx) => {
            await this.publicRow(tx, id);
            const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            const prior = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', 'recipe.bookmark')
                .where('target_binding', '=', id)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (prior) {
                if (prior.request_hash !== hash) throw new HttpException('Ключ использован для другого запроса', 409);
                return {
                    recipeId: id,
                    bookmarked: z.object({ recipeId: z.uuid(), bookmarked: z.boolean() }).parse(prior.response_snapshot)
                        .bookmarked,
                };
            }
            const existing = await tx
                .selectFrom('recipe_bookmarks')
                .select('id')
                .where('user_id', '=', userId)
                .where('recipe_id', '=', id)
                .forUpdate()
                .executeTakeFirst();
            if (existing)
                await tx
                    .updateTable('recipe_bookmarks')
                    .set({ removed_at: input.bookmarked ? null : new Date(), version: sql`version+1` })
                    .where('id', '=', existing.id)
                    .where('user_id', '=', userId)
                    .execute();
            else if (input.bookmarked)
                await tx
                    .insertInto('recipe_bookmarks')
                    .values({ id: randomUUID(), user_id: userId, recipe_id: id, removed_at: null })
                    .execute();
            const result = { recipeId: id, bookmarked: input.bookmarked };
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'recipe.bookmark',
                    target_binding: id,
                    key: input.idempotencyKey,
                    request_hash: hash,
                    status: 'completed',
                    response_snapshot: result,
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: userId,
                    scope_id: null,
                    actor_namespace: `user:${userId}`,
                })
                .execute();
            return result;
        });
    }
}
