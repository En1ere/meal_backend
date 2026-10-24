import { Injectable, HttpException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import {
    cookingAttemptSchema,
    type CookingAttempt,
    type cookingStartSchema,
    type cookingProgressSchema,
    type cookingFinalizeSchema,
} from './cooking.contracts.js';
import { personalWorkflow, workflowReplay, type WorkflowTx } from './workflow.store.js';
import { consumedRemainder, progressAttempt } from './cooking.domain.js';
import { decimal } from '../inventory/inventory.domain.js';
import { RecipesService } from '../recipes/recipes.service.js';
import { CookingLifecycleService } from './cooking-lifecycle.service.js';
import { consumePreserveContainer } from '../preserves/preserves.store.js';
import type { cookingListQuerySchema, cookingReminderPreferencesChangeSchema } from './cooking.contracts.js';
import { ContentReleasesService } from '../content-releases/content-releases.service.js';
import { CookingStatisticsPolicy, DEFAULT_COOKING_STATISTICS_RULE } from './cooking-statistics.policy.js';

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
const auditSnapshot = (row: Record<string, unknown>) =>
    Object.fromEntries(
        [
            'id',
            'name',
            'quantity',
            'unit',
            'version',
            'locationId',
            'ingredientId',
            'openedAt',
            'purchasedOn',
            'expiryOn',
            'packageState',
            'precision',
            'quantitySource',
            'confidence',
            'pricePaidRub',
            'storeName',
            'barcode',
            'scope',
            'archivedAt',
            'createdAt',
        ].map((key) => [key, row[key]]),
    );
const snapshotSchema = z
    .object({
        recipeId: z.uuid(),
        revisionId: z.uuid(),
        title: z.string(),
        servings: z.number().int(),
        steps: z.array(
            z.object({ position: z.number().int(), text: z.string(), durationSeconds: z.number().nullable() }),
        ),
    })
    .passthrough();
@Injectable()
export class CookingService {
    constructor(
        private readonly database: DatabaseService,
        @Optional() private readonly releases?: ContentReleasesService,
        @Optional() private readonly lifecycle?: CookingLifecycleService,
        @Optional() private readonly statisticsPolicy?: CookingStatisticsPolicy,
        @Optional() private readonly recipes?: RecipesService,
    ) {}
    reminderPreferences(userId: string) {
        if (!this.lifecycle) throw new HttpException('Сервис напоминаний недоступен', 503);
        return this.lifecycle.preferences(userId);
    }
    saveReminderPreferences(userId: string, input: z.infer<typeof cookingReminderPreferencesChangeSchema>) {
        if (!this.lifecycle) throw new HttpException('Сервис напоминаний недоступен', 503);
        return this.lifecycle.savePreferences(userId, input);
    }
    async statistics(recipeId: string, servings: number) {
        if (!this.recipes) throw new HttpException('Сервис рецептов недоступен', 503);
        const { recipe } = await this.recipes.detail(recipeId);
        return this.database.transaction(async (tx) => {
            const publicationRule = this.statisticsPolicy
                ? await this.statisticsPolicy.resolve(tx)
                : DEFAULT_COOKING_STATISTICS_RULE;
            const result = await sql<{
                sampleSize: number;
                medianSeconds: number | null;
                lowerQuartileSeconds: number | null;
                upperQuartileSeconds: number | null;
            }>`select count(*)::integer as "sampleSize",percentile_cont(0.5) within group(order by a.confirmed_duration) as "medianSeconds",percentile_cont(0.25) within group(order by a.confirmed_duration) as "lowerQuartileSeconds",percentile_cont(0.75) within group(order by a.confirmed_duration) as "upperQuartileSeconds" from meal.cooking_attempts a where a.revision_id=${recipe.revisionId}::uuid and a.status='completed' and a.completed_at is not null and a.confirmed_duration is not null and a.recipe_snapshot->>'method' is not distinct from ${recipe.method}::text and a.recipe_snapshot->>'servings'=${String(servings)} and not exists(select 1 from meal.cooking_steps s where s.attempt_id=a.id and s.status<>'completed')`.execute(
                tx,
            );
            const row = result.rows[0];
            const sampleSize = row?.sampleSize ?? 0;
            return {
                recipeId,
                revisionId: recipe.revisionId,
                servings,
                sampleSize,
                medianSeconds: sampleSize >= publicationRule.minimumSample ? (row?.medianSeconds ?? null) : null,
                lowerQuartileSeconds:
                    sampleSize >= publicationRule.minimumSample ? (row?.lowerQuartileSeconds ?? null) : null,
                upperQuartileSeconds:
                    sampleSize >= publicationRule.minimumSample ? (row?.upperQuartileSeconds ?? null) : null,
                outlierPolicy: 'pending-calibration' as const,
            };
        });
    }
    private async get(tx: WorkflowTx, scope: string | null, id: string): Promise<CookingAttempt> {
        const result = await sql<
            Record<string, unknown>
        >`select id,status,version::integer,started_at,completed_at,recipe_snapshot,confirmed_duration,private_note,output_snapshot from meal.cooking_attempts where id=${id}::uuid and scope_id=${scope}::uuid for update`.execute(
            tx,
        );
        const row = result.rows[0];
        if (!row) throw new HttpException('Приготовление не найдено', 404);
        const snapshot = snapshotSchema.parse(row.recipe_snapshot);
        const progress = await sql<
            Record<string, unknown>
        >`select position,status,private_note as "privateNote",timer_deadline as "timerDeadline",timer_paused_seconds as "timerPausedSeconds" from meal.cooking_steps where attempt_id=${id}::uuid order by position`.execute(
            tx,
        );
        const output = z.object({ batchIds: z.array(z.uuid()) }).safeParse(row.output_snapshot);
        const lifecycle = z
            .object({ lifecycle: z.object({ archivedAt: z.iso.datetime(), hideAfter: z.iso.datetime() }) })
            .safeParse(row.output_snapshot);
        return cookingAttemptSchema.parse({
            id: row.id,
            ...snapshot,
            status: row.status,
            version: row.version,
            startedAt: iso(row.started_at),
            completedAt: iso(row.completed_at),
            confirmedDuration: row.confirmed_duration,
            privateNote: row.private_note,
            outputBatchIds: output.success ? output.data.batchIds : [],
            archivedAt: lifecycle.success ? lifecycle.data.lifecycle.archivedAt : null,
            hideAfter: lifecycle.success ? lifecycle.data.lifecycle.hideAfter : null,
            steps: snapshot.steps.map((step) => {
                const state = progress.rows.find((p) => p.position === step.position);
                return {
                    ...step,
                    status: state?.status ?? 'pending',
                    privateNote: state?.privateNote ?? null,
                    timerDeadline: iso(state?.timerDeadline ?? null),
                    timerPausedSeconds: state?.timerPausedSeconds ?? null,
                };
            }),
        });
    }
    async list(userId: string, query: z.infer<typeof cookingListQuerySchema> = { view: 'current' }) {
        await this.lifecycle?.reconcileUser(userId);
        return personalWorkflow(this.database, userId, false, async (tx, scope) => {
            if (!scope) return { items: [], reminders: [] };
            const ids = await sql<{
                id: string;
            }>`select id from meal.cooking_attempts where scope_id=${scope}::uuid and (${query.view}='all' or (${query.view}='current' and status<>'archived') or (${query.view}='archive' and status='archived')) and not(status in ('active','paused') and started_at<=now()-interval '6 days') and (status<>'archived' or (output_snapshot->'lifecycle'->>'hideAfter')::timestamptz>now()) order by started_at desc,id limit 100`.execute(
                tx,
            );
            const items: CookingAttempt[] = [];
            for (const row of ids.rows) items.push(await this.get(tx, scope, row.id));
            return { items, reminders: (await this.lifecycle?.reminders(tx, userId)) ?? [] };
        });
    }
    async detail(userId: string, id: string) {
        await this.lifecycle?.reconcileUser(userId, id);
        return personalWorkflow(this.database, userId, false, (tx, scope) => this.get(tx, scope, id));
    }
    stockOptions(userId: string) {
        return personalWorkflow(this.database, userId, false, async (tx, scope) => ({
            items: (
                await sql<{
                    id: string;
                    name: string;
                    kind: string;
                    quantity: string | null;
                    unit: string | null;
                    version: number;
                    locationId: string | null;
                    ingredientId: string | null;
                    sourceRecipeId: string | null;
                    preserveId: string | null;
                    containers: Array<{ id: string; label: string; quantity: string | null; version: number }>;
                }>`select b.id,b.name,b.kind,b.quantity::text,u.code as unit,b.version::integer,b.location_id as "locationId",b.ingredient_id as "ingredientId",coalesce(pr.recipe_id,source.recipe_id) as "sourceRecipeId",p.id as "preserveId",coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'label',c.label,'quantity',c.remaining_quantity::text,'version',c.version) order by c.created_at,c.id) from meal.preserve_containers c where c.preserve_id=p.id),'[]'::jsonb) as containers from meal.inventory_batches b left join meal.units u on u.id=b.unit_id left join meal.preserve_details p on p.batch_id=b.id left join meal.recipe_revisions pr on pr.id=p.recipe_revision_id left join lateral(select rr.recipe_id from meal.cooking_outputs o join meal.cooking_attempts a on a.id=o.attempt_id join meal.recipe_revisions rr on rr.id=a.revision_id where o.batch_id=b.id order by o.created_at desc,o.id limit 1) source on true where b.scope_id=${scope}::uuid and b.archived_at is null and (b.quantity is null or b.quantity>0) order by b.created_at desc,b.id limit 1000`.execute(
                    tx,
                )
            ).rows,
        }));
    }
    start(userId: string, input: z.infer<typeof cookingStartSchema>) {
        return personalWorkflow(this.database, userId, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'cooking', 'start', input, async () => {
                const revision = await sql<
                    Record<string, unknown>
                >`select rr.id,rr.title,rr.portions,rr.method,rr.nutrition_snapshot from meal.recipe_revisions rr join meal.recipes r on r.id=rr.recipe_id where rr.id=${input.revisionId}::uuid and r.id=${input.recipeId}::uuid and r.archived_at is null and r.status not in ('hidden','deleted','archived','unpublished') and ((r.author_id=${userId}::uuid and r.scope_id=${scope}::uuid) or exists(select 1 from meal.recipe_publications p where p.revision_id=rr.id and p.unpublished_at is null and p.published_at<=now()))`.execute(
                    tx,
                );
                const row = revision.rows[0];
                if (!row) throw new HttpException('Рецепт недоступен', 404);
                const steps = await sql<{
                    position: number;
                    text: string;
                    durationSeconds: number | null;
                }>`select position,text,duration_seconds as "durationSeconds" from meal.recipe_steps where revision_id=${input.revisionId}::uuid order by position`.execute(
                    tx,
                );
                const ingredients = await sql<
                    Record<string, unknown>
                >`select id,ingredient_id,variant_id,product_id,source_recipe_id,quantity::text,unit_id,optional,position from meal.recipe_ingredients where revision_id=${input.revisionId}::uuid order by position`.execute(
                    tx,
                );
                const snapshot = {
                    recipeId: input.recipeId,
                    revisionId: input.revisionId,
                    title: row.title,
                    servings: input.servings,
                    baseServings: row.portions,
                    method: row.method,
                    nutrition: row.nutrition_snapshot,
                    ingredients: ingredients.rows,
                    steps: steps.rows,
                };
                const id = randomUUID();
                await sql`insert into meal.cooking_attempts(id,status,started_at,recipe_snapshot,scope_id,actor_id,revision_id) values(${id}::uuid,'active',now(),${JSON.stringify(snapshot)}::jsonb,${scope}::uuid,${userId}::uuid,${input.revisionId}::uuid)`.execute(
                    tx,
                );
                for (const step of steps.rows)
                    await sql`insert into meal.cooking_steps(id,position,status,attempt_id) values(${randomUUID()}::uuid,${step.position},'pending',${id}::uuid)`.execute(
                        tx,
                    );
                return this.get(tx, scope, id);
            }),
        );
    }
    async progress(userId: string, id: string, input: z.infer<typeof cookingProgressSchema>) {
        await this.lifecycle?.reconcileUser(userId, id);
        return personalWorkflow(this.database, userId, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'cooking', id, input, async () => {
                const receivedAt = Date.now();
                const occurredAt = Date.parse(input.occurredAt);
                if (occurredAt > receivedAt + 5 * 60_000 || occurredAt < receivedAt - 30 * 86_400_000)
                    throw new HttpException('Время действия готовки вне допустимого периода', 422);
                const next = progressAttempt(await this.get(tx, scope, id), input, occurredAt);
                for (const step of next.steps)
                    await sql`update meal.cooking_steps set status=${step.status},private_note=${step.privateNote},timer_deadline=${step.timerDeadline}::timestamptz,timer_paused_seconds=${step.timerPausedSeconds},version=version+1 where attempt_id=${id}::uuid and position=${step.position}`.execute(
                        tx,
                    );
                await sql`update meal.cooking_attempts set status=${next.status},version=version+1 where id=${id}::uuid and scope_id=${scope}::uuid and version=${input.version}`.execute(
                    tx,
                );
                return next;
            }),
        );
    }
    async finalize(userId: string, id: string, input: z.infer<typeof cookingFinalizeSchema>) {
        await this.lifecycle?.reconcileUser(userId, id);
        return personalWorkflow(this.database, userId, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'cooking', `${id}:finalize`, input, async () => {
                const attempt = await this.get(tx, scope, id);
                if (attempt.version !== input.version) throw new HttpException('Приготовление изменилось', 412);
                if (!['active', 'paused'].includes(attempt.status))
                    throw new HttpException('Приготовление уже завершено', 409);
                const operationId = randomUUID();
                await sql`insert into meal.inventory_operations(id,kind,effective_at,recorded_at,status,idempotency_key,scope_id,actor_id) values(${operationId}::uuid,'cooking',now(),now(),'completed',${`cooking:${input.idempotencyKey}`},${scope}::uuid,${userId}::uuid)`.execute(
                    tx,
                );
                const sourceVersions = new Map<string, number>();
                for (const use of [...input.inputs].sort((a, b) => a.batchId.localeCompare(b.batchId))) {
                    const batches = await sql<{
                        id: string;
                        name: string;
                        kind: string;
                        quantity: string | null;
                        version: number;
                        unit_id: string;
                        precision: string;
                        composition_id: string | null;
                        unit: string;
                        locationId: string | null;
                        ingredientId: string | null;
                        openedAt: Date | null;
                        purchasedOn: string | null;
                        expiryOn: string | null;
                        packageState: string;
                        quantitySource: string;
                        confidence: number | null;
                        pricePaidRub: string | null;
                        storeName: string | null;
                        barcode: string | null;
                        createdAt: Date;
                    }>`select b.id,b.name,b.kind,b.quantity::text,b.version::integer,b.unit_id,b.precision,b.composition_id,u.code as unit,b.location_id as "locationId",b.ingredient_id as "ingredientId",b.opened_at as "openedAt",b.purchased_on::text as "purchasedOn",b.expiry_on::text as "expiryOn",b.package_state as "packageState",coalesce(b.metadata->>'quantitySource','user') as "quantitySource",(b.metadata->>'confidence')::double precision as confidence,b.metadata->>'pricePaidRub' as "pricePaidRub",b.metadata->>'storeName' as "storeName",b.barcode_snapshot as barcode,b.created_at as "createdAt" from meal.inventory_batches b join meal.units u on u.id=b.unit_id where b.id=${use.batchId}::uuid and b.scope_id=${scope}::uuid and b.archived_at is null for update of b`.execute(
                        tx,
                    );
                    const batch = batches.rows[0];
                    if (!batch) throw new HttpException('Партия недоступна', 404);
                    const originalVersion = sourceVersions.get(batch.id) ?? batch.version;
                    if (originalVersion !== use.version) throw new HttpException('Остаток партии изменился', 412);
                    sourceVersions.set(batch.id, originalVersion);
                    if (batch.kind !== 'preserve' && (use.containerId || use.containerVersion !== undefined))
                        throw new HttpException('У этой партии нет банок заготовки', 422);
                    const preserve =
                        batch.kind === 'preserve'
                            ? await consumePreserveContainer(
                                  tx,
                                  scope!,
                                  batch.id,
                                  use.containerId,
                                  use.containerVersion,
                                  use.quantity,
                              )
                            : null;
                    const quantity = preserve ? preserve.quantity : consumedRemainder(batch.quantity, use.quantity);
                    const movement = randomUUID();
                    const before = auditSnapshot({
                        ...batch,
                        scope: 'private',
                        openedAt: iso(batch.openedAt),
                        createdAt: iso(batch.createdAt),
                        archivedAt: null,
                    });
                    const after = { ...before, quantity, version: batch.version + 1 };
                    await sql`update meal.inventory_batches set quantity=${quantity}::numeric,quantity_known=${quantity !== null},version=version+1 where id=${batch.id}::uuid and scope_id=${scope}::uuid and version=${batch.version}`.execute(
                        tx,
                    );
                    await sql`insert into meal.inventory_movements(id,quantity_delta,before_snapshot,after_snapshot,base_version,operation_id,batch_id,unit_id) values(${movement}::uuid,${`-${use.quantity}`}::numeric,${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb,${batch.version},${operationId}::uuid,${batch.id}::uuid,${batch.unit_id}::uuid)`.execute(
                        tx,
                    );
                    await sql`insert into meal.cooking_inputs(id,quantity,composition_snapshot,precision,attempt_id,batch_id,movement_id,unit_id,container_id) values(${randomUUID()}::uuid,${use.quantity}::numeric,${JSON.stringify({ ...batch, containerId: use.containerId ?? null })}::jsonb,${batch.precision},${id}::uuid,${batch.id}::uuid,${movement}::uuid,${batch.unit_id}::uuid,${use.containerId ?? null}::uuid)`.execute(
                        tx,
                    );
                    if (preserve)
                        await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,after_redacted,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,'preserve.cooking-consumed','preserve',${preserve.preserveId}::uuid,now(),now(),${JSON.stringify({ attemptId: id, containerId: use.containerId, quantity: use.quantity, before: preserve.containerBefore, after: preserve.containerAfter })}::jsonb,${input.idempotencyKey},${userId}::uuid,${scope}::uuid)`.execute(
                            tx,
                        );
                }
                const batchIds: string[] = [];
                for (const output of input.outputs) {
                    const refs = await sql<{
                        unit_id: string;
                    }>`select u.id as unit_id from meal.units u where u.code=${output.unit} and exists(select 1 from meal.storage_locations l where l.id=${output.locationId}::uuid and l.scope_id=${scope}::uuid and l.archived_at is null)`.execute(
                        tx,
                    );
                    if (!refs.rows[0]) throw new HttpException('Единица или место хранения недоступны', 422);
                    const unit = refs.rows[0].unit_id;
                    const batchId = randomUUID();
                    const fullServings = output.portionQuantity
                        ? (decimal(output.quantity) / decimal(output.portionQuantity)).toString()
                        : null;
                    const snapshot = {
                        ...output,
                        id: batchId,
                        ingredientId: null,
                        scope: 'private',
                        version: 1,
                        openedAt: null,
                        purchasedOn: null,
                        packageState: 'opened',
                        quantitySource: 'recipe',
                        confidence: null,
                        pricePaidRub: null,
                        storeName: null,
                        barcode: null,
                        archivedAt: null,
                        createdAt: new Date().toISOString(),
                        recipeId: attempt.recipeId,
                        revisionId: attempt.revisionId,
                        fullServings,
                    };
                    await sql`insert into meal.inventory_batches(id,kind,name,quantity,quantity_known,precision,package_state,expiry_on,scope_id,unit_id,location_id,created_by,metadata) values(${batchId}::uuid,'prepared',${output.name},${output.quantity}::numeric,true,${output.precision},'opened',${output.expiryOn}::date,${scope}::uuid,${unit}::uuid,${output.locationId}::uuid,${userId}::uuid,${JSON.stringify(snapshot)}::jsonb)`.execute(
                        tx,
                    );
                    await sql`insert into meal.inventory_movements(id,quantity_delta,before_snapshot,after_snapshot,operation_id,batch_id,unit_id) values(${randomUUID()}::uuid,${output.quantity}::numeric,'null'::jsonb,${JSON.stringify(auditSnapshot(snapshot))}::jsonb,${operationId}::uuid,${batchId}::uuid,${unit}::uuid)`.execute(
                        tx,
                    );
                    await sql`insert into meal.cooking_outputs(id,quantity,yield_snapshot,attempt_id,batch_id,unit_id) values(${randomUUID()}::uuid,${output.quantity}::numeric,${JSON.stringify(snapshot)}::jsonb,${id}::uuid,${batchId}::uuid,${unit}::uuid)`.execute(
                        tx,
                    );
                    batchIds.push(batchId);
                }
                await sql`update meal.cooking_steps set timer_deadline=null,timer_paused_seconds=null,version=version+1 where attempt_id=${id}::uuid`.execute(
                    tx,
                );
                await sql`update meal.cooking_attempts set status=${input.outcome},completed_at=now(),confirmed_duration=${input.confirmedDuration},private_note=${input.privateNote},output_snapshot=${JSON.stringify({ batchIds, outcome: input.outcome, inputs: input.inputs, outputs: input.outputs })}::jsonb,version=version+1 where id=${id}::uuid and scope_id=${scope}::uuid and version=${input.version}`.execute(
                    tx,
                );
                if (input.outcome === 'completed') {
                    const recipe = await sql<{
                        recipeId: string;
                        authorId: string;
                    }>`select rr.recipe_id as "recipeId",r.author_id as "authorId" from meal.recipe_revisions rr join meal.recipes r on r.id=rr.recipe_id where rr.id=${attempt.revisionId}::uuid`.execute(
                        tx,
                    );
                    const value = recipe.rows[0];
                    await this.releases?.processAchievementEventIn(tx, userId, 'recipe.cooked', {
                        recipeId: value?.recipeId ?? null,
                        attemptId: id,
                    });
                    if (value && value.authorId !== userId) {
                        await this.releases?.recordReputationEventIn(
                            tx,
                            value.authorId,
                            'first-independent-cook',
                            value.recipeId,
                            `independent-cook:${userId}:${value.recipeId}`,
                            { recipeId: value.recipeId, cookUserId: userId, attemptId: id },
                        );
                        await this.releases?.processAchievementEventIn(
                            tx,
                            value.authorId,
                            'recipe.cooked_by_independent',
                            { recipeId: value.recipeId, cookUserId: userId, attemptId: id },
                        );
                    }
                }
                return this.get(tx, scope, id);
            }),
        );
    }
}
