import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { publicRecipeImage, recipeSummarySchema, type RecipeSummary } from '../../shared/contracts/recipe-public.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import {
    authorFollowResultSchema,
    authorFollowSchema,
    authorFollowingListSchema,
    authorFollowingQuerySchema,
    authorRecommendationSchema,
    recommendationEventResultSchema,
    recommendationEventSchema,
    recommendationsResultSchema,
    type AuthorRecommendation,
    type RecommendationsQuery,
    type RecipeRecommendation,
} from './recommendations.contracts.js';
import { diversifyRecipes, evaluateRecipeSafety, scoreRecipe, type RecipeCandidate } from './recommendations.domain.js';

type Tx = Transaction<DatabaseSchema>;
type Preferences = {
    diets: string[];
    allergens: string[];
    allergenMode: 'warn' | 'hide';
    equipment: Record<string, 'yes' | 'no' | 'unknown'>;
    goals: string[];
};

const defaultPreferences = (): Preferences => ({
    diets: [],
    allergens: [],
    allergenMode: 'warn',
    equipment: {},
    goals: [],
});
const preferencesSchema = z.object({
    diets: z.array(z.string()).default([]),
    allergens: z.array(z.string()).default([]),
    allergenMode: z.enum(['warn', 'hide']).default('warn'),
    equipment: z.record(z.string(), z.enum(['yes', 'no', 'unknown'])).default({}),
    goals: z.array(z.string()).default([]),
});
const json = (value: unknown) => (value && typeof value === 'object' ? value : {});
const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const equipmentCodes = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(equipmentCodes);
    if (typeof value === 'string') return [value];
    if (!value || typeof value !== 'object') return [];
    const object = value as Record<string, unknown>;
    return [
        ...strings(object.codes),
        ...strings(object.required),
        ...(typeof object.code === 'string' ? [object.code] : []),
    ];
};
const timingMinutes = (value: unknown): number | null => {
    const result = z.object({ durationMinutes: z.number().int().nonnegative().nullable().optional() }).safeParse(value);
    return result.success ? (result.data.durationMinutes ?? null) : null;
};
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

@Injectable()
export class RecommendationsService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
    ) {}

    private async run<T>(userId: string, write: boolean, work: (tx: Tx) => Promise<T>): Promise<T> {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.transaction(async (tx) => {
            const user = await tx
                .selectFrom('users')
                .select('id')
                .where('id', '=', userId)
                .where('status', '=', 'active')
                .where('archived_at', 'is', null)
                .forUpdate()
                .executeTakeFirst();
            if (!user) throw new HttpException('Аккаунт недоступен', 403);
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

    private async preferences(tx: Tx, userId: string): Promise<Preferences> {
        const row = await tx
            .selectFrom('user_settings')
            .select('preferences')
            .where('user_id', '=', userId)
            .executeTakeFirst();
        const parsed = preferencesSchema.safeParse(json(row?.preferences));
        return parsed.success ? parsed.data : defaultPreferences();
    }

    private card(row: Record<string, unknown>): RecipeSummary {
        return recipeSummarySchema.parse({
            id: row.id,
            revisionId: row.revisionId,
            title: row.title,
            description: row.description ?? null,
            imageUrl: publicRecipeImage(row.imageUrl),
            tags: strings(row.tags),
            authorLogin: row.authorLogin ?? null,
            category: row.category ?? null,
            baseServings: Number(row.baseServings),
            durationMinutes: timingMinutes(row.timing),
            rating: row.rating === null ? null : Number(row.rating),
            ratingCount: Number(row.ratingCount ?? 0),
            publishedAt: iso(row.publishedAt),
            availability: {
                requiredCount: Number(row.requiredCount ?? 0),
                presentCount: Number(row.presentCount ?? 0),
                presencePercent:
                    Number(row.requiredCount) === 0
                        ? 100
                        : Math.round((Number(row.presentCount) / Number(row.requiredCount)) * 100),
                canPrepare:
                    Number(row.requiredCount) === 0 || Number(row.presentCount) / Number(row.requiredCount) >= 0.8,
                needsQuantityCheck: true,
            },
        });
    }

    private async issue(
        tx: Tx,
        userId: string,
        surface: 'home' | 'recipes' | 'authors',
        items: Array<RecipeRecommendation | AuthorRecommendation>,
    ) {
        for (const [position, item] of items.entries()) {
            const entityKey = item.type === 'recipe' ? item.recipe.id : item.author.username;
            await sql`insert into meal.recommendation_issuances(id,user_id,recommendation_id,entity_type,entity_key,algorithm,surface,position,reason_codes,expires_at) values(${randomUUID()}::uuid,${userId}::uuid,${item.recommendationId}::uuid,${item.type},${entityKey},${item.algorithmVersion},${surface},${position},${JSON.stringify(item.reasonCodes)}::jsonb,now()+interval '24 hours') on conflict(user_id,recommendation_id) do update set surface=excluded.surface,position=excluded.position,reason_codes=excluded.reason_codes,created_at=now(),expires_at=excluded.expires_at`.execute(
                tx,
            );
        }
    }

    async recipes(
        userId: string,
        scope: 'private' | 'family',
        limit: number,
        surface: 'home' | 'recipes' = 'recipes',
    ): Promise<RecipeRecommendation[]> {
        return this.run(userId, false, async (tx) => {
            if (scope === 'family') {
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
                if (!(await this.entitlements.resolveFamily(userId, membership.familyId, tx)).capabilities.family)
                    throw new HttpException('Семейный доступ приостановлен', 403);
            }
            const preferences = await this.preferences(tx, userId);
            const rows = await sql<Record<string, unknown>>`
with published as (
 select distinct on(r.id) r.id,r.author_id,rr.id as revision_id,rr.title,rr.description,rr.category,rr.image_url,rr.tags,rr.portions,rr.timing,p.published_at
 from meal.recipes r join meal.recipe_revisions rr on rr.recipe_id=r.id join meal.recipe_publications p on p.revision_id=rr.id
 where p.unpublished_at is null and p.published_at<=now() and r.archived_at is null and r.status not in('hidden','unpublished','deleted','archived')
 order by r.id,p.published_at desc,p.id desc
), user_recipes as (
 select distinct b.recipe_id from meal.recipe_bookmarks b where b.user_id=${userId}::uuid and b.removed_at is null
 union select distinct rr.recipe_id from meal.cooking_attempts ca join meal.recipe_revisions rr on rr.id=ca.revision_id where ca.actor_id=${userId}::uuid and ca.status='completed'
 union select distinct r.recipe_id from meal.recipe_ratings r where r.user_id=${userId}::uuid
 union select distinct rr.recipe_id from meal.plan_entries pe join meal.plan_revisions pr on pr.id=pe.revision_id join meal.meal_plans mp on mp.id=pr.plan_id join meal.data_scopes ds on ds.id=mp.scope_id join meal.recipe_revisions rr on rr.id=pe.recipe_revision_id where ds.kind='private' and ds.user_id=${userId}::uuid
), eligible_profile as(select count(*)>=5 enabled from user_recipes), peers as (
 select b.user_id,count(distinct b.recipe_id)::int overlap from meal.recipe_bookmarks b join user_recipes ur on ur.recipe_id=b.recipe_id cross join eligible_profile ep where ep.enabled and b.user_id<>${userId}::uuid and b.removed_at is null group by b.user_id
), collaborative as (
 select b.recipe_id,count(distinct b.user_id)::int support,sum(pe.overlap)::float8/greatest(1,count(distinct b.user_id)) score from meal.recipe_bookmarks b join peers pe on pe.user_id=b.user_id where b.removed_at is null group by b.recipe_id
)
select p.id,p.revision_id as "revisionId",p.title,p.description,p.category,p.image_url as "imageUrl",p.tags,p.portions as "baseServings",p.timing,p.published_at as "publishedAt",u.login as "authorLogin",
 (select avg(x.value)::float8 from meal.recipe_ratings x where x.recipe_id=p.id) rating,
 (select count(*)::int from meal.recipe_ratings x where x.recipe_id=p.id) "ratingCount",
 (select count(*)::int from meal.recipe_ingredients ri where ri.revision_id=p.revision_id and not ri.optional) "requiredCount",
 (select count(*)::int from meal.recipe_ingredients ri where ri.revision_id=p.revision_id and not ri.optional and exists(
   select 1 from meal.inventory_batches b join meal.data_scopes ds on ds.id=b.scope_id left join meal.brand_products bp on bp.id=b.product_id left join meal.ingredient_variants bv on bv.id=b.variant_id left join meal.ingredient_variants pv on pv.id=bp.variant_id
   where ds.kind=${scope} and ((${scope}='private' and ds.user_id=${userId}::uuid) or (${scope}='family' and exists(select 1 from meal.family_memberships fm join meal.families f on f.id=fm.family_id where fm.family_id=ds.family_id and fm.user_id=${userId}::uuid and fm.left_at is null and f.status='active' and f.archived_at is null))) and b.archived_at is null and (b.quantity is null or b.quantity>0)
   and ((ri.product_id is not null and b.product_id=ri.product_id) or (ri.product_id is null and ri.variant_id is not null and coalesce(b.variant_id,bp.variant_id)=ri.variant_id) or (ri.product_id is null and ri.variant_id is null and ri.ingredient_id is not null and coalesce(b.ingredient_id,bv.ingredient_id,pv.ingredient_id)=ri.ingredient_id))
 )) "presentCount",
 (select count(*)::int from meal.recipe_ingredients ri where ri.revision_id=p.revision_id and not ri.optional and exists(
   select 1 from meal.inventory_batches b join meal.data_scopes ds on ds.id=b.scope_id left join meal.brand_products bp on bp.id=b.product_id left join meal.ingredient_variants bv on bv.id=b.variant_id left join meal.ingredient_variants pv on pv.id=bp.variant_id
   where ds.kind=${scope} and ((${scope}='private' and ds.user_id=${userId}::uuid) or (${scope}='family' and exists(select 1 from meal.family_memberships fm join meal.families f on f.id=fm.family_id where fm.family_id=ds.family_id and fm.user_id=${userId}::uuid and fm.left_at is null and f.status='active' and f.archived_at is null))) and b.archived_at is null and b.expiry_on between current_date and current_date+14 and ((ri.product_id is not null and b.product_id=ri.product_id) or (ri.product_id is null and ri.variant_id is not null and coalesce(b.variant_id,bp.variant_id)=ri.variant_id) or (ri.product_id is null and ri.variant_id is null and ri.ingredient_id is not null and coalesce(b.ingredient_id,bv.ingredient_id,pv.ingredient_id)=ri.ingredient_id))
 )) "expiringCount",
 (select count(*)::int from meal.cooking_attempts ca join meal.recipe_revisions cr on cr.id=ca.revision_id where ca.actor_id=${userId}::uuid and ca.status='completed' and cr.recipe_id=p.id) "completedCount",
 (select extract(day from now()-max(ca.completed_at))::int from meal.cooking_attempts ca join meal.recipe_revisions cr on cr.id=ca.revision_id where ca.actor_id=${userId}::uuid and ca.status='completed' and cr.recipe_id=p.id) "daysSinceCooked",
 coalesce(c.support,0) "collaborativeSupport",coalesce(c.score,0) "collaborativeScore",
 coalesce((select jsonb_agg(rs.equipment_requirements) filter(where rs.equipment_requirements is not null) from meal.recipe_steps rs where rs.revision_id=p.revision_id),'[]'::jsonb) equipment,
 exists(select 1 from meal.recipe_ingredients ri left join lateral(
   select cv.dietary_flags from meal.composition_versions cv where (ri.product_id is not null and cv.product_id=ri.product_id) or (ri.product_id is null and ri.variant_id is not null and cv.variant_id=ri.variant_id) or (ri.product_id is null and ri.variant_id is null and cv.ingredient_id=ri.ingredient_id) order by cv.revision desc,cv.created_at desc,cv.id desc limit 1
 ) latest on true where ri.revision_id=p.revision_id and coalesce((latest.dietary_flags->>'allergensComplete')::boolean,false)=false) "allergensIncomplete",
 coalesce((select jsonb_agg(distinct evidence.status) from (
   select ca.status from meal.recipe_ingredients ri join lateral(select cv.id from meal.composition_versions cv where (ri.product_id is not null and cv.product_id=ri.product_id) or (ri.product_id is null and ri.variant_id is not null and cv.variant_id=ri.variant_id) or (ri.product_id is null and ri.variant_id is null and cv.ingredient_id=ri.ingredient_id) order by cv.revision desc,cv.created_at desc,cv.id desc limit 1) cv on true join meal.composition_allergens ca on ca.composition_id=cv.id join meal.allergens a on a.id=ca.allergen_id where ri.revision_id=p.revision_id and a.code=any(${preferences.allergens}::text[])
   union all select m.status from meal.recipe_ingredients ri left join meal.brand_products bp on bp.id=ri.product_id left join meal.ingredient_variants rv on rv.id=coalesce(ri.variant_id,bp.variant_id) join meal.allergen_mappings m on m.removed_at is null and ((m.product_id is not null and m.product_id=ri.product_id) or (m.variant_id is not null and m.variant_id=coalesce(ri.variant_id,bp.variant_id)) or (m.ingredient_id is not null and m.ingredient_id=coalesce(ri.ingredient_id,rv.ingredient_id))) join meal.allergens a on a.id=m.allergen_id where ri.revision_id=p.revision_id and a.code=any(${preferences.allergens}::text[])
 ) evidence),'[]'::jsonb) "allergenStatuses"
from published p join meal.users u on u.id=p.author_id and u.status='active' and u.archived_at is null and u.email_verified_at is not null left join collaborative c on c.recipe_id=p.id
where not exists(select 1 from meal.recommendation_events re where re.user_id=${userId}::uuid and re.entity_type='recipe' and re.entity_key=p.id::text and re.event_kind in('not_interested','not_suitable'))
order by p.published_at desc,p.id limit 200`.execute(tx);

            const deniedEquipment = new Set(
                Object.entries(preferences.equipment)
                    .filter(([, state]) => state === 'no')
                    .map(([code]) => code),
            );
            const ranked: Array<{ recipe: RecipeCandidate; score: number; item: RecipeRecommendation }> = [];
            for (const row of rows.rows) {
                const tags = strings(row.tags);
                if (preferences.diets.length && !preferences.diets.some((diet) => tags.includes(diet))) continue;
                if (equipmentCodes(row.equipment).some((code) => deniedEquipment.has(code))) continue;
                const safety = evaluateRecipeSafety(preferences.allergenMode, {
                    complete: !row.allergensIncomplete,
                    statuses: strings(row.allergenStatuses).filter(
                        (status): status is 'contains' | 'may_contain' | 'unknown' =>
                            status === 'contains' || status === 'may_contain' || status === 'unknown',
                    ),
                });
                if (safety.exclude) continue;
                const candidate: RecipeCandidate = {
                    id: String(row.id),
                    category: typeof row.category === 'string' ? row.category : null,
                    tags,
                    durationMinutes: timingMinutes(row.timing),
                    rating: row.rating === null ? null : Number(row.rating),
                    ratingCount: Number(row.ratingCount ?? 0),
                    requiredCount: Number(row.requiredCount ?? 0),
                    presentCount: Number(row.presentCount ?? 0),
                    expiringCount: Number(row.expiringCount ?? 0),
                    completedCount: Number(row.completedCount ?? 0),
                    daysSinceCooked: row.daysSinceCooked === null ? null : Number(row.daysSinceCooked),
                    collaborativeSupport: Number(row.collaborativeSupport ?? 0),
                    collaborativeScore: Number(row.collaborativeScore ?? 0),
                };
                const scoring = scoreRecipe(candidate, preferences);
                const reasons = scoring.reasons.length
                    ? scoring.reasons
                    : [{ code: 'new_recipe' as const, text: 'Новый для вас рецепт' }];
                ranked.push({
                    recipe: candidate,
                    score: scoring.score,
                    item: {
                        type: 'recipe',
                        recommendationId: randomUUID(),
                        algorithmVersion: 'personalized-v1',
                        score: scoring.score,
                        reasonCodes: reasons.map((reason) => reason.code),
                        reasons,
                        safetyWarnings: safety.warnings,
                        recipe: this.card(row),
                    },
                });
            }
            const result = diversifyRecipes(ranked, limit).map(({ item }) => item);
            await this.issue(tx, userId, surface, result);
            return result;
        });
    }

    async authors(userId: string, limit: number): Promise<AuthorRecommendation[]> {
        return this.run(userId, false, async (tx) => {
            const rows = await sql<Record<string, unknown>>`
with engagement as (
 select r.author_id,count(*)::int affinity from meal.recipe_bookmarks b join meal.recipes r on r.id=b.recipe_id where b.user_id=${userId}::uuid and b.removed_at is null group by r.author_id
 union all select r.author_id,count(*)::int*3 from meal.cooking_attempts ca join meal.recipe_revisions rr on rr.id=ca.revision_id join meal.recipes r on r.id=rr.recipe_id where ca.actor_id=${userId}::uuid and ca.status='completed' group by r.author_id
), affinity as(select author_id,sum(affinity)::int affinity from engagement group by author_id), eligible_profile as(select count(*)>=5 enabled from meal.author_follows where follower_id=${userId}::uuid and removed_at is null), peers as(
 select af.follower_id,count(*)::int overlap from meal.author_follows af join meal.author_follows mine on mine.author_id=af.author_id and mine.follower_id=${userId}::uuid and mine.removed_at is null cross join eligible_profile ep where ep.enabled and af.follower_id<>${userId}::uuid and af.removed_at is null group by af.follower_id
), similar as(select af.author_id,count(distinct af.follower_id)::int support,sum(p.overlap)::float8 score from meal.author_follows af join peers p on p.follower_id=af.follower_id where af.removed_at is null group by af.author_id)
select u.login,(select count(distinct r.id)::int from meal.recipes r join meal.recipe_revisions rr on rr.recipe_id=r.id join meal.recipe_publications rp on rp.revision_id=rr.id and rp.unpublished_at is null and rp.published_at<=now() where r.author_id=u.id and r.archived_at is null and r.status not in('hidden','unpublished','deleted','archived')) "recipeCount",
(select avg(rt.value)::float8 from meal.recipe_ratings rt join meal.recipes r on r.id=rt.recipe_id where r.author_id=u.id) "averageRating",
(select count(*)::int from meal.author_follows f where f.author_id=u.id and f.removed_at is null) "followerCount",coalesce(a.affinity,0) affinity,coalesce(s.support,0) support,coalesce(s.score,0) similarity
from meal.users u left join affinity a on a.author_id=u.id left join similar s on s.author_id=u.id
where u.id<>${userId}::uuid and u.status='active' and u.archived_at is null and u.email_verified_at is not null and not exists(select 1 from meal.sanctions sn where sn.user_id=u.id and sn.scope='account' and sn.revoked_at is null and sn.starts_at<=now() and (sn.ends_at is null or sn.ends_at>now())) and not exists(select 1 from meal.author_follows f where f.follower_id=${userId}::uuid and f.author_id=u.id and f.removed_at is null) and not exists(select 1 from meal.recommendation_events re where re.user_id=${userId}::uuid and re.entity_type='author' and re.entity_key=u.login and re.event_kind in('not_interested','not_suitable')) and exists(select 1 from meal.recipes r join meal.recipe_revisions rr on rr.recipe_id=r.id join meal.recipe_publications rp on rp.revision_id=rr.id where r.author_id=u.id and r.archived_at is null and r.status not in('hidden','unpublished','deleted','archived') and rp.unpublished_at is null and rp.published_at<=now())
order by coalesce(a.affinity,0) desc,case when coalesce(s.support,0)>=20 then s.score else 0 end desc,"averageRating" desc nulls last,u.login limit ${limit}`.execute(
                tx,
            );
            const result = rows.rows.map((row) => {
                const affinity = Number(row.affinity ?? 0),
                    support = Number(row.support ?? 0),
                    rating = row.averageRating === null ? null : Number(row.averageRating);
                const reasons: AuthorRecommendation['reasons'] = [];
                if (affinity)
                    reasons.push({ code: 'author_affinity', text: 'Вы сохраняли или готовили рецепты этого автора' });
                if (support >= 20)
                    reasons.push({
                        code: 'author_similar_audience',
                        text: 'На автора подписаны люди с похожими интересами',
                    });
                if (rating !== null && rating >= 4)
                    reasons.push({ code: 'author_quality', text: 'Рецепты автора высоко оценены' });
                if (!reasons.length)
                    reasons.push({ code: 'author_quality', text: 'У автора есть опубликованные рецепты' });
                const selectedReasons = reasons.slice(0, 3);
                return authorRecommendationSchema.parse({
                    type: 'author',
                    recommendationId: randomUUID(),
                    algorithmVersion: 'personalized-v1',
                    score: Math.min(
                        100,
                        affinity * 12 + (support >= 20 ? Number(row.similarity) : 0) + (rating ?? 0) * 8,
                    ),
                    reasonCodes: selectedReasons.map((reason) => reason.code),
                    reasons: selectedReasons,
                    safetyWarnings: [],
                    author: {
                        username: row.login,
                        recipeCount: row.recipeCount,
                        averageRating: rating,
                        followerCount: row.followerCount,
                        followed: false,
                    },
                });
            });
            await this.issue(tx, userId, 'authors', result);
            return result;
        });
    }

    async list(userId: string, query: RecommendationsQuery) {
        const items =
            query.type === 'recipe'
                ? await this.recipes(userId, query.scope, query.limit, query.surface as 'home' | 'recipes')
                : await this.authors(userId, query.limit);
        return recommendationsResultSchema.parse({ algorithm: 'personalized-v1', items });
    }

    event(userId: string, raw: unknown) {
        const input = recommendationEventSchema.parse(raw);
        return this.run(userId, true, async (tx) => {
            const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            const prior = await sql<{
                payload_hash: string;
            }>`select payload_hash from meal.recommendation_events where user_id=${userId}::uuid and idempotency_key=${input.idempotencyKey}::uuid`.execute(
                tx,
            );
            if (prior.rows[0]) {
                if (prior.rows[0].payload_hash !== hash)
                    throw new HttpException('Ключ использован для другого события', 409);
                return recommendationEventResultSchema.parse({ accepted: true });
            }
            const issuance = await sql<{
                entity_type: string;
                entity_key: string;
                algorithm: string;
                surface: string;
                position: number | null;
                reason_codes: unknown;
            }>`select entity_type,entity_key,algorithm,surface,position,reason_codes from meal.recommendation_issuances where user_id=${userId}::uuid and recommendation_id=${input.recommendationId}::uuid and expires_at>now()`.execute(
                tx,
            );
            const issued = issuance.rows[0];
            if (!issued) throw new HttpException('Рекомендация истекла или не выдавалась', 409);
            if (
                issued.entity_type !== input.entityType ||
                issued.entity_key !== input.entityId ||
                issued.algorithm !== input.algorithm ||
                issued.surface !== input.surface ||
                issued.position !== input.position ||
                JSON.stringify(issued.reason_codes) !== JSON.stringify(input.reasonCodes)
            )
                throw new HttpException('Событие не соответствует выданной рекомендации', 422);
            if (input.entityType === 'recipe') {
                const target = await tx
                    .selectFrom('recipes')
                    .select('id')
                    .where('id', '=', z.uuid().parse(input.entityId))
                    .where('archived_at', 'is', null)
                    .executeTakeFirst();
                if (!target) throw new HttpException('Рецепт недоступен', 404);
            } else {
                const target = await tx
                    .selectFrom('users')
                    .select('id')
                    .where('login', '=', input.entityId)
                    .where('status', '=', 'active')
                    .where('archived_at', 'is', null)
                    .executeTakeFirst();
                if (!target) throw new HttpException('Автор недоступен', 404);
            }
            await sql`insert into meal.recommendation_events(id,user_id,recommendation_id,event_kind,entity_type,entity_key,algorithm,surface,position,reason_codes,payload_hash,idempotency_key) values(${randomUUID()}::uuid,${userId}::uuid,${input.recommendationId}::uuid,${input.event},${issued.entity_type},${issued.entity_key},${issued.algorithm},${issued.surface},${issued.position},${JSON.stringify(issued.reason_codes)}::jsonb,${hash},${input.idempotencyKey}::uuid)`.execute(
                tx,
            );
            return recommendationEventResultSchema.parse({ accepted: true });
        });
    }

    follow(userId: string, username: string, raw: unknown) {
        const input = authorFollowSchema.parse(raw);
        return this.run(userId, true, async (tx) => {
            const author = (
                await sql<{
                    id: string;
                    login: string;
                }>`select u.id,u.login from meal.users u where lower(u.login)=lower(${username}) and u.status='active' and u.archived_at is null and u.email_verified_at is not null and not exists(select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now())) limit 1`.execute(
                    tx,
                )
            ).rows[0];
            if (!author) throw new HttpException('Автор недоступен', 404);
            if (author.id === userId) throw new HttpException('Нельзя подписаться на себя', 422);
            const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            const prior = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', 'author.follow')
                .where('target_binding', '=', author.id)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (prior) {
                if (prior.request_hash !== hash) throw new HttpException('Ключ использован для другого запроса', 409);
                return authorFollowResultSchema.parse(prior.response_snapshot);
            }
            const existing = await sql<{
                id: string;
            }>`select id from meal.author_follows where follower_id=${userId}::uuid and author_id=${author.id}::uuid for update`.execute(
                tx,
            );
            if (existing.rows[0])
                await sql`update meal.author_follows set removed_at=${input.following ? null : new Date()},version=version+1 where id=${existing.rows[0].id}::uuid`.execute(
                    tx,
                );
            else if (input.following)
                await sql`insert into meal.author_follows(id,follower_id,author_id,removed_at) values(${randomUUID()}::uuid,${userId}::uuid,${author.id}::uuid,null)`.execute(
                    tx,
                );
            const result = authorFollowResultSchema.parse({ username: author.login, following: input.following });
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'author.follow',
                    target_binding: author.id,
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

    followState(userId: string, username: string) {
        return this.run(userId, false, async (tx) => {
            const author = await sql<{
                id: string;
                login: string;
            }>`select u.id,u.login from meal.users u where lower(u.login)=lower(${username}) and u.status='active' and u.archived_at is null and u.email_verified_at is not null and not exists(select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now())) limit 1`.execute(
                tx,
            );
            if (!author.rows[0]) throw new HttpException('Автор недоступен', 404);
            const following =
                await sql`select id from meal.author_follows where follower_id=${userId}::uuid and author_id=${author.rows[0].id}::uuid and removed_at is null limit 1`.execute(
                    tx,
                );
            return authorFollowResultSchema.parse({
                username: author.rows[0].login,
                following: following.rows.length > 0,
            });
        });
    }

    following(userId: string, raw: unknown) {
        const input = authorFollowingQuerySchema.parse(raw);
        const cursorSchema = z.strictObject({ login: z.string(), id: z.uuid() });
        let cursor: z.infer<typeof cursorSchema> | null = null;
        if (input.cursor)
            try {
                cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
            } catch {
                throw new BadRequestException('Некорректный cursor');
            }
        return this.run(userId, false, async (tx) => {
            const cursorFilter = cursor
                ? sql`and (lower(u.login),u.id)>(lower(${cursor.login}),${cursor.id}::uuid)`
                : sql``;
            const rows = await sql<{ id: string; username: string; recipeCount: number }>`
              select u.id,u.login username,(select count(distinct r.id)::integer from meal.recipes r join meal.recipe_revisions rr on rr.recipe_id=r.id join meal.recipe_publications p on p.revision_id=rr.id where r.author_id=u.id and r.archived_at is null and r.status not in('hidden','unpublished','deleted','archived') and p.unpublished_at is null and p.published_at<=now()) as "recipeCount"
              from meal.author_follows f join meal.users u on u.id=f.author_id
              where f.follower_id=${userId}::uuid and f.removed_at is null and u.status='active' and u.archived_at is null and u.email_verified_at is not null
                and not exists(select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))
                ${cursorFilter} order by lower(u.login),u.id limit ${input.limit + 1}`.execute(tx);
            const page = rows.rows.slice(0, input.limit);
            const last = page.at(-1);
            return authorFollowingListSchema.parse({
                items: page.map((row) => ({
                    username: row.username,
                    avatarUrl: null,
                    recipeCount: row.recipeCount,
                    following: true,
                })),
                nextCursor:
                    rows.rows.length > input.limit && last
                        ? Buffer.from(JSON.stringify({ login: last.username, id: last.id })).toString('base64url')
                        : null,
            });
        });
    }
}
