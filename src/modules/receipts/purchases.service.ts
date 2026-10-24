import { Injectable, HttpException } from '@nestjs/common';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { scopedWorkflow, workflowReplay, type WorkflowTx } from '../cooking/workflow.store.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import {
    purchaseDetailSchema,
    type purchaseResolveSchema,
    type purchaseResolveCommitSchema,
} from './receipts.contracts.js';
import { reviewPurchase, intakePurchaseLine } from './purchase.store.js';
@Injectable()
export class PurchasesService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
    ) {}
    private async get(tx: WorkflowTx, scope: string | null, id: string) {
        const p = (
            await sql<{
                purchaseId: string;
                version: number;
                purchasedAt: Date;
            }>`select id as "purchaseId",version::integer,purchased_at as "purchasedAt" from meal.purchases where id=${id}::uuid and scope_id=${scope}::uuid`.execute(
                tx,
            )
        ).rows[0];
        if (!p) throw new HttpException('Покупка не найдена', 404);
        const rows = await sql<
            Record<string, unknown>
        >`select l.id,l.version::integer,l.name,l.quantity::text,u.code as unit,l.ingredient_id as "ingredientId",l.product_id as "productId",l.is_food as "isFood",null as "locationId",l.shopping_item_id as "shoppingItemId",null as "expiryOn",exists(select 1 from meal.stock_intakes s where s.purchase_line_id=l.id) as intake,coalesce((select jsonb_agg(s.batch_id) from meal.stock_intakes s where s.purchase_line_id=l.id),'[]'::jsonb) as "batchIds" from meal.purchase_lines l left join meal.units u on u.id=l.unit_id where l.purchase_id=${id}::uuid order by l.created_at,l.id`.execute(
            tx,
        );
        return purchaseDetailSchema.parse({ ...p, purchasedAt: p.purchasedAt.toISOString(), lines: rows.rows });
    }
    detail(user: string, id: string, requestedScope: 'private' | 'family' = 'private') {
        return scopedWorkflow(this.database, this.entitlements, user, requestedScope, false, (tx, scope) =>
            this.get(tx, scope, id),
        );
    }
    private async check(
        tx: WorkflowTx,
        scope: string | null,
        id: string,
        input: z.infer<typeof purchaseResolveSchema>,
    ) {
        const p = await this.get(tx, scope, id),
            line = p.lines.find((l) => l.id === input.line.id);
        if (!line) throw new HttpException('Строка не найдена', 404);
        if (line.version !== input.version) throw new HttpException('Строка изменилась', 412);
        if (line.intake) throw new HttpException('После поступления количество неизменно', 409);
        if (line.quantity !== null)
            throw new HttpException('Позднее уточнение доступно только для неизвестного количества', 409);
        if (line.unit !== null && line.unit !== input.line.unit)
            throw new HttpException('Зафиксированную единицу покупки менять нельзя', 422);
        if (line.ingredientId !== input.line.ingredientId || line.productId !== input.line.productId)
            throw new HttpException('Идентичность товара покупки менять нельзя', 422);
        if (!input.line.intake || input.line.quantity === null)
            throw new HttpException('Требуется уточнённое поступление без новой потребности', 422);
        if (line.shoppingItemId !== input.line.shoppingItemId)
            throw new HttpException('Связь потребности неизменна', 422);
        return p;
    }
    private async context(tx: WorkflowTx, scope: string | null, line: z.infer<typeof purchaseResolveSchema>['line']) {
        if (!line.shoppingItemId) return null;
        const row = (
            await sql<{
                id: string;
            }>`select l.id from meal.shopping_lists l join meal.shopping_items i on i.list_id=l.id where i.id=${line.shoppingItemId}::uuid and l.scope_id=${scope}::uuid and l.status='active' and i.status<>'removed' and not exists(select 1 from meal.shopping_allocations a where a.purchase_line_id=${line.id}::uuid)`.execute(
                tx,
            )
        ).rows[0];
        return row?.id ?? null;
    }
    preview(user: string, id: string, input: z.infer<typeof purchaseResolveSchema>) {
        return scopedWorkflow(
            this.database,
            this.entitlements,
            user,
            input.scope ?? 'private',
            false,
            async (tx, scope) => {
                const p = await this.check(tx, scope, id, input);
                const listId = await this.context(tx, scope, input.line);
                return reviewPurchase(
                    tx,
                    user,
                    scope,
                    id,
                    {
                        version: input.version,
                        purchasedAt: p.purchasedAt,
                        lines: [{ ...input.line, shoppingItemId: listId ? input.line.shoppingItemId : null }],
                        scope: input.scope,
                    },
                    listId,
                );
            },
        );
    }
    commit(user: string, id: string, input: z.infer<typeof purchaseResolveCommitSchema>) {
        const requestedScope = input.scope ?? 'private';
        return scopedWorkflow(this.database, this.entitlements, user, requestedScope, true, (tx, scope) =>
            workflowReplay(
                tx,
                user,
                scope,
                'purchase',
                `${requestedScope}:${id}:resolve:${input.line.id}`,
                input,
                async () => {
                    const p = await this.check(tx, scope, id, input);
                    const listId = await this.context(tx, scope, input.line);
                    const review = await reviewPurchase(
                        tx,
                        user,
                        scope,
                        id,
                        {
                            version: input.version,
                            purchasedAt: p.purchasedAt,
                            lines: [{ ...input.line, shoppingItemId: listId ? input.line.shoppingItemId : null }],
                            scope: input.scope,
                        },
                        listId,
                    );
                    if (review.previewToken !== input.previewToken)
                        throw new HttpException('Предпросмотр устарел', 409);
                    const unit = (
                        await sql<{ id: string }>`select id from meal.units where code=${input.line.unit}`.execute(tx)
                    ).rows[0]!.id;
                    await sql`update meal.purchase_lines set quantity=${input.line.quantity}::numeric,unit_id=${unit}::uuid,name=${input.line.name},version=version+1 where id=${input.line.id}::uuid and purchase_id=${id}::uuid and version=${input.version}`.execute(
                        tx,
                    );
                    const allocated = review.lines[0]!.allocatedQuantity;
                    if (listId && allocated !== null && allocated !== '0') {
                        await sql`insert into meal.shopping_allocations(id,quantity,item_id,purchase_line_id,unit_id) values(${randomUUID()}::uuid,${allocated}::numeric,${input.line.shoppingItemId}::uuid,${input.line.id}::uuid,${unit}::uuid)`.execute(
                            tx,
                        );
                        await sql`update meal.shopping_items set status=${review.lines[0]!.remainingNeed === '0' ? 'purchased' : 'pending'},version=version+1 where id=${input.line.shoppingItemId}::uuid and list_id=${listId}::uuid`.execute(
                            tx,
                        );
                        await sql`update meal.shopping_lists set version=version+1 where id=${listId}::uuid and scope_id=${scope}::uuid`.execute(
                            tx,
                        );
                    }
                    const batch = await intakePurchaseLine(
                        tx,
                        user,
                        scope,
                        id,
                        input.line.id,
                        input.line,
                        p.purchasedAt,
                        unit,
                    );
                    await sql`update meal.purchases set version=version+1 where id=${id}::uuid and scope_id=${scope}::uuid`.execute(
                        tx,
                    );
                    await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,before_redacted,after_redacted,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,'purchase.quantity-resolved','purchase',${id}::uuid,now(),now(),${JSON.stringify(p.lines.find((l) => l.id === input.line.id))}::jsonb,${JSON.stringify({ line: input.line, batchId: batch })}::jsonb,${input.idempotencyKey}::uuid,${user}::uuid,${scope}::uuid)`.execute(
                        tx,
                    );
                    return this.get(tx, scope, id);
                },
            ),
        );
    }
}
