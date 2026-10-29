import { HttpException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { z } from 'zod';
import type { WorkflowTx } from '../../shared/workflow/workflow.store.js';
import { decimal, decimalText } from '../inventory/inventory.domain.js';
import type { purchaseReviewSchema } from './receipts.contracts.js';
type Review = z.infer<typeof purchaseReviewSchema>;
export async function reviewPurchase(
    tx: WorkflowTx,
    userId: string,
    scope: string | null,
    target: string,
    input: Review,
    listId: string | null,
) {
    const seen = new Set<string>();
    const reviewed = [];
    for (const line of input.lines) {
        if (line.isFood && !line.ingredientId)
            throw new HttpException('Перед подтверждением сопоставьте пищевую строку с каталогом', 422);
        if (seen.has(line.id)) throw new HttpException('Повтор строки', 422);
        seen.add(line.id);
        if (
            line.intake &&
            (!line.isFood || line.quantity === null || !line.unit || !line.ingredientId || !line.locationId)
        )
            throw new HttpException('Для поступления нужны продукт, количество, единица и место', 422);
        if (line.unit && !(await sql`select id from meal.units where code=${line.unit}`.execute(tx)).rows.length)
            throw new HttpException('Единица не найдена', 422);
        if (
            line.ingredientId &&
            !(
                await sql`select id from meal.ingredients where id=${line.ingredientId}::uuid and status in ('active','approved','published')`.execute(
                    tx,
                )
            ).rows.length
        )
            throw new HttpException('Ингредиент недоступен', 422);
        if (
            line.productId &&
            !(
                await sql`select p.id from meal.brand_products p join meal.ingredient_variants v on v.id=p.variant_id where p.id=${line.productId}::uuid and p.status in ('active','approved','published') and (${line.ingredientId}::uuid is null or v.ingredient_id=${line.ingredientId}::uuid)`.execute(
                    tx,
                )
            ).rows.length
        )
            throw new HttpException('Товар недоступен', 422);
        if (
            line.locationId &&
            !(
                await sql`select id from meal.storage_locations where id=${line.locationId}::uuid and scope_id=${scope}::uuid and archived_at is null`.execute(
                    tx,
                )
            ).rows.length
        )
            throw new HttpException('Место недоступно', 422);
        let allocated: bigint | null = null,
            remaining: bigint | null = null,
            overage: bigint | null = null;
        if (line.shoppingItemId) {
            if (!listId) throw new HttpException('Позиция списка недоступна', 422);
            const row = (
                await sql<{
                    quantity: string | null;
                    unit: string | null;
                    allocated: string;
                    productId: string | null;
                    ingredientId: string | null;
                    allowAnalog: boolean;
                }>`select i.quantity::text,u.code as unit,coalesce((select sum(a.quantity) from meal.shopping_allocations a where a.item_id=i.id),0)::text as allocated,i.product_id as "productId",i.ingredient_id as "ingredientId",i.allow_analog as "allowAnalog" from meal.shopping_items i join meal.shopping_lists l on l.id=i.list_id left join meal.units u on u.id=i.unit_id where i.id=${line.shoppingItemId}::uuid and l.id=${listId}::uuid and l.scope_id=${scope}::uuid and l.status='active' and i.status<>'removed' for update of i`.execute(
                    tx,
                )
            ).rows[0];
            if (!row) throw new HttpException('Позиция недоступна', 404);
            if (
                row.unit !== line.unit ||
                (!row.allowAnalog && row.productId !== line.productId) ||
                (row.ingredientId && row.ingredientId !== line.ingredientId)
            )
                throw new HttpException('Товар или единица не соответствуют потребности', 422);
            if (row.quantity !== null && line.quantity !== null) {
                const need = decimal(row.quantity) - decimal(row.allocated);
                const positive = need > 0n ? need : 0n;
                const actual = decimal(line.quantity);
                allocated = actual < positive ? actual : positive;
                remaining = positive - allocated;
                overage = actual - allocated;
            }
        }
        reviewed.push({
            id: line.id,
            allocatedQuantity: allocated === null ? null : decimalText(allocated),
            remainingNeed: remaining === null ? null : decimalText(remaining),
            overage: overage === null ? null : decimalText(overage),
            intake: line.intake,
        });
    }
    if (
        new Set(input.lines.flatMap((l) => (l.shoppingItemId ? [l.shoppingItemId] : []))).size !==
        input.lines.filter((l) => l.shoppingItemId).length
    )
        throw new HttpException('Одна потребность не может повторяться в review', 422);
    return {
        previewToken: createHash('sha256')
            .update(JSON.stringify({ userId, scope, target, input, reviewed }))
            .digest('hex'),
        lines: reviewed,
    };
}
export async function commitPurchase(
    tx: WorkflowTx,
    userId: string,
    scope: string | null,
    target: string,
    input: Review & { previewToken: string; idempotencyKey: string },
    listId: string | null,
    receiptId: string | null,
) {
    const review = await reviewPurchase(
        tx,
        userId,
        scope,
        target,
        { version: input.version, purchasedAt: input.purchasedAt, lines: input.lines, scope: input.scope },
        listId,
    );
    if (review.previewToken !== input.previewToken) throw new HttpException('Предпросмотр устарел', 409);
    const purchaseId = randomUUID(),
        batchIds: string[] = [],
        unknownLineIds: string[] = [];
    await sql`insert into meal.purchases(id,purchased_at,status,source,scope_id,actor_id,receipt_id) values(${purchaseId}::uuid,${input.purchasedAt}::timestamptz,'confirmed',${receiptId ? 'receipt' : 'shopping'},${scope}::uuid,${userId}::uuid,${receiptId}::uuid)`.execute(
        tx,
    );
    for (const [index, line] of input.lines.entries()) {
        const lineId = randomUUID(),
            unit = line.unit
                ? (await sql<{ id: string }>`select id from meal.units where code=${line.unit}`.execute(tx)).rows[0]!.id
                : null;
        const receiptLineId = receiptId ? randomUUID() : null;
        if (receiptId)
            await sql`insert into meal.receipt_lines(id,position,raw_name,quantity,amount_minor,discount_minor,is_food,provenance,receipt_id,product_id,ingredient_id,unit_id) values(${receiptLineId}::uuid,${index},${line.name},${line.quantity}::numeric,${line.amountMinor}::bigint,${line.discountMinor}::bigint,${line.isFood},${JSON.stringify({ reviewed: true, sourceLineId: line.id })}::jsonb,${receiptId}::uuid,${line.productId}::uuid,${line.ingredientId}::uuid,${unit}::uuid)`.execute(
                tx,
            );
        await sql`insert into meal.purchase_lines(id,name,quantity,amount_minor,original_amount_minor,is_food,purchase_id,ingredient_id,product_id,unit_id,receipt_line_id,shopping_item_id) values(${lineId}::uuid,${line.name},${line.quantity}::numeric,${line.amountMinor}::bigint,${line.originalAmountMinor}::bigint,${line.isFood},${purchaseId}::uuid,${line.ingredientId}::uuid,${line.productId}::uuid,${unit}::uuid,${receiptLineId}::uuid,${line.shoppingItemId}::uuid)`.execute(
            tx,
        );
        if (line.quantity === null) unknownLineIds.push(lineId);
        const allocation = review.lines[index]!.allocatedQuantity;
        if (line.shoppingItemId && allocation !== null && decimal(allocation) > 0n) {
            await sql`insert into meal.shopping_allocations(id,quantity,item_id,purchase_line_id,unit_id) values(${randomUUID()}::uuid,${allocation}::numeric,${line.shoppingItemId}::uuid,${lineId}::uuid,${unit}::uuid)`.execute(
                tx,
            );
            await sql`update meal.shopping_items set status=${review.lines[index]!.remainingNeed === '0' ? 'purchased' : 'pending'},version=version+1 where id=${line.shoppingItemId}::uuid and list_id=${listId}::uuid`.execute(
                tx,
            );
        }
        if (!line.intake) continue;
        batchIds.push(await intakePurchaseLine(tx, userId, scope, purchaseId, lineId, line, input.purchasedAt, unit));
    }
    if (listId)
        await sql`update meal.shopping_lists set version=version+1 where id=${listId}::uuid and scope_id=${scope}::uuid`.execute(
            tx,
        );
    return { purchaseId, batchIds, unknownLineIds };
}

export async function intakePurchaseLine(
    tx: WorkflowTx,
    userId: string,
    scope: string | null,
    purchaseId: string,
    lineId: string,
    line: Review['lines'][number],
    purchasedAt: string,
    unit: string | null,
) {
    const batchId = randomUUID(),
        operation = randomUUID(),
        movement = randomUUID();

    await sql`insert into meal.inventory_batches(id,kind,name,quantity,quantity_known,precision,package_state,purchased_on,expiry_on,scope_id,unit_id,location_id,ingredient_id,product_id,variant_id,created_by,metadata) values(${batchId}::uuid,'ingredient',${line.name},${line.quantity}::numeric,true,'exact','unknown',(${purchasedAt}::timestamptz at time zone 'UTC')::date,${line.expiryOn}::date,${scope}::uuid,${unit}::uuid,${line.locationId}::uuid,${line.ingredientId}::uuid,${line.productId}::uuid,(select variant_id from meal.brand_products where id=${line.productId}::uuid),${userId}::uuid,'{"quantitySource":"receipt"}'::jsonb)`.execute(
        tx,
    );
    await sql`insert into meal.inventory_operations(id,kind,effective_at,recorded_at,status,idempotency_key,scope_id,actor_id) values(${operation}::uuid,'purchase',${purchasedAt}::timestamptz,now(),'completed',${`purchase:${purchaseId}:${lineId}`},${scope}::uuid,${userId}::uuid)`.execute(
        tx,
    );
    const snapshot = {
        id: batchId,
        name: line.name,
        quantity: line.quantity,
        unit: line.unit,
        locationId: line.locationId,
        ingredientId: line.ingredientId,
        openedAt: null,
        purchasedOn: purchasedAt.slice(0, 10),
        expiryOn: line.expiryOn,
        packageState: 'unknown',
        precision: 'exact',
        quantitySource: 'receipt',
        confidence: null,
        pricePaidRub: null,
        storeName: null,
        barcode: null,
        scope: 'private',
        version: 1,
        archivedAt: null,
        createdAt: new Date().toISOString(),
    };
    await sql`insert into meal.inventory_movements(id,quantity_delta,before_snapshot,after_snapshot,operation_id,batch_id,unit_id) values(${movement}::uuid,${line.quantity}::numeric,'null'::jsonb,${JSON.stringify(snapshot)}::jsonb,${operation}::uuid,${batchId}::uuid,${unit}::uuid)`.execute(
        tx,
    );
    await sql`insert into meal.stock_intakes(id,quantity,purchase_line_id,batch_id,movement_id,unit_id) values(${randomUUID()}::uuid,${line.quantity}::numeric,${lineId}::uuid,${batchId}::uuid,${movement}::uuid,${unit}::uuid)`.execute(
        tx,
    );
    return batchId;
}
