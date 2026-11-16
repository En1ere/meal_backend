import { ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/public.js';
import { LegalConsentService } from '../legal-consents/public.js';
import {
    aiV2WeeklyRecommendationCandidateSchema,
    assertWeeklyRecommendationMonday,
    rankWeeklyRecommendations,
} from './ai-personal-recommendation.js';
import { aiV2PersonalRecommendationResultSchema, parseAiV2PreviewRequest } from './ai-v2.contracts.js';
import { aiV2TaskContractColumns, aiV2TaskPreviewSnapshot, prepareAiV2Preview } from './ai-v2-preview.js';

type Tx = Transaction<DatabaseSchema>;

const scopeEvidenceSchema = z.strictObject({
    scopeId: z.uuid(),
    scopeVersion: z.number().int().positive(),
    familyId: z.uuid().nullable(),
    familyVersion: z.number().int().positive().nullable(),
    membershipId: z.uuid().nullable(),
    membershipVersion: z.number().int().positive().nullable(),
});

const weeklySnapshotSchema = z.strictObject({
    contractVersion: z.literal(2),
    taskType: z.literal('personal_recommendation'),
    task: z.literal('personal_recommendation'),
    mode: z.literal('weekly'),
    input: z.strictObject({
        weekStartsOn: z.iso.date(),
        inventoryScope: z.enum(['personal', 'family']),
    }),
    sourceIds: z.tuple([]),
    expiresAt: z.iso.datetime(),
    artifactExpiresAt: z.iso.datetime(),
    sourceEvidence: scopeEvidenceSchema.extend({
        sourceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
        specialCategoryConsent: z.boolean(),
    }),
    result: aiV2PersonalRecommendationResultSchema,
});

const preferencesSchema = z.strictObject({
    diets: z.array(z.string().trim().min(1).max(80)).max(20),
    goals: z.array(z.string().trim().min(1).max(80)).max(20),
});

const boundedStrings = (value: unknown) =>
    Array.isArray(value)
        ? value
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter((item) => item.length > 0 && item.length <= 80)
              .slice(0, 20)
        : [];

@Injectable()
export class AiV2PersonalRecommendationInternalService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly consents: LegalConsentService,
    ) {}

    private async writable(tx: Tx, userId: string) {
        const user = await sql`
            select id from meal.users
             where id=${userId}::uuid and status='active' and archived_at is null for update
        `.execute(tx);
        if (!user.rows.length) throw new HttpException('Аккаунт недоступен', 403);
        const sanction = await sql`
            select id from meal.sanctions
             where user_id=${userId}::uuid and scope in('account','ai') and revoked_at is null
               and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1
        `.execute(tx);
        if (sanction.rows.length) throw new HttpException('Доступен только просмотр', 403);
    }

    private async dependencies(tx: Tx) {
        const rule = (
            await sql<{ id: string }>`
                select id from meal.ai_rule_versions where kind='cost' and version=4 and effective_at<=now() limit 1
            `.execute(tx)
        ).rows[0];
        if (!rule) throw new ServiceUnavailableException('AI v2 policies are not configured');
        return rule.id;
    }

    private async resolveScope(tx: Tx, userId: string, kind: 'personal' | 'family') {
        if (kind === 'personal') {
            const row = (
                await sql<{
                    scopeId: string;
                    scopeVersion: number;
                }>`
                    select id "scopeId",version::integer "scopeVersion" from meal.data_scopes
                     where kind='private' and user_id=${userId}::uuid limit 1
                `.execute(tx)
            ).rows[0];
            if (!row) throw new ConflictException('Личные рекомендации недоступны');
            return scopeEvidenceSchema.parse({
                ...row,
                familyId: null,
                familyVersion: null,
                membershipId: null,
                membershipVersion: null,
            });
        }
        const row = (
            await sql<{
                scopeId: string;
                scopeVersion: number;
                familyId: string;
                familyVersion: number;
                membershipId: string;
                membershipVersion: number;
            }>`
                select scope.id "scopeId",scope.version::integer "scopeVersion",
                       family.id "familyId",family.version::integer "familyVersion",
                       membership.id "membershipId",membership.version::integer "membershipVersion"
                  from meal.family_memberships membership
                  join meal.families family on family.id=membership.family_id
                  join meal.data_scopes scope on scope.kind='family' and scope.family_id=family.id
                 where membership.user_id=${userId}::uuid and membership.left_at is null
                   and family.status='active' and family.archived_at is null
                 order by membership.joined_at,scope.id limit 1
            `.execute(tx)
        ).rows[0];
        if (!row) throw new ConflictException('Семейные рекомендации недоступны');
        const entitlement = await this.entitlements.resolveFamily(userId, row.familyId, tx);
        if (!entitlement.capabilities.family) throw new HttpException('Семейный доступ приостановлен', 403);
        return scopeEvidenceSchema.parse(row);
    }

    private async sourceRows(tx: Tx, userId: string, scopeId: string) {
        const settings = (
            await sql<{
                id: string;
                version: number;
                diets: unknown;
                goals: unknown;
            }>`
                select id,version::integer,
                       coalesce(preferences->'diets','[]'::jsonb) diets,
                       coalesce(preferences->'goals','[]'::jsonb) goals
                  from meal.user_settings where user_id=${userId}::uuid limit 1
            `.execute(tx)
        ).rows[0];
        const preferences = preferencesSchema.parse({
            diets: boundedStrings(settings?.diets),
            goals: boundedStrings(settings?.goals),
        });
        const inventory = (
            await sql<{ id: string; version: number }>`
                select id,version::integer from meal.inventory_batches
                 where scope_id=${scopeId}::uuid and archived_at is null and (quantity is null or quantity>0)
                 order by id
            `.execute(tx)
        ).rows;
        const rows = (
            await sql<Record<string, unknown>>`
                with published as (
                    select distinct on(recipe.id)
                           recipe.id "recipeId",recipe.version::integer "recipeVersion",
                           revision.id "revisionId",revision.version::integer "revisionVersion",
                           publication.id "publicationId",publication.version::integer "publicationVersion",
                           revision.category,revision.tags,revision.timing,publication.published_at
                      from meal.recipes recipe
                      join meal.recipe_revisions revision on revision.recipe_id=recipe.id
                      join meal.recipe_publications publication on publication.revision_id=revision.id
                     where publication.unpublished_at is null and publication.published_at<=now()
                       and recipe.archived_at is null
                       and recipe.status not in('hidden','unpublished','deleted','archived')
                     order by recipe.id,publication.published_at desc,publication.id desc
                )
                select published.*,
                       (select avg(rating.value)::float8 from meal.recipe_ratings rating
                         where rating.recipe_id=published."recipeId") rating,
                       (select count(*)::integer from meal.recipe_ratings rating
                         where rating.recipe_id=published."recipeId") "ratingCount",
                       (select count(*)::integer from meal.recipe_ingredients line
                         where line.revision_id=published."revisionId" and not line.optional) "requiredCount",
                       (select count(*)::integer from meal.recipe_ingredients line
                         where line.revision_id=published."revisionId" and not line.optional
                           and exists(
                               select 1 from meal.inventory_batches batch
                               left join meal.brand_products product on product.id=batch.product_id
                               left join meal.ingredient_variants direct_variant on direct_variant.id=batch.variant_id
                               left join meal.ingredient_variants product_variant on product_variant.id=product.variant_id
                              where batch.scope_id=${scopeId}::uuid and batch.archived_at is null
                                and (batch.quantity is null or batch.quantity>0)
                                and ((line.product_id is not null and batch.product_id=line.product_id)
                                  or (line.product_id is null and line.variant_id is not null
                                    and coalesce(batch.variant_id,product.variant_id)=line.variant_id)
                                  or (line.product_id is null and line.variant_id is null
                                    and line.ingredient_id is not null
                                    and coalesce(batch.ingredient_id,direct_variant.ingredient_id,product_variant.ingredient_id)=line.ingredient_id))
                           )) "presentCount",
                       (select count(*)::integer from meal.recipe_ingredients line
                         where line.revision_id=published."revisionId" and not line.optional
                           and exists(
                               select 1 from meal.inventory_batches batch
                               left join meal.brand_products product on product.id=batch.product_id
                               left join meal.ingredient_variants direct_variant on direct_variant.id=batch.variant_id
                               left join meal.ingredient_variants product_variant on product_variant.id=product.variant_id
                              where batch.scope_id=${scopeId}::uuid and batch.archived_at is null
                                and batch.expiry_on between current_date and current_date+14
                                and ((line.product_id is not null and batch.product_id=line.product_id)
                                  or (line.product_id is null and line.variant_id is not null
                                    and coalesce(batch.variant_id,product.variant_id)=line.variant_id)
                                  or (line.product_id is null and line.variant_id is null
                                    and line.ingredient_id is not null
                                    and coalesce(batch.ingredient_id,direct_variant.ingredient_id,product_variant.ingredient_id)=line.ingredient_id))
                           )) "expiringCount",
                       (select count(*)::integer from meal.cooking_attempts attempt
                         join meal.recipe_revisions cooked on cooked.id=attempt.revision_id
                        where attempt.actor_id=${userId}::uuid and attempt.status='completed'
                          and cooked.recipe_id=published."recipeId") "completedCount",
                       (select extract(day from now()-max(attempt.completed_at))::integer
                          from meal.cooking_attempts attempt
                          join meal.recipe_revisions cooked on cooked.id=attempt.revision_id
                         where attempt.actor_id=${userId}::uuid and attempt.status='completed'
                           and cooked.recipe_id=published."recipeId") "daysSinceCooked"
                  from published
                 where not exists(
                       select 1 from meal.recommendation_events event
                        where event.user_id=${userId}::uuid and event.entity_type='recipe'
                          and event.entity_key=published."recipeId"::text
                          and event.event_kind in('not_interested','not_suitable')
                 )
                 order by published_at desc,"recipeId" limit 200
            `.execute(tx)
        ).rows;
        const candidates = rows.map((row) => {
            const timing = z
                .object({ durationMinutes: z.number().int().nonnegative().nullable().optional() })
                .safeParse(row.timing);
            return aiV2WeeklyRecommendationCandidateSchema.parse({
                recipeId: row.recipeId,
                recipeVersion: Number(row.recipeVersion),
                revisionId: row.revisionId,
                revisionVersion: Number(row.revisionVersion),
                publicationId: row.publicationId,
                publicationVersion: Number(row.publicationVersion),
                category: typeof row.category === 'string' ? row.category : null,
                tags: boundedStrings(row.tags).slice(0, 30),
                durationMinutes: timing.success ? (timing.data.durationMinutes ?? null) : null,
                rating: row.rating === null ? null : Number(row.rating),
                ratingCount: Number(row.ratingCount ?? 0),
                requiredCount: Number(row.requiredCount ?? 0),
                presentCount: Number(row.presentCount ?? 0),
                expiringCount: Number(row.expiringCount ?? 0),
                completedCount: Number(row.completedCount ?? 0),
                daysSinceCooked: row.daysSinceCooked === null ? null : Number(row.daysSinceCooked),
            });
        });
        return {
            settings: settings ? { id: settings.id, version: settings.version } : null,
            preferences,
            inventory,
            candidates,
        };
    }

    private artifactExpiry(weekStartsOn: string, now: Date) {
        const weekEnd = new Date(`${weekStartsOn}T00:00:00.000Z`);
        weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
        const minimum = new Date(now.getTime() + 10 * 60_000);
        const maximum = new Date(now.getTime() + 30 * 86_400_000);
        return new Date(Math.min(maximum.getTime(), Math.max(minimum.getTime(), weekEnd.getTime())));
    }

    async weekly(userId: string, raw: unknown) {
        const request = parseAiV2PreviewRequest(raw);
        if (request.task !== 'personal_recommendation' || request.mode !== 'weekly')
            throw new ConflictException('Internal weekly recommendation task expected');
        const input = z
            .strictObject({
                weekStartsOn: z.iso.date(),
                inventoryScope: z.enum(['personal', 'family']),
            })
            .parse(request.input);
        try {
            assertWeeklyRecommendationMonday(input.weekStartsOn);
        } catch {
            throw new ConflictException('Неделя должна начинаться в понедельник');
        }
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            await sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${input.weekStartsOn}:${input.inventoryScope}`},0))`.execute(
                tx,
            );
            const entitlement = await this.entitlements.resolve(userId, tx);
            const scope = await this.resolveScope(tx, userId, input.inventoryScope);
            const specialCategoryConsent = await this.consents.allowsFeatureAccess(userId, 'special_category', tx);
            const sources = await this.sourceRows(tx, userId, scope.scopeId);
            const sourceSnapshotHash = createHash('sha256')
                .update(
                    JSON.stringify({
                        scope,
                        settings: sources.settings,
                        preferences: sources.preferences,
                        inventory: sources.inventory,
                        candidates: sources.candidates,
                        specialCategoryConsent,
                    }),
                )
                .digest('hex');
            const cached = (
                await sql<{ preview: unknown }>`
                    select task.preview from meal.ai_tasks task
                    join meal.ai_conversations conversation on conversation.id=task.conversation_id
                     where conversation.user_id=${userId}::uuid and task.contract_version=2
                       and task.task_code='personal_recommendation' and task.task_mode='weekly'
                       and task.status='completed' and task.source_snapshot_hash=${sourceSnapshotHash}
                       and task.preview->'input'->>'weekStartsOn'=${input.weekStartsOn}
                       and task.preview->'input'->>'inventoryScope'=${input.inventoryScope}
                       and (task.preview->>'artifactExpiresAt')::timestamptz>now()
                     order by task.created_at desc limit 1
                `.execute(tx)
            ).rows[0];
            if (cached) {
                const snapshot = weeklySnapshotSchema.parse(cached.preview);
                if (snapshot.sourceEvidence.scopeId !== scope.scopeId)
                    throw new ConflictException('Область рекомендаций изменилась');
                return {
                    cacheHit: true as const,
                    artifactExpiresAt: snapshot.artifactExpiresAt,
                    result: snapshot.result,
                };
            }
            const result = aiV2PersonalRecommendationResultSchema.parse({
                schemaVersion: 'ai-result-contract-v2:personal_recommendation:weekly',
                weekStartsOn: input.weekStartsOn,
                inventoryScope: input.inventoryScope,
                algorithmVersion: 'weekly-backend-v1',
                items: rankWeeklyRecommendations(sources.candidates, sources.preferences),
                warningCodes: ['allergen_profile_not_applied'],
            });
            const now = new Date();
            const artifactExpiresAt = this.artifactExpiry(input.weekStartsOn, now).toISOString();
            const previewId = randomUUID();
            const prepared = prepareAiV2Preview(
                { task: 'personal_recommendation', mode: 'weekly', input },
                {
                    plan: entitlement.plan,
                    offeredSources: [],
                    readyProviderProfileVersions: new Set(),
                    sourceSnapshotHash,
                    now,
                    previewId,
                },
            );
            const snapshot = weeklySnapshotSchema.parse({
                ...aiV2TaskPreviewSnapshot(prepared),
                artifactExpiresAt,
                sourceEvidence: {
                    ...scope,
                    sourceSnapshotHash,
                    specialCategoryConsent,
                },
                result,
            });
            const ruleId = await this.dependencies(tx);
            const conversationId = randomUUID();
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: 'Рекомендации на неделю',
                    archived_at: null,
                    user_id: userId,
                    scope_id: scope.scopeId,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: previewId,
                    goal: input.weekStartsOn,
                    status: 'completed',
                    preview: sql`${JSON.stringify(snapshot)}::jsonb`,
                    accepted_at: now,
                    agreement_snapshot: {
                        version: 'ai-v2-backend-weekly-recommendation',
                        externalProviderUsed: false,
                        consentEvidence: [],
                    },
                    conversation_id: conversationId,
                    rule_id: ruleId,
                    ...aiV2TaskContractColumns(prepared.frozen),
                })
                .execute();
            return { cacheHit: false as const, artifactExpiresAt, result };
        });
    }
}
