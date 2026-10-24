import { HttpException } from '@nestjs/common';
import { sql } from 'kysely';
import type { WorkflowTx } from '../cooking/workflow.store.js';
import { preserveRemainder, preserveTotal } from './preserves.domain.js';
export async function consumePreserveContainer(
    tx: WorkflowTx,
    scope: string,
    batchId: string,
    containerId: string | undefined,
    containerVersion: number | undefined,
    quantity: string,
) {
    if (!containerId || containerVersion === undefined)
        throw new HttpException('Выберите конкретную банку заготовки', 422);
    const row = (
        await sql<{
            id: string;
            preserve_id: string;
            remaining_quantity: string | null;
            version: number;
        }>`select c.id,c.preserve_id,c.remaining_quantity::text,c.version::integer from meal.preserve_containers c join meal.preserve_details p on p.id=c.preserve_id join meal.inventory_batches b on b.id=p.batch_id where b.id=${batchId}::uuid and b.scope_id=${scope}::uuid and b.archived_at is null and c.id=${containerId}::uuid for update of c,p`.execute(
            tx,
        )
    ).rows[0];
    if (!row) throw new HttpException('Банка не найдена', 404);
    if (row.version !== containerVersion) throw new HttpException('Банка изменилась', 412);
    const remaining = preserveRemainder(row.remaining_quantity, quantity);
    await sql`update meal.preserve_containers set remaining_quantity=${remaining}::numeric,depleted_at=case when ${remaining}::numeric=0 then now() else null end,updated_at=now(),version=version+1 where id=${containerId}::uuid and preserve_id=${row.preserve_id}::uuid and version=${containerVersion}`.execute(
        tx,
    );
    const quantities = (
        await sql<{
            remaining_quantity: string | null;
        }>`select remaining_quantity::text from meal.preserve_containers where preserve_id=${row.preserve_id}::uuid`.execute(
            tx,
        )
    ).rows;
    await sql`update meal.preserve_details set version=version+1 where id=${row.preserve_id}::uuid`.execute(tx);
    return {
        preserveId: row.preserve_id,
        quantity: preserveTotal(quantities.map((c) => c.remaining_quantity)),
        containerBefore: row.remaining_quantity,
        containerAfter: remaining,
    };
}
