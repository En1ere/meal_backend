import { HttpException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { decimal, decimalText } from '../inventory/inventory.domain.js';
import { scaleRecipeQuantity } from '../recipes/recipes.domain.js';
import { scopedWorkflow, workflowReplay, type WorkflowTx } from '../cooking/workflow.store.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { DiaryService } from '../diary/diary.service.js';
import { recipeNutritionSchema } from '../recipes/recipes.contracts.js';
import {
    planSchema,
    type planChangeCommitSchema,
    type planChangePreviewSchema,
    type planShoppingCommitSchema,
    type planShoppingPreviewRequestSchema,
    type PlanEntry,
    type PlanMutation,
    type PlanQuery,
    type portionAssignSchema,
    type portionDecisionSchema,
    type portionScopeQuerySchema,
    type planAutomationPreviewSchema,
    type planAutomationCommitSchema,
} from './meal-plan.contracts.js';
import { createPlanToken, planRange, validPlanToken, weeklyDates } from './meal-plan.domain.js';

type InternalEntry = PlanEntry & { key: string };
type LoadedPlan = {
    id: string | null;
    version: number;
    revisionId: string | null;
    revision: number;
    timezone: string | null;
    entries: InternalEntry[];
};
type Allocation = { entryRef: string; batchId: string; unitId: string; quantity: string };
type Impact = {
    items: Array<{
        entryRef: string;
        ingredientId: string | null;
        name: string;
        requiredQuantity: string | null;
        reservedQuantity: string | null;
        missingQuantity: string | null;
        unit: string | null;
        needsQuantityCheck: boolean;
    }>;
    estimatedPriceMinor: number | null;
    priceComplete: boolean;
};

function stableUuid(value: unknown) {
    const hex = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32).split('');
    hex[12] = '4';
    hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
    return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

@Injectable()
export class MealPlanService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly diary: DiaryService,
    ) {}

    private async load(tx: WorkflowTx, scope: string | null): Promise<LoadedPlan> {
        if (!scope) return { id: null, version: 0, revisionId: null, revision: 0, timezone: null, entries: [] };
        const plan = (
            await sql<{
                id: string;
                version: number;
            }>`select id,version::integer from meal.meal_plans where scope_id=${scope}::uuid and archived_at is null order by created_at,id limit 1`.execute(
                tx,
            )
        ).rows[0];
        if (!plan) return { id: null, version: 0, revisionId: null, revision: 0, timezone: null, entries: [] };
        const revision = (
            await sql<{
                id: string;
                revision: number;
                timezone: string;
            }>`select id,revision,timezone from meal.plan_revisions where plan_id=${plan.id}::uuid and status='active' order by revision desc,id limit 1`.execute(
                tx,
            )
        ).rows[0];
        if (!revision)
            return { id: plan.id, version: plan.version, revisionId: null, revision: 0, timezone: null, entries: [] };
        const rows = await sql<{
            id: string;
            date: string;
            meal: string;
            portions: number;
            locked: boolean;
            substitutions: unknown;
            recipeId: string | null;
            revisionId: string | null;
            title: string | null;
            version: number;
        }>`select e.id,e.date::text,e.meal,e.portions,e.locked,e.substitutions,r.id as "recipeId",rr.id as "revisionId",rr.title,e.version::integer from meal.plan_entries e left join meal.recipe_revisions rr on rr.id=e.recipe_revision_id left join meal.recipes r on r.id=rr.recipe_id where e.revision_id=${revision.id}::uuid order by e.date,e.meal,e.created_at,e.id`.execute(
            tx,
        );
        const portions = await sql<{
            entryId: string;
            userId: string;
            displayName: string;
            portions: number;
        }>`select pp.entry_id as "entryId",pp.user_id as "userId",u.display_name as "displayName",pp.portions::integer from meal.plan_portions pp join meal.plan_entries pe on pe.id=pp.entry_id join meal.users u on u.id=pp.user_id where pe.revision_id=${revision.id}::uuid and pp.user_id is not null order by pp.created_at,pp.id`.execute(
            tx,
        );
        const entries = rows.rows.map((row) => {
            const extra = z
                .object({
                    slotState: z.enum(['recipe', 'outside', 'later', 'unplanned']).default('unplanned'),
                    note: z.string().nullable().default(null),
                })
                .passthrough()
                .parse(row.substitutions ?? {});
            const parsed = planSchema.shape.entries.element.parse({
                id: row.id,
                date: row.date,
                meal: row.meal,
                portions: row.portions,
                locked: row.locked,
                slotState: row.recipeId ? 'recipe' : extra.slotState,
                note: extra.note,
                recipe:
                    row.recipeId && row.revisionId && row.title
                        ? { id: row.recipeId, revisionId: row.revisionId, title: row.title }
                        : null,
                assignments: portions.rows
                    .filter((portion) => portion.entryId === row.id)
                    .map((portion) => ({
                        userId: portion.userId,
                        displayName: portion.displayName,
                        portions: portion.portions,
                    })),
                version: row.version,
            });
            return { ...parsed, key: parsed.id };
        });
        return {
            id: plan.id,
            version: plan.version,
            revisionId: revision.id,
            revision: revision.revision,
            timezone: revision.timezone,
            entries,
        };
    }

    private project(plan: LoadedPlan, selection: PlanQuery) {
        const range = planRange(selection);
        return planSchema.parse({
            scope: selection.scope,
            id: plan.id,
            version: plan.version,
            revision: plan.revision,
            timezone: plan.timezone ?? selection.timezone,
            ...range,
            view: selection.view,
            selectedDate: selection.date,
            entries: plan.entries
                .filter((entry) => entry.date >= range.startsOn && entry.date <= range.endsOn)
                .map((entry) => ({
                    id: entry.id,
                    date: entry.date,
                    meal: entry.meal,
                    portions: entry.portions,
                    locked: entry.locked,
                    slotState: entry.slotState,
                    note: entry.note,
                    recipe: entry.recipe,
                    assignments: entry.assignments,
                    version: entry.version,
                })),
        });
    }

    detail(userId: string, selection: PlanQuery) {
        return scopedWorkflow(this.database, this.entitlements, userId, selection.scope, false, async (tx, scope) => {
            await this.requireRange(tx, userId, selection);
            return this.project(await this.load(tx, scope), selection);
        });
    }

    private async requireRange(tx: WorkflowTx, userId: string, selection: PlanQuery) {
        const capabilities = (await this.entitlements.resolve(userId, tx)).capabilities;
        if (selection.view === 'range' && !capabilities.planningRange)
            throw new HttpException('Планирование периода доступно на тарифах Plus и Pro', 403);
        if (selection.view === 'calendar' && !capabilities.calendar)
            throw new HttpException('Календарное планирование доступно на тарифе Pro', 403);
    }

    private async assignments(
        tx: WorkflowTx,
        userId: string,
        scope: string,
        selection: PlanQuery,
        mutation: Extract<PlanMutation, { action: 'upsert' }>,
    ) {
        const requested =
            mutation.assignments ?? (selection.scope === 'private' ? [{ userId, portions: mutation.portions }] : []);
        if (!requested.length) return [];
        if (selection.scope === 'private' && requested.some((item) => item.userId !== userId))
            throw new HttpException('В личном плане можно назначить порцию только себе', 422);
        const ids = requested.map((item) => item.userId);
        const members =
            selection.scope === 'family'
                ? (
                      await sql<{
                          userId: string;
                          displayName: string;
                      }>`select fm.user_id as "userId",u.display_name as "displayName" from meal.family_memberships fm join meal.users u on u.id=fm.user_id join meal.data_scopes ds on ds.family_id=fm.family_id where ds.id=${scope}::uuid and fm.left_at is null and u.status='active' and u.archived_at is null and fm.user_id=any(${ids}::uuid[])`.execute(
                          tx,
                      )
                  ).rows
                : (
                      await sql<{
                          userId: string;
                          displayName: string;
                      }>`select id as "userId",display_name as "displayName" from meal.users where id=${userId}::uuid`.execute(
                          tx,
                      )
                  ).rows;
        if (members.length !== new Set(ids).size) throw new HttpException('Участник семьи недоступен', 422);
        const names = new Map(members.map((member) => [member.userId, member.displayName]));
        return requested.map((item) => ({ ...item, displayName: names.get(item.userId)! }));
    }

    private async applyMutation(
        tx: WorkflowTx,
        userId: string,
        scope: string | null,
        current: LoadedPlan,
        selection: PlanQuery,
        mutation: PlanMutation,
    ) {
        const entries = current.entries.map((entry) => ({
            ...entry,
            recipe: entry.recipe ? { ...entry.recipe } : null,
        }));
        if (mutation.action === 'remove') {
            const index = entries.findIndex((entry) => entry.id === mutation.entryId);
            if (index < 0) throw new HttpException('Позиция плана не найдена', 404);
            entries.splice(index, 1);
            return { entries, proposedEntry: null };
        }
        const range = planRange(selection);
        if (mutation.date < range.startsOn || mutation.date > range.endsOn)
            throw new HttpException('Дата должна находиться в открытом периоде', 422);
        const existing = mutation.entryId ? entries.find((entry) => entry.id === mutation.entryId) : null;
        if (mutation.entryId && !existing) throw new HttpException('Позиция плана не найдена', 404);
        let recipe: PlanEntry['recipe'] = null;
        if (mutation.slotState === 'recipe') {
            recipe =
                (
                    await sql<{
                        id: string;
                        revisionId: string;
                        title: string;
                    }>`select r.id,rr.id as "revisionId",rr.title from meal.recipe_revisions rr join meal.recipes r on r.id=rr.recipe_id where r.id=${mutation.recipeId}::uuid and rr.id=${mutation.revisionId}::uuid and r.archived_at is null and r.status not in ('hidden','deleted','archived','unpublished') and ((r.author_id=${userId}::uuid and r.scope_id=${scope}::uuid) or exists(select 1 from meal.recipe_publications p where p.revision_id=rr.id and p.unpublished_at is null and p.published_at<=now()))`.execute(
                        tx,
                    )
                ).rows[0] ?? null;
            if (!recipe) throw new HttpException('Рецепт недоступен', 404);
        }
        const assignments = await this.assignments(tx, userId, scope!, selection, mutation);
        const id = existing?.id ?? stableUuid({ userId, scope, mutation });
        const proposedEntry = planSchema.shape.entries.element.parse({
            id,
            date: mutation.date,
            meal: mutation.meal,
            portions: mutation.portions,
            locked: mutation.locked,
            slotState: mutation.slotState,
            note: mutation.note,
            recipe,
            assignments,
            version: existing ? existing.version + 1 : 1,
        });
        const next = { ...proposedEntry, key: existing?.key ?? `new:${id}` };
        if (existing) entries.splice(entries.indexOf(existing), 1, next);
        else entries.push(next);
        entries.sort(
            (a, b) => a.date.localeCompare(b.date) || a.meal.localeCompare(b.meal) || a.id.localeCompare(b.id),
        );
        return { entries, proposedEntry };
    }

    private async calculate(tx: WorkflowTx, scope: string | null, planId: string | null, entries: InternalEntry[]) {
        const items: Impact['items'] = [];
        const allocations: Allocation[] = [];
        const batchUsed = new Map<string, bigint>();
        for (const entry of entries) {
            if (!entry.recipe) continue;
            const base = (
                await sql<{
                    portions: number;
                }>`select portions from meal.recipe_revisions where id=${entry.recipe.revisionId}::uuid`.execute(tx)
            ).rows[0];
            if (!base) throw new HttpException('Версия рецепта недоступна', 404);
            const ingredients = await sql<{
                ingredientId: string | null;
                name: string;
                quantity: string | null;
                unit: string | null;
            }>`select ri.ingredient_id as "ingredientId",coalesce(i.name,'Неуточнённый ингредиент') as name,ri.quantity::text,u.code as unit from meal.recipe_ingredients ri left join meal.ingredients i on i.id=ri.ingredient_id left join meal.units u on u.id=ri.unit_id where ri.revision_id=${entry.recipe.revisionId}::uuid and not ri.optional order by ri.position,ri.id`.execute(
                tx,
            );
            for (const ingredient of ingredients.rows) {
                const required = scaleRecipeQuantity(ingredient.quantity, base.portions, entry.portions);
                if (!required || !ingredient.ingredientId || !ingredient.unit) {
                    items.push({
                        entryRef: entry.key,
                        ingredientId: ingredient.ingredientId,
                        name: ingredient.name,
                        requiredQuantity: required,
                        reservedQuantity: null,
                        missingQuantity: null,
                        unit: ingredient.unit,
                        needsQuantityCheck: true,
                    });
                    continue;
                }
                const batches = await sql<{
                    id: string;
                    quantity: string | null;
                    unitId: string;
                    externallyReserved: string;
                }>`select b.id,b.quantity::text,b.unit_id as "unitId",coalesce((select sum(sr.quantity) from meal.stock_reservations sr join meal.plan_entries pe on pe.id=sr.plan_entry_id join meal.plan_revisions pr on pr.id=pe.revision_id where sr.batch_id=b.id and sr.status='active' and (${planId}::uuid is null or pr.plan_id<>${planId}::uuid)),0)::text as "externallyReserved" from meal.inventory_batches b join meal.units u on u.id=b.unit_id where b.scope_id=${scope}::uuid and b.archived_at is null and b.ingredient_id=${ingredient.ingredientId}::uuid and u.code=${ingredient.unit} and (b.quantity is null or b.quantity>0) order by b.expiry_on nulls last,b.purchased_on nulls last,b.created_at,b.id`.execute(
                    tx,
                );
                let remaining = decimal(required);
                let unknown = false;
                for (const batch of batches.rows) {
                    if (batch.quantity === null) {
                        unknown = true;
                        continue;
                    }
                    const available =
                        decimal(batch.quantity) - decimal(batch.externallyReserved) - (batchUsed.get(batch.id) ?? 0n);
                    if (available <= 0n || remaining <= 0n) continue;
                    const take = available < remaining ? available : remaining;
                    batchUsed.set(batch.id, (batchUsed.get(batch.id) ?? 0n) + take);
                    allocations.push({
                        entryRef: entry.key,
                        batchId: batch.id,
                        unitId: batch.unitId,
                        quantity: decimalText(take),
                    });
                    remaining -= take;
                }
                const reserved = decimal(required) - remaining;
                items.push({
                    entryRef: entry.key,
                    ingredientId: ingredient.ingredientId,
                    name: ingredient.name,
                    requiredQuantity: required,
                    reservedQuantity: decimalText(reserved),
                    missingQuantity: decimalText(remaining),
                    unit: ingredient.unit,
                    needsQuantityCheck: unknown && remaining > 0n,
                });
            }
        }
        return {
            impact: { items, estimatedPriceMinor: null, priceComplete: false } satisfies Impact,
            allocations,
        };
    }

    private async changeReview(
        tx: WorkflowTx,
        userId: string,
        scope: string | null,
        input: z.infer<typeof planChangePreviewSchema>,
    ) {
        await this.requireRange(tx, userId, input.selection);
        const current = await this.load(tx, scope);
        if (current.version !== input.version) throw new HttpException('План изменился', 412);
        const proposed = await this.applyMutation(tx, userId, scope, current, input.selection, input.mutation);
        const calculated = await this.calculate(tx, scope, current.id, proposed.entries);
        const tokenValue = { userId, scope, version: current.version, input, impact: calculated.impact };
        return { current, ...proposed, ...calculated, tokenValue };
    }

    preview(userId: string, input: z.infer<typeof planChangePreviewSchema>) {
        return scopedWorkflow(
            this.database,
            this.entitlements,
            userId,
            input.selection.scope,
            true,
            async (tx, scope) => {
                const review = await this.changeReview(tx, userId, scope, input);
                const preview = createPlanToken(review.tokenValue);
                return {
                    previewToken: preview.token,
                    expiresAt: preview.expiresAt,
                    proposedEntry: review.proposedEntry,
                    impact: review.impact,
                };
            },
        );
    }

    commit(userId: string, input: z.infer<typeof planChangeCommitSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.selection.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'meal-plan', 'change', input, async () => {
                const reviewInput = {
                    version: input.version,
                    selection: input.selection,
                    mutation: input.mutation,
                };
                const review = await this.changeReview(tx, userId, scope, reviewInput);
                if (!validPlanToken(input.previewToken, review.tokenValue))
                    throw new HttpException('Предпросмотр устарел', 409);
                const planId = review.current.id ?? randomUUID();
                if (!review.current.id)
                    await sql`insert into meal.meal_plans(id,name,scope_id,created_by) values(${planId}::uuid,'Мой план',${scope}::uuid,${userId}::uuid)`.execute(
                        tx,
                    );
                else {
                    await sql`update meal.meal_plans set version=version+1 where id=${planId}::uuid and scope_id=${scope}::uuid and version=${input.version}`.execute(
                        tx,
                    );
                    await sql`update meal.plan_revisions set status='superseded',version=version+1 where plan_id=${planId}::uuid and status='active'`.execute(
                        tx,
                    );
                    if (review.current.revisionId)
                        await sql`update meal.stock_reservations set status='released',version=version+1 where status='active' and plan_entry_id in(select id from meal.plan_entries where revision_id=${review.current.revisionId}::uuid)`.execute(
                            tx,
                        );
                }
                const range = review.entries.length
                    ? {
                          startsOn: review.entries.map((entry) => entry.date).sort()[0]!,
                          endsOn: review.entries
                              .map((entry) => entry.date)
                              .sort()
                              .at(-1)!,
                      }
                    : planRange(input.selection);
                const revisionId = randomUUID();
                await sql`insert into meal.plan_revisions(id,revision,starts_on,ends_on,timezone,status,plan_id) values(${revisionId}::uuid,${review.current.revision + 1},${range.startsOn}::date,${range.endsOn}::date,${input.selection.timezone},'active',${planId}::uuid)`.execute(
                    tx,
                );
                const ids = new Map<string, string>();
                for (const entry of review.entries) {
                    const entryId = randomUUID();
                    ids.set(entry.key, entryId);
                    await sql`insert into meal.plan_entries(id,date,meal,portions,substitutions,manual,locked,revision_id,recipe_revision_id) values(${entryId}::uuid,${entry.date}::date,${entry.meal},${entry.portions},${JSON.stringify({ slotState: entry.slotState, note: entry.note, recipeId: entry.recipe?.id ?? null })}::jsonb,${entry.slotState !== 'recipe'},${entry.locked},${revisionId}::uuid,${entry.recipe?.revisionId ?? null}::uuid)`.execute(
                        tx,
                    );
                    for (const assignment of entry.assignments)
                        await sql`insert into meal.plan_portions(id,portions,size,entry_id,user_id) values(${randomUUID()}::uuid,${assignment.portions}::numeric,'serving',${entryId}::uuid,${assignment.userId}::uuid)`.execute(
                            tx,
                        );
                }
                for (const allocation of review.allocations) {
                    const entryId = ids.get(allocation.entryRef);
                    if (!entryId) throw new HttpException('Предпросмотр повреждён', 409);
                    const entry = review.entries.find((candidate) => candidate.key === allocation.entryRef)!;
                    await sql`insert into meal.stock_reservations(id,quantity,status,expires_at,batch_id,plan_entry_id,unit_id) values(${randomUUID()}::uuid,${allocation.quantity}::numeric,'active',((${entry.date}::date+interval '1 day')::timestamp at time zone ${input.selection.timezone}),${allocation.batchId}::uuid,${entryId}::uuid,${allocation.unitId}::uuid)`.execute(
                        tx,
                    );
                }
                await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,after_redacted,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,'meal-plan.changed','meal_plan',${planId}::uuid,now(),now(),${JSON.stringify({ revision: review.current.revision + 1, mutation: input.mutation, impact: review.impact })}::jsonb,${input.idempotencyKey}::uuid,${userId}::uuid,${scope}::uuid)`.execute(
                    tx,
                );
                return this.project(await this.load(tx, scope), input.selection);
            }),
        );
    }

    private async requireSmartShopping(tx: WorkflowTx, userId: string) {
        if (!(await this.entitlements.resolve(userId, tx)).capabilities.smartShopping)
            throw new HttpException('Умное планирование доступно на тарифах Plus и Pro', 403);
    }

    private async automationReview(
        tx: WorkflowTx,
        userId: string,
        scope: string,
        input: z.infer<typeof planAutomationPreviewSchema>,
    ) {
        await this.requireSmartShopping(tx, userId);
        if (input.rule.optimization && !(await this.entitlements.resolve(userId, tx)).capabilities.calendar)
            throw new HttpException('Детерминированная оптимизация доступна на тарифе Pro', 403);
        const current = await this.load(tx, scope);
        if (current.version !== input.version) throw new HttpException('План изменился', 412);
        const dates = planRange(input.selection);
        const requestedRecipes = [
            { recipeId: input.rule.recipeId, revisionId: input.rule.revisionId },
            ...(input.rule.optimization ? (input.rule.alternatives ?? []) : []),
        ];
        const revisionIds = requestedRecipes.map((item) => item.revisionId);
        const recipes = (
            await sql<{
                id: string;
                revisionId: string;
                title: string;
                portions: number;
                nutritionSnapshot: unknown;
            }>`select r.id,rr.id as "revisionId",rr.title,rr.portions,rr.nutrition_snapshot as "nutritionSnapshot"
                from meal.recipe_revisions rr join meal.recipes r on r.id=rr.recipe_id
                where rr.id=any(${revisionIds}::uuid[]) and r.archived_at is null
                  and r.status not in ('hidden','deleted','archived','unpublished')
                  and ((r.author_id=${userId}::uuid and r.scope_id=${scope}::uuid) or exists(
                    select 1 from meal.recipe_publications p where p.revision_id=rr.id
                    and p.unpublished_at is null and p.published_at<=now()))`.execute(tx)
        ).rows;
        const recipeMap = new Map(recipes.map((recipe) => [`${recipe.id}:${recipe.revisionId}`, recipe]));
        const orderedInput = requestedRecipes.map((item) => recipeMap.get(`${item.recipeId}:${item.revisionId}`));
        if (orderedInput.some((recipe) => !recipe)) throw new HttpException('Один из рецептов недоступен', 404);
        let orderedRecipes = orderedInput as typeof recipes;
        let optimization: {
            mode: 'deterministic-v1';
            priorities: Array<'expiry' | 'nutrition' | 'budget'>;
            candidates: Array<{
                recipeId: string;
                revisionId: string;
                title: string;
                rank: number;
                estimatedPriceMinor: number | null;
                priceComplete: boolean;
                nutritionCompletenessPercent: number;
                nutritionTargetDeviationPercent: number | null;
                expiringIngredientCount: number;
            }>;
            warnings: Array<'missing_prices' | 'missing_nutrition' | 'missing_nutrition_target'>;
        } | null = null;
        if (input.rule.optimization) {
            const target = (
                await sql<{ targets: unknown }>`select nt.targets from meal.nutrition_profiles np
                    join meal.nutrition_targets nt on nt.profile_id=np.id where np.user_id=${userId}::uuid
                    and nt.starts_on<=${dates.startsOn}::date and (nt.ends_on is null or nt.ends_on>=${dates.startsOn}::date)
                    order by nt.starts_on desc,nt.created_at desc,nt.id desc limit 1`.execute(tx)
            ).rows[0]?.targets as Record<string, unknown> | undefined;
            const assessed = [];
            for (const recipe of orderedRecipes) {
                const lines = (
                    await sql<{
                        quantity: string | null;
                        unitPriceMinor: string | number | bigint | null;
                        expiring: boolean;
                    }>`select ri.quantity::text,coalesce(
                        (select round(po.amount_minor/po.quantity)::bigint from meal.price_observations po
                         join meal.data_scopes pds on pds.id=po.scope_id where pds.kind='private'
                         and pds.user_id=${userId}::uuid and po.ingredient_id=ri.ingredient_id and po.unit_id=ri.unit_id
                         order by po.observed_at desc,po.id desc limit 1),
                        (select pa.median_minor from meal.price_aggregates pa where pa.ingredient_id=ri.ingredient_id
                         and pa.unit_id=ri.unit_id order by pa.calculated_at desc,pa.id desc limit 1)
                    ) as "unitPriceMinor",exists(select 1 from meal.inventory_batches b where b.scope_id=${scope}::uuid
                        and b.archived_at is null and b.ingredient_id=ri.ingredient_id and b.unit_id=ri.unit_id
                        and (b.quantity is null or b.quantity>0) and b.expiry_on is not null
                        and b.expiry_on<=${dates.endsOn}::date) as expiring
                    from meal.recipe_ingredients ri where ri.revision_id=${recipe.revisionId}::uuid and not ri.optional
                    order by ri.position,ri.id`.execute(tx)
                ).rows;
                const priceComplete = lines.length > 0 && lines.every((line) => line.quantity && line.unitPriceMinor);
                const estimatedPriceMinor = priceComplete
                    ? Math.round(
                          lines.reduce(
                              (sum, line) =>
                                  sum +
                                  (Number(line.quantity) * input.rule.portions * Number(line.unitPriceMinor)) /
                                      recipe.portions,
                              0,
                          ),
                      )
                    : null;
                const parsedNutrition = recipeNutritionSchema.safeParse(recipe.nutritionSnapshot);
                const nutrition = parsedNutrition.success ? parsedNutrition.data : null;
                const nutritionValues = nutrition
                    ? [nutrition.kcal, nutrition.protein, nutrition.fat, nutrition.carbs]
                    : [null, null, null, null];
                const nutritionCompletenessPercent = nutritionValues.filter((value) => value !== null).length * 25;
                const targetPairs = nutrition
                    ? [
                          [nutrition.kcal, target?.energyKcal],
                          [nutrition.protein, target?.proteinG],
                          [nutrition.fat, target?.fatG],
                          [nutrition.carbs, target?.carbohydrateG],
                      ].filter(
                          (pair): pair is [string, string] =>
                              typeof pair[0] === 'string' && typeof pair[1] === 'string' && Number(pair[1]) > 0,
                      )
                    : [];
                const factor =
                    nutrition?.basis === 'recipe' ? input.rule.portions / recipe.portions : input.rule.portions;
                const targetShare = input.rule.optimization.targetMealSharePercent / 100;
                const nutritionTargetDeviationPercent = targetPairs.length
                    ? Number(
                          (
                              targetPairs.reduce(
                                  (sum, [actual, expected]) =>
                                      sum +
                                      Math.abs(Number(actual) * factor - Number(expected) * targetShare) /
                                          (Number(expected) * targetShare),
                                  0,
                              ) /
                              targetPairs.length /
                              0.01
                          ).toFixed(1),
                      )
                    : null;
                assessed.push({
                    recipe,
                    estimatedPriceMinor,
                    priceComplete,
                    nutritionCompletenessPercent,
                    nutritionTargetDeviationPercent,
                    expiringIngredientCount: lines.filter((line) => line.expiring).length,
                });
            }
            const priorities = input.rule.optimization.priorities;
            assessed.sort((left, right) => {
                for (const priority of priorities) {
                    if (priority === 'expiry' && left.expiringIngredientCount !== right.expiringIngredientCount)
                        return right.expiringIngredientCount - left.expiringIngredientCount;
                    if (priority === 'nutrition') {
                        if (
                            left.nutritionTargetDeviationPercent !== null &&
                            right.nutritionTargetDeviationPercent !== null &&
                            left.nutritionTargetDeviationPercent !== right.nutritionTargetDeviationPercent
                        )
                            return left.nutritionTargetDeviationPercent - right.nutritionTargetDeviationPercent;
                        if (
                            left.nutritionTargetDeviationPercent === null &&
                            right.nutritionTargetDeviationPercent !== null
                        )
                            return 1;
                        if (
                            left.nutritionTargetDeviationPercent !== null &&
                            right.nutritionTargetDeviationPercent === null
                        )
                            return -1;
                        if (left.nutritionCompletenessPercent !== right.nutritionCompletenessPercent)
                            return right.nutritionCompletenessPercent - left.nutritionCompletenessPercent;
                    }
                    if (priority === 'budget') {
                        if (left.estimatedPriceMinor === null && right.estimatedPriceMinor !== null) return 1;
                        if (left.estimatedPriceMinor !== null && right.estimatedPriceMinor === null) return -1;
                        if (left.estimatedPriceMinor !== null && right.estimatedPriceMinor !== null) {
                            const leftOver = left.estimatedPriceMinor > input.rule.optimization!.maxBudgetMinor!;
                            const rightOver = right.estimatedPriceMinor > input.rule.optimization!.maxBudgetMinor!;
                            if (leftOver !== rightOver) return leftOver ? 1 : -1;
                            if (left.estimatedPriceMinor !== right.estimatedPriceMinor)
                                return left.estimatedPriceMinor - right.estimatedPriceMinor;
                        }
                    }
                }
                return (
                    left.recipe.title.localeCompare(right.recipe.title, 'ru') ||
                    left.recipe.revisionId.localeCompare(right.recipe.revisionId)
                );
            });
            orderedRecipes = assessed.map((item) => item.recipe);
            const warnings = new Set<'missing_prices' | 'missing_nutrition' | 'missing_nutrition_target'>();
            if (assessed.some((item) => !item.priceComplete)) warnings.add('missing_prices');
            if (assessed.some((item) => item.nutritionCompletenessPercent < 100)) warnings.add('missing_nutrition');
            if (!target) warnings.add('missing_nutrition_target');
            optimization = {
                mode: 'deterministic-v1',
                priorities,
                candidates: assessed.map((item, index) => ({
                    recipeId: item.recipe.id,
                    revisionId: item.recipe.revisionId,
                    title: item.recipe.title,
                    rank: index + 1,
                    estimatedPriceMinor: item.estimatedPriceMinor,
                    priceComplete: item.priceComplete,
                    nutritionCompletenessPercent: item.nutritionCompletenessPercent,
                    nutritionTargetDeviationPercent: item.nutritionTargetDeviationPercent,
                    expiringIngredientCount: item.expiringIngredientCount,
                })),
                warnings: [...warnings],
            };
        }
        const recipe = orderedRecipes[0]!;
        const assignments = await this.assignments(tx, userId, scope, input.selection, {
            action: 'upsert',
            entryId: null,
            date: dates.startsOn,
            meal: input.rule.meal,
            portions: input.rule.portions,
            locked: false,
            slotState: 'recipe',
            recipeId: recipe.id,
            revisionId: recipe.revisionId,
            note: null,
            ...(input.rule.assignments ? { assignments: input.rule.assignments } : {}),
        });
        const entries = current.entries.map((entry) => ({
            ...entry,
            recipe: entry.recipe ? { ...entry.recipe } : null,
        }));
        const proposedEntries: PlanEntry[] = [];
        const conflicts: Array<{ date: string; meal: PlanEntry['meal']; existingEntryId: string; locked: boolean }> =
            [];
        let proposedIndex = 0;
        for (const date of weeklyDates(dates.startsOn, dates.endsOn, input.rule.weekdays)) {
            const existing = entries.find((entry) => entry.date === date && entry.meal === input.rule.meal);
            if (existing)
                conflicts.push({
                    date,
                    meal: input.rule.meal,
                    existingEntryId: existing.id,
                    locked: existing.locked,
                });
            else {
                const selectedRecipe = orderedRecipes[proposedIndex % orderedRecipes.length]!;
                proposedIndex++;
                const id = stableUuid({ userId, scope, automation: input.rule, date });
                const entry = planSchema.shape.entries.element.parse({
                    id,
                    date,
                    meal: input.rule.meal,
                    portions: input.rule.portions,
                    locked: false,
                    slotState: 'recipe',
                    note: null,
                    recipe: {
                        id: selectedRecipe.id,
                        revisionId: selectedRecipe.revisionId,
                        title: selectedRecipe.title,
                    },
                    assignments,
                    version: 1,
                });
                proposedEntries.push(entry);
                entries.push({ ...entry, key: `automation:${id}` });
            }
        }
        entries.sort(
            (a, b) => a.date.localeCompare(b.date) || a.meal.localeCompare(b.meal) || a.id.localeCompare(b.id),
        );
        const calculated = await this.calculate(tx, scope, current.id, entries);
        const tokenValue = {
            userId,
            scope,
            version: current.version,
            input,
            proposed: proposedEntries.map((entry) => ({ id: entry.id, revisionId: entry.recipe?.revisionId ?? null })),
            conflicts,
            impact: calculated.impact,
            optimization,
        };
        return { current, entries, proposedEntries, conflicts, optimization, ...calculated, tokenValue };
    }

    automationPreview(userId: string, input: z.infer<typeof planAutomationPreviewSchema>) {
        return scopedWorkflow(
            this.database,
            this.entitlements,
            userId,
            input.selection.scope,
            true,
            async (tx, scope) => {
                const review = await this.automationReview(tx, userId, scope, input);
                const preview = createPlanToken(review.tokenValue);
                return {
                    previewToken: preview.token,
                    expiresAt: preview.expiresAt,
                    occurrences: review.proposedEntries.length,
                    proposedEntries: review.proposedEntries,
                    conflicts: review.conflicts,
                    impact: review.impact,
                    optimization: review.optimization,
                };
            },
        );
    }

    automationCommit(userId: string, input: z.infer<typeof planAutomationCommitSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.selection.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'meal-plan', 'automation', input, async () => {
                const request = { version: input.version, selection: input.selection, rule: input.rule };
                const review = await this.automationReview(tx, userId, scope, request);
                if (!validPlanToken(input.previewToken, review.tokenValue))
                    throw new HttpException('Предпросмотр устарел', 409);
                if (!review.proposedEntries.length) throw new HttpException('Все подходящие даты уже заняты', 422);
                const planId = review.current.id ?? randomUUID();
                if (!review.current.id)
                    await sql`insert into meal.meal_plans(id,name,scope_id,created_by) values(${planId}::uuid,'Мой план',${scope}::uuid,${userId}::uuid)`.execute(
                        tx,
                    );
                else {
                    const updated =
                        await sql`update meal.meal_plans set version=version+1 where id=${planId}::uuid and scope_id=${scope}::uuid and version=${input.version} returning id`.execute(
                            tx,
                        );
                    if (updated.rows.length !== 1) throw new HttpException('План изменился', 412);
                    await sql`update meal.plan_revisions set status='superseded',version=version+1 where plan_id=${planId}::uuid and status='active'`.execute(
                        tx,
                    );
                    if (review.current.revisionId)
                        await sql`update meal.stock_reservations set status='released',version=version+1 where status='active' and plan_entry_id in(select id from meal.plan_entries where revision_id=${review.current.revisionId}::uuid)`.execute(
                            tx,
                        );
                }
                const revisionId = randomUUID();
                const fullRange = review.entries.length
                    ? {
                          startsOn: review.entries.map((entry) => entry.date).sort()[0]!,
                          endsOn: review.entries
                              .map((entry) => entry.date)
                              .sort()
                              .at(-1)!,
                      }
                    : planRange(input.selection);
                await sql`insert into meal.plan_revisions(id,revision,starts_on,ends_on,timezone,status,plan_id) values(${revisionId}::uuid,${review.current.revision + 1},${fullRange.startsOn}::date,${fullRange.endsOn}::date,${input.selection.timezone},'active',${planId}::uuid)`.execute(
                    tx,
                );
                const ruleId = randomUUID();
                const selectedRange = planRange(input.selection);
                await sql`insert into meal.plan_rules(id,rule,exceptions,portions,starts_on,ends_on,revision_id,recipe_revision_id) values(${ruleId}::uuid,${JSON.stringify({ frequency: 'weekly', weekdays: input.rule.weekdays, meal: input.rule.meal, conflictPolicy: input.rule.conflictPolicy, alternatives: input.rule.alternatives ?? [], optimization: input.rule.optimization ?? null })}::jsonb,${JSON.stringify(review.conflicts)}::jsonb,${input.rule.portions},${selectedRange.startsOn}::date,${selectedRange.endsOn}::date,${revisionId}::uuid,${input.rule.revisionId}::uuid)`.execute(
                    tx,
                );
                const generated = new Set(review.proposedEntries.map((entry) => entry.id));
                const ids = new Map<string, string>();
                for (const entry of review.entries) {
                    const entryId = randomUUID();
                    ids.set(entry.key, entryId);
                    await sql`insert into meal.plan_entries(id,date,meal,portions,substitutions,manual,locked,revision_id,rule_id,recipe_revision_id) values(${entryId}::uuid,${entry.date}::date,${entry.meal},${entry.portions},${JSON.stringify({ slotState: entry.slotState, note: entry.note, recipeId: entry.recipe?.id ?? null })}::jsonb,${!generated.has(entry.id)},${entry.locked},${revisionId}::uuid,${generated.has(entry.id) ? ruleId : null}::uuid,${entry.recipe?.revisionId ?? null}::uuid)`.execute(
                        tx,
                    );
                    for (const assignment of entry.assignments)
                        await sql`insert into meal.plan_portions(id,portions,size,entry_id,user_id) values(${randomUUID()}::uuid,${assignment.portions}::numeric,'serving',${entryId}::uuid,${assignment.userId}::uuid)`.execute(
                            tx,
                        );
                }
                for (const allocation of review.allocations) {
                    const entryId = ids.get(allocation.entryRef);
                    const entry = review.entries.find((candidate) => candidate.key === allocation.entryRef);
                    if (!entryId || !entry) throw new HttpException('Предпросмотр повреждён', 409);
                    await sql`insert into meal.stock_reservations(id,quantity,status,expires_at,batch_id,plan_entry_id,unit_id) values(${randomUUID()}::uuid,${allocation.quantity}::numeric,'active',((${entry.date}::date+interval '1 day')::timestamp at time zone ${input.selection.timezone}),${allocation.batchId}::uuid,${entryId}::uuid,${allocation.unitId}::uuid)`.execute(
                        tx,
                    );
                }
                await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,after_redacted,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,'meal-plan.automated','meal_plan',${planId}::uuid,now(),now(),${JSON.stringify({ revision: review.current.revision + 1, rule: input.rule, occurrences: review.proposedEntries.length, conflicts: review.conflicts })}::jsonb,${input.idempotencyKey}::uuid,${userId}::uuid,${scope}::uuid)`.execute(
                    tx,
                );
                return this.project(await this.load(tx, scope), input.selection);
            }),
        );
    }

    private shoppingItems(impact: Impact, entries: InternalEntry[]) {
        const groups = new Map<
            string,
            {
                ingredientId: string | null;
                name: string;
                quantity: string | null;
                unit: string | null;
                needsQuantityCheck: boolean;
                entryIds: string[];
            }
        >();
        for (const item of impact.items) {
            if (item.missingQuantity === '0' && !item.needsQuantityCheck) continue;
            const key = `${item.ingredientId ?? item.name}:${item.unit ?? ''}`;
            const entry = entries.find((candidate) => candidate.key === item.entryRef);
            const previous = groups.get(key);
            const quantity =
                item.missingQuantity === null || previous?.quantity === null
                    ? null
                    : decimalText(decimal(previous?.quantity ?? '0') + decimal(item.missingQuantity));
            groups.set(key, {
                ingredientId: item.ingredientId,
                name: item.name,
                quantity,
                unit: item.unit,
                needsQuantityCheck: item.needsQuantityCheck || (previous?.needsQuantityCheck ?? false),
                entryIds: [...new Set([...(previous?.entryIds ?? []), ...(entry ? [entry.id] : [])])],
            });
        }
        return [...groups.values()];
    }

    private async shoppingReview(
        tx: WorkflowTx,
        userId: string,
        scope: string | null,
        input: z.infer<typeof planShoppingPreviewRequestSchema>,
    ) {
        await this.requireRange(tx, userId, input.selection);
        const current = await this.load(tx, scope);
        if (!current.id || !current.revisionId) throw new HttpException('План пока пуст', 409);
        if (current.version !== input.version) throw new HttpException('План изменился', 412);
        const range = planRange(input.selection);
        const entries = current.entries.filter((entry) => entry.date >= range.startsOn && entry.date <= range.endsOn);
        const calculated = await this.calculate(tx, scope, current.id, current.entries);
        const selected = new Set(entries.map((entry) => entry.key));
        const impact = {
            ...calculated.impact,
            items: calculated.impact.items.filter((item) => selected.has(item.entryRef)),
        };
        const items = this.shoppingItems(impact, entries);
        const tokenValue = { userId, scope, planId: current.id, version: current.version, input, items };
        return { current, entries, impact, items, tokenValue };
    }

    shoppingPreview(userId: string, input: z.infer<typeof planShoppingPreviewRequestSchema>) {
        return scopedWorkflow(
            this.database,
            this.entitlements,
            userId,
            input.selection.scope,
            true,
            async (tx, scope) => {
                await this.requireSmartShopping(tx, userId);
                const review = await this.shoppingReview(tx, userId, scope, input);
                const preview = createPlanToken(review.tokenValue);
                return {
                    previewToken: preview.token,
                    expiresAt: preview.expiresAt,
                    items: review.items,
                    estimatedPriceMinor: review.impact.estimatedPriceMinor,
                    priceComplete: review.impact.priceComplete,
                };
            },
        );
    }

    shoppingCommit(userId: string, input: z.infer<typeof planShoppingCommitSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.selection.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'meal-plan', 'shopping', input, async () => {
                await this.requireSmartShopping(tx, userId);
                const request = { version: input.version, selection: input.selection };
                const review = await this.shoppingReview(tx, userId, scope, request);
                if (!validPlanToken(input.previewToken, review.tokenValue))
                    throw new HttpException('Предпросмотр устарел', 409);
                if (!review.items.length) throw new HttpException('Для периода нечего покупать', 422);
                const listId = randomUUID();
                await sql`insert into meal.shopping_lists(id,title,status,scope_id,created_by) values(${listId}::uuid,${input.title},'active',${scope}::uuid,${userId}::uuid)`.execute(
                    tx,
                );
                for (const [position, item] of review.items.entries()) {
                    const itemId = randomUUID();
                    const unitId = item.unit
                        ? (await sql<{ id: string }>`select id from meal.units where code=${item.unit}`.execute(tx))
                              .rows[0]?.id
                        : null;
                    const sourceImpacts = review.impact.items.filter(
                        (line) =>
                            item.entryIds.includes(line.entryRef) &&
                            line.ingredientId === item.ingredientId &&
                            line.unit === item.unit &&
                            line.missingQuantity !== '0',
                    );
                    const origin = sourceImpacts.flatMap((impact) => {
                        const entry = review.entries.find((candidate) => candidate.key === impact.entryRef);
                        return entry?.recipe
                            ? [
                                  {
                                      revisionId: entry.recipe.revisionId,
                                      portions: entry.portions,
                                      quantity: impact.missingQuantity,
                                  },
                              ]
                            : [];
                    });
                    await sql`insert into meal.shopping_items(id,name,quantity,requirements,allow_analog,manual,status,list_id,ingredient_id,unit_id,position,estimated_price_minor,origin_snapshot) values(${itemId}::uuid,${item.name},${item.quantity}::numeric,${JSON.stringify({ needsQuantityCheck: item.needsQuantityCheck })}::jsonb,true,false,'pending',${listId}::uuid,${item.ingredientId}::uuid,${unitId}::uuid,${position},null,${JSON.stringify(origin)}::jsonb)`.execute(
                        tx,
                    );
                    for (const impact of sourceImpacts) {
                        if (impact.missingQuantity === null) continue;
                        const entry = review.entries.find((candidate) => candidate.key === impact.entryRef);
                        if (!entry?.recipe || !unitId) continue;
                        await sql`insert into meal.shopping_contributions(id,quantity,portions,substitutions,item_id,entry_id,recipe_revision_id,unit_id) values(${randomUUID()}::uuid,${impact.missingQuantity}::numeric,${entry.portions},'{}'::jsonb,${itemId}::uuid,${entry.id}::uuid,${entry.recipe.revisionId}::uuid,${unitId}::uuid)`.execute(
                            tx,
                        );
                    }
                }
                await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,after_redacted,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,'meal-plan.shopping-created','shopping_list',${listId}::uuid,now(),now(),${JSON.stringify({ planId: review.current.id, selection: input.selection, items: review.items })}::jsonb,${input.idempotencyKey}::uuid,${userId}::uuid,${scope}::uuid)`.execute(
                    tx,
                );
                return { listId };
            }),
        );
    }

    private async portionWorkspace(tx: WorkflowTx, scope: string, requestedScope: 'private' | 'family') {
        await this.diary.reconcileDueInScope(tx, scope);
        const prepared = await sql<{
            batchId: string;
            outputId: string;
            attemptId: string;
            name: string;
            quantity: string | null;
            unit: string;
            version: number;
        }>`select b.id as "batchId",co.id as "outputId",co.attempt_id as "attemptId",b.name,b.quantity::text,u.code as unit,b.version::integer from meal.inventory_batches b join meal.cooking_outputs co on co.batch_id=b.id join meal.units u on u.id=b.unit_id where b.scope_id=${scope}::uuid and b.kind='prepared' and b.archived_at is null and (b.quantity is null or b.quantity>0) order by b.expiry_on nulls last,b.created_at,b.id limit 500`.execute(
            tx,
        );
        const proposals = await sql<{
            id: string;
            recipientUserId: string;
            displayName: string;
            batchId: string;
            name: string;
            quantity: string;
            unit: string;
            state: string;
            availableAt: string;
            dueAt: string;
            decisionAt: string | null;
            version: number;
        }>`select pp.id,pp.recipient_id as "recipientUserId",u.display_name as "displayName",b.id as "batchId",b.name,pp.issued_quantity::text,unit.code as unit,pp.state,pp.available_at::text as "availableAt",pp.due_at::text as "dueAt",pp.decision_at::text as "decisionAt",pp.version::integer from meal.portion_proposals pp join meal.cooking_attempts ca on ca.id=pp.attempt_id join meal.users u on u.id=pp.recipient_id join meal.inventory_operations op on op.id=pp.allocation_operation_id join meal.inventory_movements movement on movement.operation_id=op.id join meal.inventory_batches b on b.id=movement.batch_id join meal.units unit on unit.id=pp.issued_unit_id where ca.scope_id=${scope}::uuid order by pp.created_at desc,pp.id limit 500`.execute(
            tx,
        );
        return {
            scope: requestedScope,
            prepared: prepared.rows,
            proposals: proposals.rows.map((row) => ({
                id: row.id,
                recipient: { userId: row.recipientUserId, displayName: row.displayName },
                source: { batchId: row.batchId, name: row.name },
                quantity: row.quantity,
                unit: row.unit,
                state: row.state,
                availableAt: new Date(row.availableAt).toISOString(),
                dueAt: new Date(row.dueAt).toISOString(),
                decisionAt: row.decisionAt ? new Date(row.decisionAt).toISOString() : null,
                version: row.version,
            })),
        };
    }

    portions(userId: string, query: z.infer<typeof portionScopeQuerySchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, query.scope, false, (tx, scope) =>
            this.portionWorkspace(tx, scope, query.scope),
        );
    }

    assignPortion(userId: string, input: z.infer<typeof portionAssignSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'portion', `assign:${input.batchId}`, input, async () => {
                const recipient =
                    input.scope === 'family'
                        ? (
                              await sql<{
                                  id: string;
                              }>`select fm.user_id as id from meal.family_memberships fm join meal.data_scopes ds on ds.family_id=fm.family_id where ds.id=${scope}::uuid and fm.user_id=${input.recipientUserId}::uuid and fm.left_at is null`.execute(
                                  tx,
                              )
                          ).rows[0]
                        : input.recipientUserId === userId
                          ? { id: userId }
                          : null;
                if (!recipient) throw new HttpException('Получатель недоступен', 422);
                const batch = (
                    await sql<{
                        id: string;
                        name: string;
                        quantity: string | null;
                        unitId: string;
                        unit: string;
                        version: number;
                        outputId: string;
                        attemptId: string;
                        yieldSnapshot: unknown;
                    }>`select b.id,b.name,b.quantity::text,b.unit_id as "unitId",u.code as unit,b.version::integer,co.id as "outputId",co.attempt_id as "attemptId",co.yield_snapshot as "yieldSnapshot" from meal.inventory_batches b join meal.units u on u.id=b.unit_id join meal.cooking_outputs co on co.batch_id=b.id where b.id=${input.batchId}::uuid and b.scope_id=${scope}::uuid and b.kind='prepared' and b.archived_at is null order by co.created_at desc,co.id desc limit 1 for update of b`.execute(
                        tx,
                    )
                ).rows[0];
                if (!batch) throw new HttpException('Готовая еда не найдена', 404);
                if (batch.version !== input.expectedBatchVersion) throw new HttpException('Остаток изменился', 412);
                if (batch.quantity === null || decimal(batch.quantity) < decimal(input.quantity))
                    throw new HttpException('Готовой еды недостаточно', 422);
                const nextQuantity = decimalText(decimal(batch.quantity) - decimal(input.quantity));
                const operationId = randomUUID();
                const proposalId = randomUUID();
                const before = {
                    id: batch.id,
                    name: batch.name,
                    quantity: batch.quantity,
                    unit: batch.unit,
                    version: batch.version,
                };
                const after = { ...before, quantity: nextQuantity, version: batch.version + 1 };
                await sql`insert into meal.inventory_operations(id,kind,effective_at,recorded_at,status,idempotency_key,scope_id,actor_id) values(${operationId}::uuid,'portion_allocation',now(),now(),'applied',${input.idempotencyKey},${scope}::uuid,${userId}::uuid)`.execute(
                    tx,
                );
                await sql`insert into meal.inventory_movements(id,quantity_delta,before_snapshot,after_snapshot,base_version,operation_id,batch_id,unit_id) values(${randomUUID()}::uuid,${decimalText(-decimal(input.quantity))}::numeric,${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb,${batch.version},${operationId}::uuid,${batch.id}::uuid,${batch.unitId}::uuid)`.execute(
                    tx,
                );
                const updated = await sql<{
                    id: string;
                }>`update meal.inventory_batches set quantity=${nextQuantity}::numeric,version=version+1 where id=${batch.id}::uuid and scope_id=${scope}::uuid and version=${batch.version} returning id`.execute(
                    tx,
                );
                if (updated.rows.length !== 1) throw new HttpException('Остаток изменился', 412);
                await sql`insert into meal.portion_proposals(id,allocation_key,available_at,due_at,state,nutrition_snapshot,quantity_snapshot,recipient_id,attempt_id,output_id,allocation_operation_id,issued_quantity,issued_unit_id) values(${proposalId}::uuid,${input.idempotencyKey},now(),now()+interval '24 hours','pending',${JSON.stringify(batch.yieldSnapshot ?? {})}::jsonb,${JSON.stringify({ quantity: input.quantity, unit: batch.unit, batchId: batch.id })}::jsonb,${input.recipientUserId}::uuid,${batch.attemptId}::uuid,${batch.outputId}::uuid,${operationId}::uuid,${input.quantity}::numeric,${batch.unitId}::uuid)`.execute(
                    tx,
                );
                await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,after_redacted,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,'portion.assigned','portion_proposal',${proposalId}::uuid,now(),now(),${JSON.stringify({ recipientUserId: input.recipientUserId, batchId: batch.id, quantity: input.quantity, unit: batch.unit })}::jsonb,${input.idempotencyKey}::uuid,${userId}::uuid,${scope}::uuid)`.execute(
                    tx,
                );
                return this.portionWorkspace(tx, scope, input.scope);
            }),
        );
    }

    decidePortion(userId: string, proposalId: string, input: z.infer<typeof portionDecisionSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'portion', `decision:${proposalId}`, input, async () => {
                await this.diary.decidePortionIn(tx, userId, proposalId, input, false);
                return this.portionWorkspace(tx, scope, input.scope);
            }),
        );
    }
}
