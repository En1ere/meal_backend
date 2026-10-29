import { Injectable, HttpException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { RecipePolicyService } from '../recipe-policy/recipe-policy.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { LegalConsentService } from '../legal-consents/legal-consent.service.js';
import { recipeNutritionSchema } from '../recipes/recipes.contracts.js';
import { RecipeLifecycleService } from '../recipe-lifecycle/recipe-lifecycle.service.js';
import { ContentReleasesService } from '../content-releases/content-releases.service.js';
import { workspaceNutrition, workspaceIngredientSource, type WorkspaceComposition } from './recipe-workspace.domain.js';
import {
    workspaceRecipeSchema,
    assertSubmittable,
    type WorkspaceDocument,
    type WorkspaceRecipe,
    workspaceQuerySchema,
    workspaceCreateSchema,
    workspaceSaveSchema,
    workspaceCommandSchema,
    workspaceVariantSchema,
    workspaceRatingSchema,
    workspaceCommentSchema,
    workspaceCommentEditSchema,
    workspaceReportSchema,
    workspaceReportsQuerySchema,
    workspaceReportDetailSchema,
    workspaceNutritionSchema,
} from './recipe-workspace.contracts.js';
type Tx = Transaction<DatabaseSchema>;
type Row = Record<string, unknown>;
const fail = (message: string, status = 409): never => {
    throw new HttpException(message, status);
};
const date = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
@Injectable()
export class RecipeWorkspaceService {
    constructor(
        private readonly database: DatabaseService,
        private readonly policy: RecipePolicyService,
        private readonly entitlements: EntitlementsService,
        private readonly legalConsents: LegalConsentService,
        private readonly lifecycle: RecipeLifecycleService,
        @Optional() private readonly releases?: ContentReleasesService,
    ) {}
    reports(user: string, input: z.infer<typeof workspaceReportsQuerySchema>) {
        return this.run(user, false, async (tx) => {
            const source = sql`from meal.moderation_cases m left join meal.recipe_revisions r on r.id=m.recipe_revision_id left join meal.recipe_comments c on c.id=m.comment_id where m.reporter_id=${user}::uuid and m.kind='report' and coalesce(r.recipe_id,c.recipe_id) is not null`;
            const items =
                await sql<Row>`select m.id,coalesce(r.recipe_id,c.recipe_id) as "recipeId",m.reason,m.status,m.submitted_at as "submittedAt" ${source} order by m.submitted_at desc,m.id limit ${input.limit} offset ${(input.page - 1) * input.limit}`.execute(
                    tx,
                );
            const count = await sql<{ total: number }>`select count(*)::int total ${source}`.execute(tx);
            return {
                items: items.rows.map((r) => ({ ...r, submittedAt: date(r.submittedAt) })),
                total: count.rows[0]?.total ?? 0,
                page: input.page,
                limit: input.limit,
            };
        });
    }
    reportDetail(user: string, id: string) {
        return this.run(user, false, async (tx) => {
            const row = (
                await sql<Row>`select m.id,m.reason,m.status,m.submitted_at as "submittedAt",
                case when exists(select 1 from meal.recipes recipe join meal.recipe_revisions revision on revision.recipe_id=recipe.id join meal.recipe_publications publication on publication.revision_id=revision.id where recipe.id=coalesce(r.recipe_id,c.recipe_id) and recipe.archived_at is null and recipe.status not in('hidden','unpublished','deleted','archived') and publication.unpublished_at is null and publication.published_at<=now()) then coalesce(r.recipe_id,c.recipe_id) else null end as "recipeId"
                from meal.moderation_cases m left join meal.recipe_revisions r on r.id=m.recipe_revision_id left join meal.recipe_comments c on c.id=m.comment_id where m.id=${id}::uuid and m.reporter_id=${user}::uuid and m.kind='report'`.execute(
                    tx,
                )
            ).rows[0];
            if (!row) return fail('Жалоба не найдена', 404);
            return workspaceReportDetailSchema.parse({ ...row, submittedAt: date(row.submittedAt) });
        });
    }
    private async run<T>(user: string, write: boolean, work: (tx: Tx) => Promise<T>, scope = 'account'): Promise<T> {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.transaction(async (tx) => {
            const actor =
                await sql`select id from meal.users where id=${user}::uuid and status='active' and archived_at is null for update`.execute(
                    tx,
                );
            if (!actor.rows.length) fail('Аккаунт недоступен', 403);
            if (write) {
                const bans =
                    await sql`select id from meal.sanctions where user_id=${user}::uuid and scope in ('account',${scope}) and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                        tx,
                    );
                if (bans.rows.length) fail('Доступен только просмотр', 403);
            }
            return work(tx);
        });
    }
    private async mutate<T extends object>(
        tx: Tx,
        user: string,
        target: string,
        operation: string,
        input: { idempotencyKey: string },
        work: () => Promise<T>,
    ): Promise<T> {
        const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const prior = await tx
            .selectFrom('idempotency_records')
            .select(['request_hash', 'response_snapshot'])
            .where('actor_namespace', '=', `user:${user}`)
            .where('operation', '=', operation)
            .where('target_binding', '=', target)
            .where('key', '=', input.idempotencyKey)
            .executeTakeFirst();
        if (prior) {
            if (prior.request_hash !== hash) fail('Ключ использован для другого запроса');
            return prior.response_snapshot as T;
        }
        const result = await work();
        const resultId = z
            .object({ id: z.uuid().optional(), recipe: z.object({ id: z.uuid() }).optional() })
            .parse(result);
        const auditTarget = resultId.recipe?.id ?? resultId.id ?? target;
        await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,reason,before_redacted,after_redacted,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,${operation},'recipe-workspace',${auditTarget}::uuid,now(),now(),null,null,${JSON.stringify({ operation, targetId: auditTarget })}::jsonb,${input.idempotencyKey},${user}::uuid,null)`.execute(
            tx,
        );
        await sql`insert into meal.idempotency_records(id,operation,target_binding,key,request_hash,status,response_snapshot,expires_at,user_id,scope_id,actor_namespace) values(${randomUUID()}::uuid,${operation},${target},${input.idempotencyKey},${hash},'completed',${JSON.stringify(result)}::jsonb,'infinity',${user}::uuid,null,${`user:${user}`})`.execute(
            tx,
        );
        return result;
    }
    private async owned(tx: Tx, user: string, id: string, expected?: number) {
        const row = (
            await sql<Row>`select r.id,r.status,r.archived_at,r.version,r.base_recipe_id,r.scope_id,s.kind as scope_kind,s.family_id,case when u.status='active' and u.archived_at is null then u.login else null end as author_login,r.author_id,${user}::uuid as viewer_id from meal.recipes r join meal.data_scopes s on s.id=r.scope_id join meal.users u on u.id=r.author_id where r.id=${id}::uuid and r.author_id=${user}::uuid and r.status<>'deleted' and ((s.kind='private' and s.user_id=${user}::uuid) or (s.kind='family' and exists(select 1 from meal.family_memberships fm join meal.families f on f.id=fm.family_id where fm.family_id=s.family_id and fm.user_id=${user}::uuid and fm.left_at is null and f.status='active'))) for update of r`.execute(
                tx,
            )
        ).rows[0];
        if (!row) return fail('Рецепт не найден', 404);
        if (row.scope_kind === 'family') {
            const access = await this.entitlements.resolveFamily(user, String(row.family_id), tx);
            if (!access.capabilities.family) fail('Семейный доступ приостановлен', 403);
        }
        if (expected !== undefined && Number(row.version) !== expected) fail('Рецепт изменён. Обновите страницу');
        return row;
    }
    private async scope(tx: Tx, user: string, kind: 'private' | 'family', createPrivate = false) {
        if (kind === 'family') {
            const family = (
                await sql<{
                    id: string;
                    familyId: string;
                }>`select s.id,f.id as "familyId" from meal.family_memberships fm join meal.families f on f.id=fm.family_id join meal.data_scopes s on s.kind='family' and s.family_id=f.id where fm.user_id=${user}::uuid and fm.left_at is null and f.status='active' limit 1`.execute(
                    tx,
                )
            ).rows[0];
            if (!family) return fail('Семья не найдена', 404);
            const access = await this.entitlements.resolveFamily(user, family.familyId, tx);
            if (!access.capabilities.family) fail('Семейный доступ приостановлен', 403);
            return family.id;
        }
        const scope = (
            await sql<{
                id: string;
            }>`select id from meal.data_scopes where kind='private' and user_id=${user}::uuid`.execute(tx)
        ).rows[0];
        if (scope) return scope.id;
        if (!createPrivate) return null;
        const id = randomUUID();
        await sql`insert into meal.data_scopes(id,kind,user_id,family_id) values(${id}::uuid,'private',${user}::uuid,null)`.execute(
            tx,
        );
        return id;
    }
    private async revision(tx: Tx, recipe: Row, revisionId?: string): Promise<WorkspaceRecipe> {
        const rr = (
            await sql<Row>`select id,revision,title,portions,method,description,category,tags,nutrition_snapshot from meal.recipe_revisions where recipe_id=${String(recipe.id)}::uuid and (${revisionId ?? null}::uuid is null or id=${revisionId ?? null}::uuid) order by revision desc limit 1`.execute(
                tx,
            )
        ).rows[0];
        if (!rr) return fail('Версия рецепта не найдена', 404);
        const lines =
            await sql<Row>`select ri.ingredient_id as "ingredientId",ri.variant_id as "variantId",ri.product_id as "productId",ri.source_recipe_id as "sourceRecipeId",ri.quantity::text,u.code as unit,ri.optional from meal.recipe_ingredients ri left join meal.units u on u.id=ri.unit_id where ri.revision_id=${String(rr.id)}::uuid order by ri.position,ri.id`.execute(
                tx,
            );
        const steps =
            await sql<Row>`select text,duration_seconds as "durationSeconds",temperature::text from meal.recipe_steps where revision_id=${String(rr.id)}::uuid order by position,id`.execute(
                tx,
            );
        const wrapped = workspaceNutritionSchema.safeParse(rr.nutrition_snapshot),
            raw = recipeNutritionSchema.safeParse(rr.nutrition_snapshot);
        const lifecycle = await this.lifecycle.projection(tx, String(recipe.id), String(rr.id), String(recipe.status));
        return workspaceRecipeSchema.parse({
            nutrition: wrapped.success
                ? wrapped.data
                : {
                      status: raw.success ? 'calculated' : 'unavailable',
                      base: raw.success ? raw.data : null,
                      uncoveredIngredientIds: [],
                  },
            id: recipe.id,
            revisionId: rr.id,
            version: Number(recipe.version),
            revision: rr.revision,
            status: lifecycle.review.status,
            review: lifecycle.review,
            publication: lifecycle.publication,
            archived: !!recipe.archived_at,
            baseRecipeId: recipe.base_recipe_id,
            availabilityScope: recipe.scope_kind,
            authorLogin: recipe.author_login,
            canEdit: recipe.author_id === recipe.viewer_id,
            document: {
                title: rr.title,
                description: rr.description,
                category: rr.category,
                tags: rr.tags,
                baseServings: rr.portions,
                method: rr.method,
                ingredients: lines.rows.map((line) => ({ ...line, ...workspaceIngredientSource(line) })),
                steps: steps.rows,
            },
        });
    }
    private async validateSources(
        tx: Tx,
        user: string,
        document: WorkspaceDocument,
        scopeId: string,
        scopeKind: 'private' | 'family',
    ) {
        for (const line of document.ingredients) {
            if (line.unit) {
                const unit = await sql`select id from meal.units where code=${line.unit}`.execute(tx);
                if (!unit.rows.length) fail('Неизвестная единица измерения', 422);
            }
            let rows: unknown[] = [];
            if (line.productId)
                rows = (
                    await sql`select p.id from meal.brand_products p where p.id=${line.productId}::uuid and (p.status in ('active','approved','published') or (${scopeKind}='private' and p.id in(select product_id from meal.catalog_proposals where author_id=${user}::uuid and status in ('draft','pending','submitted','needs_changes'))))`.execute(
                        tx,
                    )
                ).rows;
            else if (line.variantId)
                rows = (
                    await sql`select v.id from meal.ingredient_variants v where v.id=${line.variantId}::uuid and (v.status in ('active','approved','published') or (${scopeKind}='private' and exists(select 1 from meal.brand_products p join meal.catalog_proposals c on c.product_id=p.id where p.variant_id=v.id and c.author_id=${user}::uuid and c.status in ('draft','pending','submitted','needs_changes'))))`.execute(
                        tx,
                    )
                ).rows;
            else if (line.ingredientId)
                rows = (
                    await sql`select i.id from meal.ingredients i where i.id=${line.ingredientId}::uuid and (i.status in ('active','approved','published') or (${scopeKind}='private' and exists(select 1 from meal.ingredient_variants v join meal.brand_products p on p.variant_id=v.id join meal.catalog_proposals c on c.product_id=p.id where v.ingredient_id=i.id and c.author_id=${user}::uuid and c.status in ('draft','pending','submitted','needs_changes'))))`.execute(
                        tx,
                    )
                ).rows;
            else
                rows = (
                    await sql`select r.id from meal.recipes r join meal.data_scopes s on s.id=r.scope_id where r.id=${line.sourceRecipeId}::uuid and r.archived_at is null and r.status not in ('hidden','deleted','unpublished') and ((r.scope_id=${scopeId}::uuid and (${scopeKind}='family' or r.author_id=${user}::uuid)) or exists(select 1 from meal.recipe_revisions rr join meal.recipe_publications p on p.revision_id=rr.id where rr.recipe_id=r.id and p.unpublished_at is null and p.published_at<=now()))`.execute(
                        tx,
                    )
                ).rows;
            if (!rows.length) fail('Ингредиент недоступен', 422);
        }
    }
    private async append(
        tx: Tx,
        user: string,
        id: string,
        document: WorkspaceDocument,
        kind: string,
        scopeId: string,
        scopeKind: 'private' | 'family',
        previous?: unknown,
    ) {
        await this.validateSources(tx, user, document, scopeId, scopeKind);
        const compositions: Array<WorkspaceComposition | null> = [];
        for (const line of document.ingredients) {
            if (line.sourceRecipeId) {
                compositions.push(null);
                continue;
            }
            const row = (
                await sql<WorkspaceComposition>`select c.kcal::text,c.protein::text,c.fat::text,c.carbs::text,c.basis_quantity::text as quantity,u.code as unit from meal.composition_versions c join meal.units u on u.id=c.basis_unit_id where (${line.productId}::uuid is not null and c.product_id=${line.productId}::uuid) or (${line.productId}::uuid is null and ${line.variantId}::uuid is not null and c.variant_id=${line.variantId}::uuid) or (${line.productId}::uuid is null and ${line.variantId}::uuid is null and c.ingredient_id=${line.ingredientId}::uuid) order by c.revision desc,c.id limit 1`.execute(
                    tx,
                )
            ).rows[0];
            compositions.push(row ?? null);
        }
        const last =
            previous ??
            (
                await sql<{
                    nutrition_snapshot: unknown;
                }>`select nutrition_snapshot from meal.recipe_revisions where recipe_id=${id}::uuid order by revision desc limit 1`.execute(
                    tx,
                )
            ).rows[0]?.nutrition_snapshot;
        const nutrition = workspaceNutrition(document, compositions, last);
        const revisionId = randomUUID();
        await sql`insert into meal.recipe_revisions(id,revision,title,portions,method,nutrition_snapshot,timing,change_kind,recipe_id,created_by,description,category,image_url,tags) select ${revisionId}::uuid,coalesce(max(revision),0)+1,${document.title},${document.baseServings},${document.method},${JSON.stringify(nutrition.status === 'calculated' ? nutrition.base : nutrition)}::jsonb,null,${kind},${id}::uuid,${user}::uuid,${document.description},${document.category},null,${document.tags}::text[] from meal.recipe_revisions where recipe_id=${id}::uuid`.execute(
            tx,
        );
        for (const [i, line] of document.ingredients.entries())
            await sql`insert into meal.recipe_ingredients(id,position,quantity,optional,requirements,substitution_rules,revision_id,ingredient_id,variant_id,product_id,source_recipe_id,unit_id) values(${randomUUID()}::uuid,${i + 1},${line.quantity}::numeric,${line.optional},null,null,${revisionId}::uuid,${line.ingredientId}::uuid,${line.variantId}::uuid,${line.productId}::uuid,${line.sourceRecipeId}::uuid,(select id from meal.units where code=${line.unit}))`.execute(
                tx,
            );
        for (const [i, step] of document.steps.entries())
            await sql`insert into meal.recipe_steps(id,position,text,duration_seconds,temperature,equipment_requirements,revision_id) values(${randomUUID()}::uuid,${i + 1},${step.text},${step.durationSeconds},${step.temperature}::numeric,null,${revisionId}::uuid)`.execute(
                tx,
            );
        return revisionId;
    }
    list(user: string, input: z.infer<typeof workspaceQuerySchema>) {
        return this.run(user, false, async (tx) => {
            const scope = await this.scope(tx, user, input.scope);
            if (!scope) return { items: [], total: 0, page: input.page, limit: input.limit };
            const filter = sql`r.scope_id=${scope}::uuid and (${input.scope}='family' or r.author_id=${user}::uuid) and r.status<>'deleted' and (r.archived_at is not null)=${input.status === 'archived'} and position(lower(${input.q}) in lower(r.title))>0`;
            const rows =
                await sql<Row>`select r.id,r.status,r.archived_at,r.version,r.base_recipe_id,r.scope_id,s.kind as scope_kind,s.family_id,case when u.status='active' and u.archived_at is null then u.login else null end as author_login,r.author_id,${user}::uuid as viewer_id from meal.recipes r join meal.data_scopes s on s.id=r.scope_id join meal.users u on u.id=r.author_id where ${filter} order by r.created_at desc,r.id limit ${input.limit} offset ${(input.page - 1) * input.limit}`.execute(
                    tx,
                );
            const count = await sql<{
                total: number;
            }>`select count(*)::int total from meal.recipes r join meal.data_scopes s on s.id=r.scope_id where ${filter}`.execute(
                tx,
            );
            const items = [];
            for (const row of rows.rows) items.push(await this.revision(tx, row));
            return { items, total: count.rows[0]?.total ?? 0, page: input.page, limit: input.limit };
        });
    }
    detail(user: string, id: string, input: { scope: 'private' | 'family' }) {
        return this.run(user, false, async (tx) => {
            const scope = await this.scope(tx, user, input.scope);
            if (!scope) fail('Рецепт не найден', 404);
            const recipe = (
                await sql<Row>`select r.id,r.status,r.archived_at,r.version,r.base_recipe_id,r.scope_id,s.kind as scope_kind,s.family_id,case when u.status='active' and u.archived_at is null then u.login else null end as author_login,r.author_id,${user}::uuid as viewer_id from meal.recipes r join meal.data_scopes s on s.id=r.scope_id join meal.users u on u.id=r.author_id where r.id=${id}::uuid and r.scope_id=${scope}::uuid and r.status<>'deleted' and (${input.scope}='family' or r.author_id=${user}::uuid)`.execute(
                    tx,
                )
            ).rows[0];
            if (!recipe) return fail('Рецепт не найден', 404);
            return { recipe: await this.revision(tx, recipe) };
        });
    }
    create(user: string, input: z.infer<typeof workspaceCreateSchema>) {
        return this.run(user, true, (tx) =>
            this.mutate(tx, user, `new:${input.scope}`, 'recipe.create', input, async () => {
                const scope = await this.scope(tx, user, input.scope, true);
                if (!scope) return fail('Область рецепта не найдена', 404);
                const id = randomUUID();
                await sql`insert into meal.recipes(id,title,status,archived_at,author_id,scope_id,base_recipe_id) values(${id}::uuid,${input.document.title},'draft',null,${user}::uuid,${scope}::uuid,null)`.execute(
                    tx,
                );
                await this.append(tx, user, id, input.document, 'created', scope, input.scope);
                return { recipe: await this.revision(tx, await this.owned(tx, user, id)) };
            }),
        );
    }
    save(user: string, id: string, input: z.infer<typeof workspaceSaveSchema>) {
        return this.run(user, true, (tx) =>
            this.mutate(tx, user, id, 'recipe.save', input, async () => {
                const r = await this.owned(tx, user, id, input.expectedVersion);
                if (r.archived_at || r.status === 'hidden') fail('Рецепт недоступен для изменения');
                if (input.document.ingredients.some((i) => i.sourceRecipeId === id))
                    fail('Рецепт не может содержать себя', 422);
                await this.append(
                    tx,
                    user,
                    id,
                    input.document,
                    'edited',
                    String(r.scope_id),
                    r.scope_kind as 'private' | 'family',
                );
                await sql`update meal.recipes set title=${input.document.title},status='draft',version=version+1 where id=${id}::uuid`.execute(
                    tx,
                );
                return { recipe: await this.revision(tx, await this.owned(tx, user, id)) };
            }),
        );
    }
    command(
        user: string,
        id: string,
        action: 'archive' | 'restore' | 'submit' | 'rollback',
        input: z.infer<typeof workspaceCommandSchema>,
    ) {
        return this.run(
            user,
            true,
            async (tx) => {
                if (action === 'submit')
                    await this.legalConsents.assertFeatureAccess(user, 'dissemination', 'recipe.publication', tx);
                return this.mutate(tx, user, id, `recipe.${action}`, input, async () => {
                    const r = await this.owned(tx, user, id, input.expectedVersion);
                    if (action === 'submit') {
                        if (r.archived_at || r.status === 'hidden')
                            fail('Архивный или скрытый рецепт нельзя отправить');
                        const recipe = await this.revision(tx, r);
                        try {
                            assertSubmittable(recipe.document);
                        } catch (e) {
                            fail(e instanceof Error ? e.message : 'Заполните рецепт', 422);
                        }
                        const pending =
                            await sql`select id from meal.moderation_cases where recipe_revision_id=${recipe.revisionId}::uuid and kind='recipe'`.execute(
                                tx,
                            );
                        if (pending.rows.length) fail('Эта версия уже отправлялась на проверку');
                        await this.policy.assertAllowance(tx, user, 'submission');
                        await this.case(tx, user, recipe.revisionId, null, 'publication', null, 'recipe');
                        await sql`update meal.recipes set status='pending',version=version+1 where id=${id}::uuid`.execute(
                            tx,
                        );
                    } else if (action === 'rollback') {
                        if (r.archived_at || r.status === 'hidden') fail('Рецепт недоступен для изменения');
                        const prev = (
                            await sql<{
                                id: string;
                            }>`select id from meal.recipe_revisions where recipe_id=${id}::uuid order by revision desc offset 1 limit 1`.execute(
                                tx,
                            )
                        ).rows[0];
                        if (!prev) return fail('Предыдущая версия отсутствует');
                        const previous = await this.revision(tx, r, prev.id);
                        await this.append(
                            tx,
                            user,
                            id,
                            previous.document,
                            'rollback',
                            String(r.scope_id),
                            r.scope_kind as 'private' | 'family',
                            previous.nutrition,
                        );
                        await sql`update meal.recipes set title=${previous.document.title},status='draft',version=version+1 where id=${id}::uuid`.execute(
                            tx,
                        );
                    } else {
                        const archive = action === 'archive' ? await this.lifecycle.archive(tx, id, user) : null;
                        if (archive?.closed)
                            await this.releases?.reverseReputationEventByKeyIn(
                                tx,
                                archive.authorId,
                                `recipe-published:${archive.recipeId}`,
                                'published-own-recipe-reversed',
                            );
                        await sql`update meal.recipes set archived_at=${action === 'archive' ? new Date() : null},
                            status=case when ${archive?.closed ?? false}::boolean then 'unpublished' else status end,version=version+1 where id=${id}::uuid`.execute(
                            tx,
                        );
                    }
                    return { recipe: await this.revision(tx, await this.owned(tx, user, id)) };
                });
            },
            action === 'submit' ? 'publications' : 'account',
        );
    }
    private async visible(tx: Tx, user: string, id: string) {
        const row = (
            await sql<Row>`select r.id,r.status,r.archived_at,r.version,r.base_recipe_id,r.scope_id,s.kind as scope_kind,s.family_id,case when u.status='active' and u.archived_at is null then u.login else null end as author_login,r.author_id,${user}::uuid as viewer_id,rr.id as revision_id,(s.kind='family' and exists(select 1 from meal.family_memberships fm join meal.families f on f.id=fm.family_id where fm.family_id=s.family_id and fm.user_id=${user}::uuid and fm.left_at is null and f.status='active')) as family_access,exists(select 1 from meal.recipe_publications p where p.revision_id=rr.id and p.unpublished_at is null and p.published_at<=now()) as public_access from meal.recipes r join meal.data_scopes s on s.id=r.scope_id join meal.users u on u.id=r.author_id join lateral(select x.id from meal.recipe_revisions x where x.recipe_id=r.id and ((r.author_id=${user}::uuid and s.kind='private' and s.user_id=${user}::uuid) or (s.kind='family' and exists(select 1 from meal.family_memberships fm join meal.families f on f.id=fm.family_id where fm.family_id=s.family_id and fm.user_id=${user}::uuid and fm.left_at is null and f.status='active')) or exists(select 1 from meal.recipe_publications p where p.revision_id=x.id and p.unpublished_at is null and p.published_at<=now())) order by x.revision desc limit 1)rr on true where r.id=${id}::uuid and r.archived_at is null and r.status not in ('hidden','deleted','unpublished')`.execute(
                tx,
            )
        ).rows[0];
        if (!row) return fail('Рецепт не найден', 404);
        if (row.scope_kind === 'family' && row.family_access && !row.public_access) {
            const access = await this.entitlements.resolveFamily(user, String(row.family_id), tx);
            if (!access.capabilities.family) fail('Семейный доступ приостановлен', 403);
        }
        return row;
    }
    variant(user: string, id: string, input: z.infer<typeof workspaceVariantSchema>) {
        return this.run(user, true, (tx) =>
            this.mutate(tx, user, id, 'recipe.variant', input, async () => {
                const source = await this.visible(tx, user, id),
                    base = await this.revision(tx, source, String(source.revision_id));
                const scope = await this.scope(tx, user, 'private', true);
                if (!scope) return fail('Личная область не найдена', 404);
                const next = randomUUID();
                await sql`insert into meal.recipes(id,title,status,archived_at,author_id,scope_id,base_recipe_id) values(${next}::uuid,${base.document.title},'draft',null,${user}::uuid,${scope}::uuid,${id}::uuid)`.execute(
                    tx,
                );
                await this.append(tx, user, next, base.document, 'variant', scope, 'private', base.nutrition);
                return { recipe: await this.revision(tx, await this.owned(tx, user, next)) };
            }),
        );
    }
    private async evidence(tx: Tx, user: string, id: string, attempt: string) {
        const result =
            await sql`select a.id from meal.cooking_attempts a join meal.recipe_revisions r on r.id=a.revision_id where a.id=${attempt}::uuid and a.actor_id=${user}::uuid and r.recipe_id=${id}::uuid and a.status='completed' and a.completed_at is not null`.execute(
                tx,
            );
        if (!result.rows.length) fail('Нужно подтверждённое приготовление этого рецепта', 403);
    }
    rating(user: string, id: string, input: z.infer<typeof workspaceRatingSchema>) {
        return this.run(user, true, async (tx) => {
            await this.legalConsents.assertFeatureAccess(user, 'dissemination', 'recipe.rating', tx);
            return this.mutate(tx, user, id, 'recipe.rating', input, async () => {
                await this.visible(tx, user, id);
                await this.evidence(tx, user, id, input.attemptId);
                const prior =
                    await sql`select id from meal.recipe_ratings where recipe_id=${id}::uuid and user_id=${user}::uuid`.execute(
                        tx,
                    );
                if (prior.rows.length) fail('Оценка уже зафиксирована');
                const rating = randomUUID();
                await sql`insert into meal.recipe_ratings(id,value,confirmed_at,recipe_id,user_id,attempt_id) values(${rating}::uuid,${input.value},now(),${id}::uuid,${user}::uuid,${input.attemptId}::uuid)`.execute(
                    tx,
                );
                return { id: rating };
            });
        });
    }
    private async case(
        tx: Tx,
        user: string,
        revision: string | null,
        commentId: string | null,
        reason: string,
        comment: string | null,
        kind = 'report',
    ) {
        const id = randomUUID(),
            critical = reason === 'dangerous' || reason === 'personal-data';
        await sql`insert into meal.moderation_cases(id,kind,status,reason,submitted_at,queue_priority,evidence,reporter_id,recipe_revision_id,catalog_proposal_revision_id,comment_id,asset_id,assigned_to) values(${id}::uuid,${kind},'pending',${reason},now(),${critical ? 100 : 0},${JSON.stringify({ comment })}::jsonb,${user}::uuid,${revision}::uuid,null,${commentId}::uuid,null,null)`.execute(
            tx,
        );
        return id;
    }
    comment(user: string, id: string, input: z.infer<typeof workspaceCommentSchema>) {
        return this.run(
            user,
            true,
            async (tx) => {
                await this.legalConsents.assertFeatureAccess(user, 'dissemination', 'recipe.comment', tx);
                return this.mutate(tx, user, id, 'recipe.comment', input, async () => {
                    await this.visible(tx, user, id);
                    await this.evidence(tx, user, id, input.attemptId);
                    let recipient: string | undefined;
                    if (input.replyToId) {
                        const parent = (
                            await sql<{
                                author_id: string;
                            }>`select author_id from meal.recipe_comments where id=${input.replyToId}::uuid and recipe_id=${id}::uuid and removed_at is null`.execute(
                                tx,
                            )
                        ).rows[0];
                        if (!parent) return fail('Комментарий для ответа недоступен', 404);
                        recipient = parent.author_id;
                    }
                    await this.policy.assertAllowance(tx, user, 'comment');
                    const commentId = randomUUID();
                    await sql`insert into meal.recipe_comments(id,body,edited_at,removed_at,recipe_id,author_id,attempt_id,reply_to_id) values(${commentId}::uuid,${input.body},null,null,${id}::uuid,${user}::uuid,${input.attemptId}::uuid,${input.replyToId}::uuid)`.execute(
                        tx,
                    );
                    if (recipient && recipient !== user)
                        await sql`insert into meal.notifications(id,category,priority,payload_minimized,dedup_key,available_at,read_at,fullscreen_seen_at,user_id,ownership_transfer_id,announcement_id) values(${randomUUID()}::uuid,'community','informational',${JSON.stringify({ type: 'recipe-comment-reply', recipeId: id, commentId })}::jsonb,${`recipe-comment:${commentId}`},now(),null,null,${recipient}::uuid,null,null)`.execute(
                            tx,
                        );
                    return { id: commentId };
                });
            },
            'comments',
        );
    }
    editComment(
        user: string,
        id: string,
        commentId: string,
        input: z.infer<typeof workspaceCommentEditSchema> | z.infer<typeof workspaceCommandSchema>,
    ) {
        return this.run(
            user,
            true,
            (tx) =>
                this.mutate(
                    tx,
                    user,
                    commentId,
                    'body' in input ? 'recipe.comment.edit' : 'recipe.comment.remove',
                    input,
                    async () => {
                        await this.visible(tx, user, id);
                        const current = (
                            await sql<Row>`select id,body,version,removed_at from meal.recipe_comments where id=${commentId}::uuid and recipe_id=${id}::uuid and author_id=${user}::uuid for update`.execute(
                                tx,
                            )
                        ).rows[0];
                        if (!current) return fail('Комментарий не найден', 404);
                        if (Number(current.version) !== input.expectedVersion || current.removed_at)
                            fail('Комментарий изменён или скрыт');
                        await sql`insert into meal.comment_revisions(id,body,revision,recorded_at,comment_id,author_id) select ${randomUUID()}::uuid,${String(current.body)},coalesce(max(revision),0)+1,now(),${commentId}::uuid,${user}::uuid from meal.comment_revisions where comment_id=${commentId}::uuid`.execute(
                            tx,
                        );
                        if ('body' in input)
                            await sql`update meal.recipe_comments set body=${input.body},edited_at=now(),version=version+1 where id=${commentId}::uuid and author_id=${user}::uuid`.execute(
                                tx,
                            );
                        else
                            await sql`update meal.recipe_comments set removed_at=now(),version=version+1 where id=${commentId}::uuid and author_id=${user}::uuid`.execute(
                                tx,
                            );
                        return { id: commentId };
                    },
                ),
            'comments',
        );
    }
    report(user: string, id: string, input: z.infer<typeof workspaceReportSchema>) {
        return this.run(user, true, (tx) =>
            this.mutate(tx, user, id, 'recipe.report', input, async () => {
                const recipe = await this.visible(tx, user, id);
                if (input.commentId) {
                    const c =
                        await sql`select id from meal.recipe_comments where id=${input.commentId}::uuid and recipe_id=${id}::uuid and removed_at is null`.execute(
                            tx,
                        );
                    if (!c.rows.length) fail('Комментарий недоступен', 404);
                }
                await this.policy.assertAllowance(tx, user, 'report');
                const reportId = await this.case(
                    tx,
                    user,
                    input.commentId ? null : String(recipe.revision_id),
                    input.commentId,
                    input.reason,
                    input.comment,
                );
                if (input.reason === 'dangerous' || input.reason === 'personal-data') {
                    await sql`insert into meal.moderation_decisions(id,action,reason,decided_at,before_snapshot,after_snapshot,case_id,actor_id) values(${randomUUID()}::uuid,'auto_hide',${input.reason},now(),${JSON.stringify(input.commentId ? { removedAt: null } : { status: recipe.status })}::jsonb,${JSON.stringify(input.commentId ? { removed: true } : { status: 'hidden' })}::jsonb,${reportId}::uuid,null)`.execute(
                        tx,
                    );
                    if (input.commentId)
                        await sql`update meal.recipe_comments set removed_at=now(),version=version+1 where id=${input.commentId}::uuid and recipe_id=${id}::uuid`.execute(
                            tx,
                        );
                    else {
                        const closed = await this.lifecycle.closeActive(tx, {
                            revisionId: String(recipe.revision_id),
                            status: 'hidden',
                            publicReason: 'Рецепт скрыт после критической жалобы.',
                            sourceCaseId: reportId,
                            actorId: null,
                            decisionAction: 'auto_hide',
                            decisionReason: 'Критическая жалоба закрыла активную публикацию',
                            allowAnyActiveRevision: true,
                            allowMissingPublication: true,
                        });
                        if (closed.publicationClosed)
                            await this.releases?.reverseReputationEventByKeyIn(
                                tx,
                                closed.authorId,
                                `recipe-published:${closed.recipeId}`,
                                'published-own-recipe-reversed',
                            );
                    }
                }
                return { id: reportId };
            }),
        );
    }
    community(user: string, id: string) {
        return this.run(user, false, async (tx) => {
            await this.visible(tx, user, id);
            const attempt = (
                await sql<{
                    id: string;
                }>`select a.id from meal.cooking_attempts a join meal.recipe_revisions r on r.id=a.revision_id where a.actor_id=${user}::uuid and r.recipe_id=${id}::uuid and a.status='completed' and a.completed_at is not null order by a.completed_at desc,a.id limit 1`.execute(
                    tx,
                )
            ).rows[0];
            const rating = (
                await sql<{
                    value: number;
                }>`select value from meal.recipe_ratings where recipe_id=${id}::uuid and user_id=${user}::uuid`.execute(
                    tx,
                )
            ).rows[0];
            const comments =
                await sql<Row>`select c.id,case when u.status='active' and u.archived_at is null then u.login else null end as "authorLogin",c.body,c.edited_at as "editedAt",c.created_at as "createdAt",c.version,c.author_id=${user}::uuid as "isOwn",c.reply_to_id as "replyToId" from meal.recipe_comments c join meal.users u on u.id=c.author_id where c.recipe_id=${id}::uuid and c.removed_at is null order by c.created_at,c.id limit 100`.execute(
                    tx,
                );
            const reports =
                await sql<Row>`select m.id,m.reason,m.status,m.submitted_at as "submittedAt" from meal.moderation_cases m left join meal.recipe_revisions r on r.id=m.recipe_revision_id left join meal.recipe_comments c on c.id=m.comment_id where m.reporter_id=${user}::uuid and m.kind='report' and (r.recipe_id=${id}::uuid or c.recipe_id=${id}::uuid) order by m.submitted_at desc,m.id limit 100`.execute(
                    tx,
                );
            return {
                attemptId: attempt?.id ?? null,
                rating: rating?.value ?? null,
                comments: comments.rows.map((c) => ({
                    ...c,
                    version: Number(c.version),
                    createdAt: date(c.createdAt),
                    editedAt: c.editedAt ? date(c.editedAt) : null,
                })),
                reports: reports.rows.map((r) => ({ ...r, submittedAt: date(r.submittedAt) })),
            };
        });
    }
}
