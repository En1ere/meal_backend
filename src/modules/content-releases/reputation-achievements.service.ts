import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { LegalConsentService } from '../legal-consents/legal-consent.service.js';
import {
    achievementPayloadSchema,
    authorAchievementsSchema,
    authorReputationSchema,
    publicReputationLevelsSchema,
    reputationTitlePayloadSchema,
} from './content-releases.contracts.js';
import {
    achievementAggregateConditionSchema,
    achievementReached,
    categoryTitle,
    type AchievementMetrics,
} from './achievement-policy.js';

type Tx = Transaction<DatabaseSchema>;
const iso = (value: Date | string) => new Date(value).toISOString();

export class ReputationAchievementsService {
    constructor(
        private readonly database: DatabaseService,
        private readonly legalConsents: LegalConsentService,
    ) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    async publicLevels() {
        const rows = await sql<{
            payload: unknown;
        }>`select payload from meal.content_resource_heads where resource_type='reputation_title' and not retired order by (payload->>'level')::int`.execute(
            await this.db(),
        );
        return publicReputationLevelsSchema.parse({
            items: rows.rows.map((row) => reputationTitlePayloadSchema.parse(row.payload)),
        });
    }

    async recordReputationEvent(
        userId: string,
        code: string,
        subjectKey: string,
        qualifyingEventKey: string,
        evidence: Record<string, unknown>,
    ) {
        return this.database.transaction((tx) =>
            this.recordReputationEventIn(tx, userId, code, subjectKey, qualifyingEventKey, evidence),
        );
    }

    async recordReputationEventIn(
        tx: Tx,
        userId: string,
        code: string,
        subjectKey: string,
        qualifyingEventKey: string,
        evidence: Record<string, unknown>,
    ) {
        const rule = await sql<{
            revision: number;
            points: number;
            cap: number | null;
            enabled: boolean;
        }>`select revision,points,per_subject_cap cap,enabled from meal.reputation_rule_versions where code=${code} order by revision desc limit 1`.execute(
            tx,
        );
        const current = rule.rows[0];
        // Content configuration must never block moderation/cooking. Until the first rules release there is no accrual.
        if (!current?.enabled) return { eventId: null, created: false };
        const ruleVersion = `${code}:${current.revision}`;
        const prior = await sql<{
            id: string;
            activeId: string;
            activeDelta: number;
        }>`select original.id,active.id "activeId",active.delta::int "activeDelta" from meal.reputation_events original
            join lateral (select current.id,current.delta from meal.reputation_events current
                where current.user_id=original.user_id and current.evidence->>'qualifyingEventKey'=${qualifyingEventKey}
                  and not exists(select 1 from meal.reputation_events next where next.reverses_id=current.id)
                order by current.recorded_at desc,current.id desc limit 1) active on true
            where original.user_id=${userId}::uuid
              and original.evidence->>'qualifyingEventKey'=${qualifyingEventKey} and original.reverses_id is null`.execute(
            tx,
        );
        const priorEvent = prior.rows[0];
        if (priorEvent && priorEvent.activeDelta > 0) return { eventId: priorEvent.activeId, created: false };
        if (current.cap !== null) {
            const total = await sql<{
                value: number;
            }>`select coalesce(sum(delta),0)::int value from meal.reputation_events where user_id=${userId}::uuid and evidence->>'subjectKey'=${subjectKey}`.execute(
                tx,
            );
            if ((total.rows[0]?.value ?? 0) + current.points > current.cap) return { eventId: null, created: false };
        }
        const id = randomUUID();
        await sql`insert into meal.reputation_events(id,delta,rule_version,reason,evidence,recorded_at,user_id,reverses_id)
                values(${id}::uuid,${current.points},${ruleVersion},${code},${JSON.stringify({ ...evidence, subjectKey, qualifyingEventKey })}::jsonb,now(),${userId}::uuid,${priorEvent?.activeId ?? null}::uuid)`.execute(
            tx,
        );
        return { eventId: id, created: true };
    }

    async processAchievementEventIn(tx: Tx, userId: string, event: string, evidence: Record<string, unknown>) {
        await this.evaluateAchievementsIn(tx, userId, { event, ...evidence });
    }

    async evaluateAchievementsIn(tx: Tx, userId: string, evidence: Record<string, unknown> = {}) {
        const rules = await sql<{
            id: string;
            code: string;
            condition: unknown;
        }>`select distinct on(code) id,code,condition from meal.achievement_rules where enabled and retired_at is null order by code,revision desc`.execute(
            tx,
        );
        if (!rules.rows.length) return { evaluated: 0, awarded: 0 };
        const metrics = await this.achievementMetrics(tx, userId);
        let awarded = 0;
        for (const rule of rules.rows) {
            const condition = achievementAggregateConditionSchema.safeParse(rule.condition);
            if (!condition.success || !achievementReached(condition.data, metrics)) continue;
            const result =
                await sql`insert into meal.achievement_awards(id,achievement_key,awarded_at,revoked_at,evidence,user_id,rule_id)
                values(${randomUUID()}::uuid,${rule.code},now(),null,${JSON.stringify({ evaluator: 'aggregate-v1', metrics, ...evidence })}::jsonb,${userId}::uuid,${rule.id}::uuid)
                on conflict(user_id,achievement_key) do nothing returning id`.execute(tx);
            awarded += result.rows.length;
        }
        return { evaluated: rules.rows.length, awarded };
    }

    private async achievementMetrics(tx: Tx, userId: string): Promise<AchievementMetrics> {
        const result = await sql<AchievementMetrics>`
          with cooked as (
            select ca.id,ca.completed_at,rr.recipe_id,lower(coalesce(rr.category,'')) category,coalesce(rr.tags,'{}'::text[]) tags,
              ca.recipe_snapshot,exists(select 1 from meal.cooking_inputs ci join meal.inventory_batches ib on ib.id=ci.batch_id where ci.attempt_id=ca.id and ib.kind in('prepared','preserve')) used_leftover
            from meal.cooking_attempts ca left join meal.recipe_revisions rr on rr.id=ca.revision_id
            where ca.actor_id=${userId}::uuid and ca.status='completed' and ca.completed_at is not null
          ), published as (
            select distinct on(r.id) r.id,rr.id revision_id,lower(coalesce(rr.category,'')) category,coalesce(rr.tags,'{}'::text[]) tags,rr.description,rr.image_url,
              exists(select 1 from meal.recipe_ingredients ri where ri.revision_id=rr.id) has_ingredients,
              exists(select 1 from meal.recipe_steps rs where rs.revision_id=rr.id) has_steps
            from meal.recipes r join meal.recipe_revisions rr on rr.recipe_id=r.id join meal.recipe_publications rp on rp.revision_id=rr.id
            where r.author_id=${userId}::uuid and rp.unpublished_at is null and rp.published_at<=now()
            order by r.id,rp.published_at desc,rp.id desc
          ), independent as (
            select rr.recipe_id,count(distinct ca.actor_id)::int cooks from meal.cooking_attempts ca join meal.recipe_revisions rr on rr.id=ca.revision_id
            join meal.recipes r on r.id=rr.recipe_id where r.author_id=${userId}::uuid and ca.actor_id<>${userId}::uuid and ca.status='completed' group by rr.recipe_id
          ), family_ids as (
            select fm.family_id from meal.family_memberships fm where fm.user_id=${userId}::uuid and fm.left_at is null
          )
          select
            (select count(*)::int from cooked) "cookCount",
            (select count(distinct recipe_id)::int from cooked where recipe_id is not null) "distinctRecipes",
            (select count(distinct recipe_id)::int from cooked where category like '%breakfast%' or 'breakfast'=any(tags)) "breakfastCount",
            (select count(distinct recipe_id)::int from cooked where category like '%soup%' or 'soup'=any(tags)) "soupCount",
            (select count(distinct recipe_id)::int from cooked where category like '%bak%' or 'baking'=any(tags)) "bakingCount",
            (select count(distinct recipe_id)::int from cooked where category like '%dessert%' or 'dessert'=any(tags)) "dessertCount",
            (select count(distinct recipe_id)::int from cooked where 'vegetable'=any(tags)) "vegetableCount",
            (select count(distinct recipe_id)::int from cooked where 'fish'=any(tags)) "fishCount",
            (select count(distinct recipe_id)::int from cooked where 'plant-based'=any(tags) or 'vegan'=any(tags)) "plantCount",
            (select count(distinct tag)::int from cooked cross join lateral unnest(tags) tag where tag like 'cuisine:%') "cuisineCount",
            (select count(*)::int from cooked where used_leftover) "leftoverCount",
            (select count(*)::int from cooked where extract(hour from completed_at at time zone 'Europe/Moscow') between 5 and 9) "earlyCount",
            (select count(*)::int from cooked where extract(hour from completed_at at time zone 'Europe/Moscow') between 0 and 4) "nightCount",
            (select count(*)::int from cooked where recipe_snapshot->>'servings' ~ '^[1-9][0-9]*$') "preciseCount",
            (select count(*)::int from cooked where 'seasonal'=any(tags)) "seasonalCount",
            (select count(*)::int from cooked where 'seasonal'=any(tags) and completed_at>=date_trunc('month',now())) "seasonalMonthCount",
            (select count(*)::int from meal.inventory_batches where created_by=${userId}::uuid) "batchCount",
            (select count(*)::int from meal.inventory_batches where created_by=${userId}::uuid and location_id is not null) "locatedBatchCount",
            (select count(*)::int from meal.inventory_batches where created_by=${userId}::uuid and archived_at is null) "activeBatchCount",
            (select coalesce(current_date-min(created_at::date),0)::int from meal.inventory_batches where created_by=${userId}::uuid and archived_at is null) "activeInventoryDays",
            (select count(*)::int from meal.inventory_batches where created_by=${userId}::uuid and kind='preserve') "preserveCount",
            (select count(distinct pr.id)::int from meal.plan_revisions pr join meal.meal_plans mp on mp.id=pr.plan_id where mp.created_by=${userId}::uuid and pr.status in('accepted','applied','completed')) "planCount",
            (select coalesce(max(days),0)::int from (select count(distinct pe.date) days from meal.plan_revisions pr join meal.meal_plans mp on mp.id=pr.plan_id join meal.plan_entries pe on pe.revision_id=pr.id where mp.created_by=${userId}::uuid group by pr.id)x) "maxPlanDays",
            (select count(*)::int from meal.shopping_lists sl where sl.created_by=${userId}::uuid and sl.status='completed' and exists(select 1 from meal.shopping_items si where si.list_id=sl.id and si.status='purchased')) "shoppingCount",
            (select count(*)::int from meal.shopping_lists sl join meal.data_scopes ds on ds.id=sl.scope_id where sl.created_by=${userId}::uuid and sl.status='completed' and ds.kind='family') "familyShoppingCount",
            (select count(*)::int from meal.receipts where created_by=${userId}::uuid and status in('committed','linked')) "receiptCount",
            (select count(*)::int from published) "publishedCount",
            (select count(*)::int from published where nullif(description,'') is not null and image_url is not null and has_ingredients and has_steps) "completeRecipeCount",
            (select coalesce(max(cooks),0)::int from independent) "maxIndependentCooks",
            (select coalesce(max(count),0)::int from (select count(*) count from published cross join lateral unnest(tags) tag where tag like 'series:%' group by tag)x) "seriesCount",
            (select count(*)::int from meal.recipe_comments rc where rc.author_id=${userId}::uuid and rc.removed_at is null and exists(select 1 from meal.comment_reactions cr where cr.comment_id=rc.id and cr.reaction in('helpful','useful'))) "helpfulCount",
            (select count(*)::int from meal.author_follows where author_id=${userId}::uuid and removed_at is null) "followerCount",
            (select count(*)::int from meal.author_follows where follower_id=${userId}::uuid and removed_at is null) "followingCount",
            (select count(*)::int from meal.reputation_events re where re.user_id=${userId}::uuid and re.reason='accepted-content-correction' and re.delta>0 and not exists(select 1 from meal.reputation_events rev where rev.reverses_id=re.id)) "correctionCount",
            (select count(*)::int from meal.allergen_reports ar where ar.user_id=${userId}::uuid and exists(select 1 from meal.moderation_cases mc join meal.moderation_decisions md on md.case_id=mc.id and md.action='approve' where mc.reporter_id=${userId}::uuid and mc.evidence->>'allergenReportId'=ar.id::text)) "allergenCount",
            (select count(*)::int from meal.catalog_proposals cp where cp.author_id=${userId}::uuid and cp.status='approved' and jsonb_typeof(cp.provenance->'sources')='array' and jsonb_array_length(cp.provenance->'sources')>0) "sourceCount",
            (select count(*)::int from meal.moderation_cases mc join meal.moderation_decisions md on md.case_id=mc.id and md.action='approve' where mc.reporter_id=${userId}::uuid and mc.kind in('recipe_image','product_image','image_improvement')) "photoCount",
            (select count(*)::int from meal.recipe_bookmarks where user_id=${userId}::uuid and removed_at is null) "bookmarkCount",
            (select count(*)::int from meal.cooking_attempts ca join meal.data_scopes ds on ds.id=ca.scope_id where ca.actor_id=${userId}::uuid and ca.status='completed' and ds.kind='family') "familyCookCount",
            (select coalesce(max(member_count),0)::int from (select count(distinct ca.actor_id) member_count from meal.cooking_attempts ca join meal.data_scopes ds on ds.id=ca.scope_id join family_ids f on f.family_id=ds.family_id where ca.status='completed' group by date_trunc('week',ca.completed_at))x) "familyWeeklyCooks",
            (select coalesce(max(days),0)::int from (select count(distinct pe.date) days from meal.plan_entries pe join meal.plan_revisions pr on pr.id=pe.revision_id join meal.meal_plans mp on mp.id=pr.plan_id join meal.data_scopes ds on ds.id=mp.scope_id join family_ids f on f.family_id=ds.family_id group by pr.id)x) "familyPlanDays",
            (select count(*)::int from meal.shopping_items si join meal.shopping_lists sl on sl.id=si.list_id where sl.created_by=${userId}::uuid and si.status in('purchased','completed') and coalesce((si.origin_snapshot->>'holiday')::boolean,false)) "holidayCount",
            (select count(*)::int from meal.cooking_attempts ca where ca.actor_id=${userId}::uuid and ca.status='completed' and coalesce((ca.output_snapshot->>'allInputsUsed')::boolean,false)) "everythingUsedCount",
            (select count(*)::int from meal.inventory_batches ib where ib.created_by=${userId}::uuid and ib.archived_at is null and ib.expiry_on is not null and ib.expiry_on<current_date) "expiredActiveCount"
        `.execute(tx);
        return result.rows[0]!;
    }

    async reverseReputationEvent(eventId: string, reason: string) {
        return this.database.transaction(async (tx) => {
            const original = await sql<{
                id: string;
                userId: string;
                delta: number;
                ruleVersion: string;
                evidence: unknown;
            }>`select id,user_id as "userId",delta::int,rule_version as "ruleVersion",evidence from meal.reputation_events where id=${eventId}::uuid and reverses_id is null for update`.execute(
                tx,
            );
            const row = original.rows[0];
            if (!row) throw new NotFoundException('Событие репутации не найдено');
            const prior = await sql<{
                id: string;
            }>`select id from meal.reputation_events where reverses_id=${eventId}::uuid`.execute(tx);
            if (prior.rows[0]) return { eventId: prior.rows[0].id, created: false };
            const id = randomUUID();
            await sql`insert into meal.reputation_events(id,delta,rule_version,reason,evidence,recorded_at,user_id,reverses_id)
                values(${id}::uuid,${-row.delta},${row.ruleVersion},${reason},${JSON.stringify(row.evidence)}::jsonb,now(),${row.userId}::uuid,${row.id}::uuid)`.execute(
                tx,
            );
            return { eventId: id, created: true };
        });
    }

    async reverseReputationEventByKeyIn(tx: Tx, userId: string, qualifyingEventKey: string, reason: string) {
        await sql`select pg_advisory_xact_lock(hashtextextended(${qualifyingEventKey},0))`.execute(tx);
        const original = await sql<{
            id: string;
            delta: number;
            ruleVersion: string;
            evidence: unknown;
        }>`select re.id,re.delta::int,re.rule_version as "ruleVersion",re.evidence from meal.reputation_events re
            where re.user_id=${userId}::uuid and re.evidence->>'qualifyingEventKey'=${qualifyingEventKey}
              and not exists(select 1 from meal.reputation_events next where next.reverses_id=re.id)
            order by re.recorded_at desc,re.id desc limit 1`.execute(tx);
        const row = original.rows[0];
        if (!row || row.delta <= 0) return { eventId: row?.id ?? null, created: false };
        const id = randomUUID();
        await sql`insert into meal.reputation_events(id,delta,rule_version,reason,evidence,recorded_at,user_id,reverses_id)
            values(${id}::uuid,${-row.delta},${row.ruleVersion},${reason},${JSON.stringify(row.evidence)}::jsonb,now(),${userId}::uuid,${row.id}::uuid)`.execute(
            tx,
        );
        return { eventId: id, created: true };
    }

    private async publicAuthor(username: string) {
        const db = await this.db();
        const user = await sql<{
            id: string;
            username: string;
        }>`select id,login username from meal.users u where lower(login)=lower(${username}) and status='active' and archived_at is null and email_verified_at is not null
            and not exists(select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now())) limit 1`.execute(
            db,
        );
        if (!user.rows[0]) throw new NotFoundException('Автор не найден');
        if (!(await this.legalConsents.allowsFeatureAccess(user.rows[0].id, 'dissemination', db)))
            throw new NotFoundException('Автор не найден');
        // Awards are a materialized projection. Lazy synchronization makes historic data and
        // newly published aggregate rules visible without rewriting the source domain history.
        await this.database.transaction((tx) =>
            this.evaluateAchievementsIn(tx, user.rows[0]!.id, { trigger: 'public-profile-read' }),
        );
        const score = await sql<{
            score: number;
        }>`select coalesce(sum(delta),0)::int score from meal.reputation_events where user_id=${user.rows[0].id}::uuid`.execute(
            db,
        );
        const levels = (await this.publicLevels()).items;
        const currentScore = score.rows[0]?.score ?? 0;
        const currentIndex = Math.max(
            0,
            levels.findLastIndex((level) => level.threshold <= currentScore),
        );
        const current = levels[currentIndex]!;
        return {
            db,
            user: user.rows[0],
            score: currentScore,
            levels,
            rank: {
                id: String(current.level),
                title: current.title,
                minimumScore: current.threshold,
                nextMinimumScore: levels[currentIndex + 1]?.threshold ?? null,
            },
        };
    }

    async authorReputation(username: string) {
        const value = await this.publicAuthor(username);
        return authorReputationSchema.parse({
            profile: { username: value.user.username, avatarUrl: null },
            score: value.score,
            rank: value.rank,
            ranks: value.levels.map((level) => ({
                id: String(level.level),
                title: level.title,
                minimumScore: level.threshold,
            })),
            factors: [
                {
                    id: 'published-own-recipe',
                    title: '+5 за самостоятельный опубликованный рецепт',
                    icon: { assetId: null, fallbackKey: 'recipe', alt: 'Рецепт' },
                },
                {
                    id: 'accepted-content-correction',
                    title: '+2 за подтверждённое содержательное исправление',
                    icon: { assetId: null, fallbackKey: 'correction', alt: 'Исправление' },
                },
                {
                    id: 'first-independent-cook',
                    title: '+1 за первую независимую готовку рецепта',
                    icon: { assetId: null, fallbackKey: 'cook', alt: 'Готовка' },
                },
            ],
        });
    }

    async authorAchievements(username: string) {
        const value = await this.publicAuthor(username);
        const heads = await sql<{ code: string; payload: unknown; ruleId: string | null; awardedAt: Date | null }>`
            select h.resource_key code,h.payload,a.rule_id as "ruleId",a.awarded_at as "awardedAt"
            from meal.content_resource_heads h
            left join lateral (select aa.rule_id,aa.awarded_at from meal.achievement_awards aa join meal.achievement_rules ar on ar.id=aa.rule_id
                where aa.user_id=${value.user.id}::uuid and aa.revoked_at is null and ar.code=h.resource_key order by aa.awarded_at desc limit 1) a on true
            where h.resource_type='achievement' and not h.retired order by h.resource_key`.execute(value.db);
        const achievements = heads.rows.map((row) => {
            const payload = achievementPayloadSchema.parse(row.payload);
            const hidden = payload.secret && !row.ruleId;
            return {
                id: row.code,
                title: hidden ? 'Секретное достижение' : payload.title,
                description: hidden ? 'Условие откроется после получения.' : payload.description,
                category: payload.category,
                icon: hidden
                    ? { assetId: null, fallbackKey: 'achievement-secret', alt: 'Секретное достижение' }
                    : payload.icon,
                secret: payload.secret,
                status: row.ruleId ? ('earned' as const) : ('locked' as const),
                earnedAt: row.awardedAt ? iso(row.awardedAt) : null,
            };
        });
        const categories = [...new Set(achievements.map((item) => item.category))].map((id) => ({
            id,
            title: categoryTitle(id),
        }));
        return authorAchievementsSchema.parse({
            profile: { username: value.user.username, avatarUrl: null },
            reputation: { score: value.score, rank: value.rank },
            categories,
            achievements,
        });
    }
}
