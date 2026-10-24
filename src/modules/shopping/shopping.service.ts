import { Injectable, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { scopedWorkflow, workflowReplay, type WorkflowTx } from '../cooking/workflow.store.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { RecipesService } from '../recipes/recipes.service.js';
import { decimal, decimalText } from '../inventory/inventory.domain.js';
import { purchaseReviewSchema, purchaseCommitSchema } from '../receipts/receipts.contracts.js';
import { reviewPurchase, commitPurchase } from '../receipts/purchase.store.js';
import {
    shoppingItemSchema,
    shoppingListQuerySchema,
    shoppingCommandSchema,
    shoppingReorderSchema,
    type shoppingCreateSchema,
    type shoppingAddSchema,
    type shoppingEditSchema,
    type shoppingFieldsSchema,
} from './shopping.contracts.js';

@Injectable()
export class ShoppingService {
    constructor(
        private readonly database: DatabaseService,
        private readonly recipes: RecipesService,
        private readonly entitlements: EntitlementsService,
    ) {}
    private async audit(tx: WorkflowTx, actorId: string, scopeId: string, listId: string, action: string, key: string) {
        await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,${action},'shopping_list',${listId}::uuid,now(),now(),${key}::uuid,${actorId}::uuid,${scopeId}::uuid)`.execute(
            tx,
        );
    }
    private async listRow(tx: WorkflowTx, scope: string | null, id: string) {
        const result = await sql<{
            id: string;
            title: string;
            version: number;
            status: string;
            createdAt: Date;
            scope: 'private' | 'family';
        }>`select l.id,l.title,l.version::integer,l.status,l.created_at as "createdAt",case when s.kind='family' then 'family' else 'private' end as scope from meal.shopping_lists l join meal.data_scopes s on s.id=l.scope_id where l.id=${id}::uuid and l.scope_id=${scope}::uuid`.execute(
            tx,
        );
        if (!result.rows[0]) throw new HttpException('Список не найден', 404);
        return result.rows[0];
    }
    private async get(tx: WorkflowTx, scope: string | null, id: string) {
        const list = await this.listRow(tx, scope, id);
        const items = await sql<
            Record<string, unknown>
        >`select i.id,i.version::integer,i.name,i.quantity::text,u.code as unit,i.ingredient_id as "ingredientId",i.product_id as "productId",i.allow_analog as "allowAnalog",i.status,i.position,i.manual,i.requirements,(select sum(a.quantity)::text from meal.shopping_allocations a where a.item_id=i.id) as "allocatedQuantity",i.origin_snapshot as origin,i.origin_snapshot as "recipeOrigin",i.estimated_price_minor::double precision as "estimatedPriceMinor" from meal.shopping_items i left join meal.units u on u.id=i.unit_id where i.list_id=${id}::uuid and i.status<>'removed' order by i.position,i.created_at,i.id`.execute(
            tx,
        );
        const parsed = items.rows.map((row) => shoppingItemSchema.parse(row));
        return {
            ...list,
            createdAt: list.createdAt.toISOString(),
            progress: { total: parsed.length, purchased: parsed.filter((i) => i.status === 'purchased').length },
            items: parsed,
        };
    }
    list(userId: string, q: z.infer<typeof shoppingListQuerySchema> = shoppingListQuerySchema.parse({})) {
        return scopedWorkflow(
            this.database,
            this.entitlements,
            userId,
            q.scope,
            false,
            async (tx, scope) => {
                const rows = await sql<{
                    id: string;
                    title: string;
                    version: number;
                    status: 'active' | 'completed' | 'archived';
                    createdAt: Date;
                    scope: 'private' | 'family';
                    total: number;
                    purchased: number;
                }>`with page as (
                    select l.id,l.title,l.version,l.status,l.created_at,l.scope_id
                    from meal.shopping_lists l
                    where l.scope_id=${scope}::uuid
                      and (${q.status}='all' or l.status=${q.status})
                      and l.title ilike ${`%${q.q}%`}
                      and (${q.cursor ?? null}::uuid is null or (l.created_at,l.id)<(
                          select c.created_at,c.id from meal.shopping_lists c
                          where c.id=${q.cursor ?? null}::uuid and c.scope_id=${scope}::uuid
                      ))
                    order by l.created_at desc,l.id desc
                    limit ${q.limit + 1}
                )
                select p.id,p.title,p.version::integer,p.status,p.created_at as "createdAt",
                  case when s.kind='family' then 'family' else 'private' end as scope,
                  count(i.id) filter(where i.status<>'removed')::integer as total,
                  count(i.id) filter(where i.status='purchased')::integer as purchased
                from page p join meal.data_scopes s on s.id=p.scope_id
                left join meal.shopping_items i on i.list_id=p.id
                group by p.id,p.title,p.version,p.status,p.created_at,s.kind
                order by p.created_at desc,p.id desc`.execute(tx);
                const items = rows.rows.slice(0, q.limit).map((row) => ({
                    id: row.id,
                    title: row.title,
                    version: row.version,
                    status: row.status,
                    createdAt: row.createdAt.toISOString(),
                    scope: row.scope,
                    progress: { total: row.total, purchased: row.purchased },
                }));
                return { items, nextCursor: rows.rows.length > q.limit ? items.at(-1)!.id : null };
            },
            { items: [], nextCursor: null },
        );
    }
    command(userId: string, id: string, input: z.infer<typeof shoppingCommandSchema>) {
        const requestedScope = input.scope ?? 'private';
        return scopedWorkflow(this.database, this.entitlements, userId, requestedScope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'shopping', `${requestedScope}:${id}:command`, input, async () => {
                const l = await this.listRow(tx, scope, id);
                if (l.version !== input.version) throw new HttpException('Список изменился', 412);
                let status = l.status;
                if (input.action === 'rename') {
                    if (status === 'archived' || !input.title) throw new HttpException('Изменение недоступно', 409);
                } else if (input.action === 'archive') {
                    if (status === 'archived') throw new HttpException('Уже в архиве', 409);
                } else if (input.action === 'restore') {
                    if (status !== 'archived') throw new HttpException('Список не архивирован', 409);
                } else {
                    if (status === 'archived') throw new HttpException('Восстановите список', 409);
                    status = input.action === 'complete' ? 'completed' : 'active';
                }
                await sql`update meal.shopping_lists set title=${input.action === 'rename' ? input.title! : l.title},archived_from=case when ${input.action}='archive' then status else archived_from end,status=case when ${input.action}='archive' then 'archived' when ${input.action}='restore' then coalesce(archived_from,'active') else ${status} end,version=version+1 where id=${id}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                await this.audit(tx, userId, scope, id, `shopping.${input.action}`, input.idempotencyKey);
                return this.get(tx, scope, id);
            }),
        );
    }
    reorder(userId: string, id: string, input: z.infer<typeof shoppingReorderSchema>) {
        const requestedScope = input.scope ?? 'private';
        return scopedWorkflow(this.database, this.entitlements, userId, requestedScope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'shopping', `${requestedScope}:${id}:reorder`, input, async () => {
                const l = await this.get(tx, scope, id);
                if (l.version !== input.version) throw new HttpException('Список изменился', 412);
                if (l.status !== 'active') throw new HttpException('Список недоступен для изменений', 409);
                if (
                    input.itemIds.length !== l.items.length ||
                    new Set(input.itemIds).size !== input.itemIds.length ||
                    input.itemIds.some((i) => !l.items.some((j) => j.id === i))
                )
                    throw new HttpException('Нужен полный порядок строк', 422);
                for (const [position, itemId] of input.itemIds.entries())
                    await sql`update meal.shopping_items set position=${position},version=version+1 where id=${itemId}::uuid and list_id=${id}::uuid`.execute(
                        tx,
                    );
                await sql`update meal.shopping_lists set version=version+1 where id=${id}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                await this.audit(tx, userId, scope, id, 'shopping.reordered', input.idempotencyKey);
                return this.get(tx, scope, id);
            }),
        );
    }
    purchasePreview(userId: string, id: string, input: z.infer<typeof purchaseReviewSchema>) {
        return scopedWorkflow(
            this.database,
            this.entitlements,
            userId,
            input.scope ?? 'private',
            false,
            async (tx, scope) => {
                const l = await this.listRow(tx, scope, id);
                if (l.version !== input.version) throw new HttpException('Список изменился', 412);
                if (l.status !== 'active') throw new HttpException('Список не активен', 409);
                return reviewPurchase(tx, userId, scope, id, input, id);
            },
        );
    }
    purchaseCommit(userId: string, id: string, input: z.infer<typeof purchaseCommitSchema>) {
        const requestedScope = input.scope ?? 'private';
        return scopedWorkflow(this.database, this.entitlements, userId, requestedScope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'shopping', `${requestedScope}:${id}:purchase`, input, async () => {
                const l = await this.listRow(tx, scope, id);
                if (l.version !== input.version) throw new HttpException('Список изменился', 412);
                if (l.status !== 'active') throw new HttpException('Список не активен', 409);
                const result = await commitPurchase(tx, userId, scope, id, input, id, null);
                await this.audit(tx, userId, scope, id, 'shopping.purchase-committed', input.idempotencyKey);
                return result;
            }),
        );
    }
    detail(userId: string, id: string, requestedScope: 'private' | 'family' = 'private') {
        return scopedWorkflow(this.database, this.entitlements, userId, requestedScope, false, async (tx, scope) => ({
            ...(await this.get(tx, scope, id)),
            scope: requestedScope,
        }));
    }
    create(userId: string, input: z.infer<typeof shoppingCreateSchema>) {
        const requestedScope = input.scope ?? 'private';
        return scopedWorkflow(this.database, this.entitlements, userId, requestedScope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'shopping', `${requestedScope}:create`, input, async () => {
                const id = randomUUID();
                await sql`insert into meal.shopping_lists(id,title,status,scope_id,created_by) values(${id}::uuid,${input.title},'active',${scope}::uuid,${userId}::uuid)`.execute(
                    tx,
                );
                await this.audit(tx, userId, scope, id, 'shopping.created', input.idempotencyKey);
                return { ...(await this.get(tx, scope, id)), scope: requestedScope };
            }),
        );
    }
    private async references(tx: WorkflowTx, userId: string, fields: z.input<typeof shoppingFieldsSchema>) {
        if (fields.quantity !== null && fields.unit === null)
            throw new HttpException('Укажите единицу количества', 422);
        let unitId: string | null = null;
        if (fields.unit) {
            const row = (await sql<{ id: string }>`select id from meal.units where code=${fields.unit}`.execute(tx))
                .rows[0];
            if (!row) throw new HttpException('Неизвестная единица', 422);
            unitId = row.id;
        }
        if (fields.ingredientId) {
            const row = (
                await sql`select i.id from meal.ingredients i where i.id=${fields.ingredientId}::uuid and (i.status in ('active','approved','published') or exists(select 1 from meal.catalog_proposals cp join meal.brand_products bp on bp.id=cp.product_id join meal.ingredient_variants v on v.id=bp.variant_id where v.ingredient_id=i.id and cp.author_id=${userId}::uuid and cp.status in ('draft','pending','submitted','needs_changes')))`.execute(
                    tx,
                )
            ).rows[0];
            if (!row) throw new HttpException('Ингредиент недоступен', 422);
        }
        if (fields.productId) {
            const row = (
                await sql`select p.id from meal.brand_products p join meal.ingredient_variants v on v.id=p.variant_id where p.id=${fields.productId}::uuid and (${fields.ingredientId}::uuid is null or v.ingredient_id=${fields.ingredientId}::uuid) and (p.status in ('active','approved','published') or exists(select 1 from meal.catalog_proposals cp where cp.product_id=p.id and cp.author_id=${userId}::uuid and cp.status in ('draft','pending','submitted','needs_changes')))`.execute(
                    tx,
                )
            ).rows[0];
            if (!row) throw new HttpException('Товар недоступен', 422);
        }
        for (const origin of fields.recipeOrigin ?? []) {
            if (
                !(
                    await sql`select rr.id from meal.recipe_revisions rr join meal.recipes r on r.id=rr.recipe_id where rr.id=${origin.revisionId}::uuid and r.archived_at is null and r.status not in ('hidden','deleted','archived') and (r.author_id=${userId}::uuid or exists(select 1 from meal.recipe_publications p where p.revision_id=rr.id and p.unpublished_at is null and p.published_at<=now()))`.execute(
                        tx,
                    )
                ).rows.length
            )
                throw new HttpException('Источник рецепта недоступен', 422);
        }
        return unitId;
    }
    add(userId: string, id: string, input: z.input<typeof shoppingAddSchema>) {
        const requestedScope = input.scope ?? 'private';
        return scopedWorkflow(this.database, this.entitlements, userId, requestedScope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'shopping', `${requestedScope}:${id}:add`, input, async () => {
                const list = await this.listRow(tx, scope, id);
                if (list.status !== 'active') throw new HttpException('Список не активен', 409);
                if (list.version !== input.version) throw new HttpException('Список изменился', 412);
                for (const fields of input.items) {
                    const unit = await this.references(tx, userId, fields);
                    await sql`insert into meal.shopping_items(id,name,quantity,requirements,allow_analog,manual,status,list_id,ingredient_id,product_id,unit_id,estimated_price_minor,origin_snapshot,position) values(${randomUUID()}::uuid,${fields.name},${fields.quantity}::numeric,${JSON.stringify(fields.requirements ?? {})}::jsonb,${fields.allowAnalog},${!fields.recipeOrigin?.length},'pending',${id}::uuid,${fields.ingredientId}::uuid,${fields.productId}::uuid,${unit}::uuid,${fields.estimatedPriceMinor ?? null},${JSON.stringify(fields.recipeOrigin ?? [])}::jsonb,coalesce((select max(position)+1 from meal.shopping_items where list_id=${id}::uuid),0))`.execute(
                        tx,
                    );
                }
                await sql`update meal.shopping_lists set version=version+1 where id=${id}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                await this.audit(tx, userId, scope, id, 'shopping.items-added', input.idempotencyKey);
                return this.get(tx, scope, id);
            }),
        );
    }
    edit(userId: string, id: string, itemId: string, input: z.input<typeof shoppingEditSchema>) {
        const requestedScope = input.scope ?? 'private';
        return scopedWorkflow(this.database, this.entitlements, userId, requestedScope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'shopping', `${requestedScope}:${id}:${itemId}`, input, async () => {
                const list = await this.listRow(tx, scope, id);
                if (list.status !== 'active') throw new HttpException('Список не активен', 409);
                const item = (
                    await sql<{
                        version: number;
                        ingredient_id: string | null;
                        product_id: string | null;
                        position: number;
                    }>`select version::integer,ingredient_id,product_id,position from meal.shopping_items where id=${itemId}::uuid and list_id=${id}::uuid and status<>'removed' for update`.execute(
                        tx,
                    )
                ).rows[0];
                if (!item) throw new HttpException('Позиция не найдена', 404);
                if (item.version !== input.version) throw new HttpException('Позиция изменилась', 412);
                if (
                    (
                        await sql`select id from meal.shopping_allocations where item_id=${itemId}::uuid limit 1`.execute(
                            tx,
                        )
                    ).rows.length
                )
                    throw new HttpException('Купленная потребность неизменна', 409);
                const fields = input.fields;
                const unit = await this.references(tx, userId, fields);
                if (item.ingredient_id !== fields.ingredientId || item.product_id !== fields.productId) {
                    await sql`update meal.shopping_items set status='removed',version=version+1 where id=${itemId}::uuid and list_id=${id}::uuid and version=${input.version}`.execute(
                        tx,
                    );
                    if (input.status !== 'removed')
                        await sql`insert into meal.shopping_items(id,name,quantity,requirements,allow_analog,manual,status,list_id,ingredient_id,product_id,unit_id,estimated_price_minor,origin_snapshot,position) values(${randomUUID()}::uuid,${fields.name},${fields.quantity}::numeric,${JSON.stringify(fields.requirements ?? {})}::jsonb,${fields.allowAnalog},${!fields.recipeOrigin?.length},${input.status},${id}::uuid,${fields.ingredientId}::uuid,${fields.productId}::uuid,${unit}::uuid,${fields.estimatedPriceMinor ?? null},${JSON.stringify(fields.recipeOrigin ?? [])}::jsonb,${item.position})`.execute(
                            tx,
                        );
                } else {
                    await sql`update meal.shopping_items set name=${fields.name},quantity=${fields.quantity}::numeric,unit_id=${unit}::uuid,origin_snapshot=${JSON.stringify(fields.recipeOrigin ?? [])}::jsonb,requirements=${JSON.stringify(fields.requirements ?? {})}::jsonb,estimated_price_minor=${fields.estimatedPriceMinor ?? null},allow_analog=${fields.allowAnalog},status=${input.status},version=version+1 where id=${itemId}::uuid and list_id=${id}::uuid and version=${input.version}`.execute(
                        tx,
                    );
                }
                await sql`update meal.shopping_lists set version=version+1 where id=${id}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                await this.audit(tx, userId, scope, id, `shopping.item-${input.status}`, input.idempotencyKey);
                return this.get(tx, scope, id);
            }),
        );
    }
    history(userId: string, id: string, requestedScope: 'private' | 'family' = 'private') {
        return scopedWorkflow(this.database, this.entitlements, userId, requestedScope, false, async (tx, scope) => {
            await this.listRow(tx, scope, id);
            const rows = await sql<{
                id: string;
                action: string;
                actorId: string | null;
                actorLogin: string | null;
                at: Date;
            }>`select e.id,e.action,e.actor_id as "actorId",u.login as "actorLogin",e.recorded_at as at from meal.audit_events e left join meal.users u on u.id=e.actor_id where e.scope_id=${scope}::uuid and e.target_type='shopping_list' and e.target_id=${id}::uuid order by e.recorded_at desc,e.id desc limit 100`.execute(
                tx,
            );
            return { items: rows.rows.map((row) => ({ ...row, at: row.at.toISOString() })) };
        });
    }
    async preview(userId: string, recipeId: string, servings: number) {
        const detail = await this.recipes.detail(recipeId);
        const personal = await this.recipes.personal(userId, recipeId, servings);
        const items = detail.recipe.ingredients;
        return {
            recipeId,
            servings,
            items: items.flatMap((line) => {
                const state = personal.availability.items.find((i) => i.id === line.id);
                if (!state || line.optional) return [];
                let quantity: string | null = null;
                if (state.requiredQuantity !== null && state.availableQuantity !== null) {
                    const missing = decimal(state.requiredQuantity) - decimal(state.availableQuantity);
                    if (missing <= 0n) return [];
                    quantity = decimalText(missing);
                } else if (!state.present) quantity = state.requiredQuantity;
                else if (!state.needsQuantityCheck) return [];
                return [
                    {
                        name: line.name,
                        quantity,
                        unit: line.unit,
                        ingredientId: line.ingredientId,
                        productId: line.productId,
                        allowAnalog: line.productId === null,
                        needsQuantityCheck: state.needsQuantityCheck,
                        requirements: {},
                        estimatedPriceMinor: null,
                        recipeOrigin: [{ revisionId: detail.recipe.revisionId, portions: servings, quantity }],
                    },
                ];
            }),
        };
    }
}
