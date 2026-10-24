import { Injectable, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { scopedWorkflow, workflowReplay, type WorkflowTx } from '../cooking/workflow.store.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { ProAccessService } from '../pro-overview/pro-access.service.js';
import {
    receiptSchema,
    type receiptCreateSchema,
    type receiptEditSchema,
    type receiptLinkSchema,
    type purchaseReviewSchema,
    type purchaseCommitSchema,
} from './receipts.contracts.js';
import { reviewPurchase, commitPurchase } from './purchase.store.js';
@Injectable()
export class ReceiptsService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly proAccess: ProAccessService,
    ) {}
    capabilities() {
        return {
            photo: true as const,
            electronicLink: true as const,
            pdfUpload: false as const,
            ocrAdapter: false as const,
            pdfUnavailableReason: 'storage_not_configured' as const,
        };
    }
    private hasProData(value: { source?: { kind: string }; financial?: unknown }) {
        return value.source?.kind === 'electronic_link' || value.financial != null;
    }
    private validateFinancial(
        lines: z.infer<typeof receiptSchema>['lines'],
        financial: z.infer<typeof receiptSchema>['financial'],
    ) {
        if (!financial) return;
        if (lines.some((line) => line.amountMinor === null || line.amountMinor <= 0))
            throw new HttpException('Для финансового чека укажите оплаченную сумму каждой позиции', 422);
        const total = lines.reduce((sum, line) => sum + (line.amountMinor ?? 0), 0);
        if (total !== financial.totalMinor)
            throw new HttpException('Сумма позиций должна совпадать с итогом чека', 422);
        if (
            lines.some(
                (line) => line.originalAmountMinor !== null && line.originalAmountMinor < (line.amountMinor ?? 0),
            )
        )
            throw new HttpException('Цена до скидки не может быть меньше оплаченной', 422);
    }
    private async get(tx: WorkflowTx, scope: string | null, id: string) {
        const row = (
            await sql<{
                version: number;
                status: string;
                raw: unknown;
            }>`select version::integer,status,raw_review_snapshot as raw from meal.receipts where id=${id}::uuid and scope_id=${scope}::uuid`.execute(
                tx,
            )
        ).rows[0];
        if (!row) throw new HttpException('Чек не найден', 404);
        const receipt = receiptSchema.parse({ ...(row.raw as object), id, status: row.status, version: row.version });
        if (receipt.result) {
            const lines = await sql<{
                id: string;
                quantity: string | null;
                batchIds: string[];
            }>`select l.id,l.quantity::text,coalesce((select jsonb_agg(s.batch_id) from meal.stock_intakes s where s.purchase_line_id=l.id),'[]'::jsonb) as "batchIds" from meal.purchase_lines l join meal.purchases p on p.id=l.purchase_id where p.id=${receipt.result.purchaseId}::uuid and p.scope_id=${scope}::uuid`.execute(
                tx,
            );
            receipt.result.batchIds = lines.rows.flatMap((l) => l.batchIds);
            receipt.result.unknownLineIds = lines.rows.filter((l) => l.quantity === null).map((l) => l.id);
        }
        return receipt;
    }
    detail(user: string, id: string, requestedScope: 'private' | 'family' = 'private') {
        return scopedWorkflow(this.database, this.entitlements, user, requestedScope, false, async (tx, scope) => ({
            receipt: await this.get(tx, scope, id),
        }));
    }
    create(user: string, input: z.infer<typeof receiptCreateSchema>) {
        const requestedScope = input.scope ?? 'private';
        if (input.financial && requestedScope !== 'private')
            throw new HttpException('Финансовый чек можно сохранить только в личной области', 422);
        return scopedWorkflow(this.database, this.entitlements, user, requestedScope, true, (tx, scope) =>
            workflowReplay(tx, user, scope, 'receipt', `${requestedScope}:create`, input, async () => {
                if (this.hasProData(input)) await this.proAccess.requireActive(user, tx);
                this.validateFinancial(input.lines, input.financial);
                const id = randomUUID();
                const receipt = {
                    id,
                    version: 1,
                    status: 'draft' as const,
                    source: input.source,
                    ocrText: input.ocrText,
                    lines: input.lines,
                    financial: input.financial ? { ...input.financial, consentedAt: new Date().toISOString() } : null,
                    result: null,
                    history: [{ action: 'created', at: new Date().toISOString() }],
                };
                await sql`insert into meal.receipts(id,status,raw_review_snapshot,scope_id,created_by) values(${id}::uuid,'draft',${JSON.stringify(receipt)}::jsonb,${scope}::uuid,${user}::uuid)`.execute(
                    tx,
                );
                await this.audit(tx, user, scope, id, 'receipt.created', receipt, input.idempotencyKey);
                return { receipt };
            }),
        );
    }
    edit(user: string, id: string, input: z.infer<typeof receiptEditSchema>) {
        const requestedScope = input.scope ?? 'private';
        return scopedWorkflow(this.database, this.entitlements, user, requestedScope, true, (tx, scope) =>
            workflowReplay(tx, user, scope, 'receipt', `${requestedScope}:${id}:edit`, input, async () => {
                const r = await this.get(tx, scope, id);
                this.check(r, input.version);
                const financial =
                    input.financial === undefined
                        ? r.financial
                        : input.financial
                          ? {
                                ...input.financial,
                                consentedAt: r.financial?.consentedAt ?? new Date().toISOString(),
                            }
                          : null;
                if (financial) await this.proAccess.requireActive(user, tx);
                this.validateFinancial(input.lines, financial);
                r.lines = input.lines;
                r.financial = financial;
                r.version++;
                r.history.push({ action: 'corrected', at: new Date().toISOString() });
                await sql`update meal.receipts set raw_review_snapshot=${JSON.stringify(r)}::jsonb,version=version+1 where id=${id}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                await this.audit(tx, user, scope, id, `receipt.${r.history.at(-1)!.action}`, r, input.idempotencyKey);
                return { receipt: r };
            }),
        );
    }
    private async audit(
        tx: WorkflowTx,
        user: string,
        scope: string | null,
        id: string,
        action: string,
        snapshot: unknown,
        key: string,
    ) {
        await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,after_redacted,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,${action},'receipt',${id}::uuid,now(),now(),${JSON.stringify(snapshot)}::jsonb,${key}::uuid,${user}::uuid,${scope}::uuid)`.execute(
            tx,
        );
    }
    private check(r: z.infer<typeof receiptSchema>, version: number) {
        if (r.version !== version) throw new HttpException('Чек изменился', 412);
        if (r.status !== 'draft')
            throw new HttpException('Поступление уже подтверждено или чек связан с покупкой', 409);
    }
    preview(user: string, id: string, input: z.infer<typeof purchaseReviewSchema>) {
        return scopedWorkflow(
            this.database,
            this.entitlements,
            user,
            input.scope ?? 'private',
            false,
            async (tx, scope) => {
                const r = await this.get(tx, scope, id);
                this.check(r, input.version);
                if (r.financial) {
                    await this.proAccess.requireActive(user, tx);
                    this.validateFinancial(input.lines, r.financial);
                }
                return reviewPurchase(tx, user, scope, id, input, null);
            },
        );
    }
    commit(user: string, id: string, input: z.infer<typeof purchaseCommitSchema>) {
        const requestedScope = input.scope ?? 'private';
        return scopedWorkflow(this.database, this.entitlements, user, requestedScope, true, (tx, scope) =>
            workflowReplay(tx, user, scope, 'receipt', `${requestedScope}:${id}:commit`, input, async () => {
                const r = await this.get(tx, scope, id);
                this.check(r, input.version);
                if (r.financial) {
                    await this.proAccess.requireActive(user, tx);
                    this.validateFinancial(input.lines, r.financial);
                }
                const result = await commitPurchase(tx, user, scope, id, input, null, id);
                r.lines = input.lines;
                r.result = result;
                r.status = 'committed';
                r.version++;
                r.history.push({ action: 'committed', at: new Date().toISOString() });
                await sql`update meal.receipts set status='committed',purchased_at=${input.purchasedAt}::timestamptz,linked_purchase_id=${result.purchaseId}::uuid,raw_review_snapshot=${JSON.stringify(r)}::jsonb,version=version+1 where id=${id}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                if (r.financial) {
                    const consentedAt = r.financial.consentedAt ?? new Date().toISOString();
                    await sql`insert into meal.expenses(id,kind,amount_minor,currency,occurred_at,finance_consent_at,scope_id,purchase_line_id,actor_id)
                        select gen_random_uuid(),case when l.is_food then 'groceries' else 'other' end,l.amount_minor,'RUB',${input.purchasedAt}::timestamptz,${consentedAt}::timestamptz,${scope}::uuid,l.id,${user}::uuid
                        from meal.purchase_lines l where l.purchase_id=${result.purchaseId}::uuid and l.amount_minor is not null`.execute(
                        tx,
                    );
                    await sql`insert into meal.price_observations(id,amount_minor,quantity,observed_at,provenance,eligible_for_aggregate,scope_id,ingredient_id,purchase_line_id,unit_id)
                        select gen_random_uuid(),l.amount_minor,l.quantity,${input.purchasedAt}::timestamptz,
                        jsonb_build_object('source','receipt','receiptId',${id}::text,'private',true,'consentedAt',${consentedAt}::text),false,${scope}::uuid,l.ingredient_id,l.id,l.unit_id
                        from meal.purchase_lines l where l.purchase_id=${result.purchaseId}::uuid and l.is_food and l.amount_minor is not null and l.quantity>0 and l.ingredient_id is not null and l.unit_id is not null`.execute(
                        tx,
                    );
                }
                await this.audit(tx, user, scope, id, `receipt.${r.history.at(-1)!.action}`, r, input.idempotencyKey);
                return { receipt: r };
            }),
        );
    }
    duplicates(user: string, id: string, requestedScope: 'private' | 'family' = 'private') {
        return scopedWorkflow(this.database, this.entitlements, user, requestedScope, false, async (tx, scope) => {
            await this.get(tx, scope, id);
            const rows = await sql<{
                purchaseId: string;
                purchasedAt: Date;
                lineNames: string[];
                lineCount: number;
            }>`select p.id as "purchaseId",p.purchased_at as "purchasedAt",coalesce((select jsonb_agg(l.name) from meal.purchase_lines l where l.purchase_id=p.id),'[]'::jsonb) as "lineNames",(select count(*)::integer from meal.purchase_lines l where l.purchase_id=p.id) as "lineCount" from meal.purchases p where scope_id=${scope}::uuid order by purchased_at desc,id limit 20`.execute(
                tx,
            );
            return {
                items: rows.rows.map((r) => ({
                    ...r,
                    purchasedAt: r.purchasedAt.toISOString(),
                    reason: 'review-required' as const,
                })),
            };
        });
    }
    link(user: string, id: string, input: z.infer<typeof receiptLinkSchema>) {
        const requestedScope = input.scope ?? 'private';
        return scopedWorkflow(this.database, this.entitlements, user, requestedScope, true, (tx, scope) =>
            workflowReplay(tx, user, scope, 'receipt', `${requestedScope}:${id}:link`, input, async () => {
                const r = await this.get(tx, scope, id);
                this.check(r, input.version);
                const purchase = (
                    await sql<{
                        receipt_id: string | null;
                    }>`select receipt_id from meal.purchases where id=${input.purchaseId}::uuid and scope_id=${scope}::uuid for update`.execute(
                        tx,
                    )
                ).rows[0];
                if (!purchase) throw new HttpException('Покупка не найдена', 404);
                if (!purchase.receipt_id)
                    await sql`update meal.purchases set receipt_id=${id}::uuid,version=version+1 where id=${input.purchaseId}::uuid and scope_id=${scope}::uuid`.execute(
                        tx,
                    );
                const batches = await sql<{
                    id: string;
                }>`select s.batch_id as id from meal.stock_intakes s join meal.purchase_lines l on l.id=s.purchase_line_id where l.purchase_id=${input.purchaseId}::uuid`.execute(
                    tx,
                );
                const unknown = await sql<{
                    id: string;
                }>`select id from meal.purchase_lines where purchase_id=${input.purchaseId}::uuid and quantity is null`.execute(
                    tx,
                );
                r.result = {
                    purchaseId: input.purchaseId,
                    batchIds: batches.rows.map((b) => b.id),
                    unknownLineIds: unknown.rows.map((line) => line.id),
                };
                r.status = 'linked';
                r.version++;
                r.history.push({ action: 'linked-existing-purchase', at: new Date().toISOString() });
                await sql`update meal.receipts set status='linked',linked_purchase_id=${input.purchaseId}::uuid,raw_review_snapshot=${JSON.stringify(r)}::jsonb,version=version+1 where id=${id}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                await this.audit(tx, user, scope, id, `receipt.${r.history.at(-1)!.action}`, r, input.idempotencyKey);
                return { receipt: r };
            }),
        );
    }
}
