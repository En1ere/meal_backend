import { createHash, randomUUID } from 'node:crypto';
import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { ProAccessService } from '../pro-overview/pro-access.service.js';
import {
    financeBudgetListSchema,
    financeBudgetResultSchema,
    financeBudgetSchema,
    financeExpenseListSchema,
    financeExpenseResultSchema,
    financeExpenseSchema,
    financeOverviewSchema,
    financeAnalyticsSchema,
    type FinanceBudgetCreate,
    type FinanceBudgetUpdate,
    type FinanceExpenseCreate,
    type FinanceExpenseUpdate,
} from './finance.contracts.js';

type Tx = Transaction<DatabaseSchema>;
type ExpenseRow = {
    id: string;
    category: string;
    amountMinor: string | number | bigint;
    occurredAt: Date;
    consentedAt: Date;
    version: string | number | bigint;
    createdAt: Date;
    purchaseLineId: string | null;
};
type BudgetRow = {
    id: string;
    amountMinor: string | number | bigint;
    startsOn: string;
    endsOn: string;
    version: string | number | bigint;
    createdAt: Date;
};

const dateRange = (from: string, to: string) => {
    if (from > to) throw new HttpException('Начало периода позже окончания', 400);
    const days = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (days > 366) throw new HttpException('Период не может превышать 366 дней', 400);
};
const expense = (row: ExpenseRow) =>
    financeExpenseSchema.parse({
        id: row.id,
        source: row.purchaseLineId ? 'receipt' : 'manual',
        category: row.category,
        amountMinor: Number(row.amountMinor),
        currency: 'RUB',
        occurredAt: new Date(row.occurredAt).toISOString(),
        consentedAt: new Date(row.consentedAt).toISOString(),
        version: Number(row.version),
        createdAt: new Date(row.createdAt).toISOString(),
    });
const budget = (row: BudgetRow) =>
    financeBudgetSchema.parse({
        id: row.id,
        amountMinor: Number(row.amountMinor),
        currency: 'RUB',
        startsOn: row.startsOn,
        endsOn: row.endsOn,
        category: null,
        version: Number(row.version),
        createdAt: new Date(row.createdAt).toISOString(),
    });

@Injectable()
export class FinanceService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: ProAccessService,
    ) {}

    private async ready() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
    }

    private async scope(tx: Tx, userId: string) {
        const existing = await tx
            .selectFrom('data_scopes')
            .select('id')
            .where('kind', '=', 'private')
            .where('user_id', '=', userId)
            .executeTakeFirst();
        if (existing) return existing.id;
        const id = randomUUID();
        await tx.insertInto('data_scopes').values({ id, kind: 'private', user_id: userId, family_id: null }).execute();
        return id;
    }

    private dataThrough(periodEndsAt: string | null, to: string) {
        const cutoff = periodEndsAt?.slice(0, 10);
        return cutoff && cutoff < to ? cutoff : to;
    }

    private async expenseRows(tx: Tx, userId: string, from: string, to: string, category: string | null) {
        return (
            await sql<ExpenseRow>`
                select expense.id,expense.kind as category,expense.amount_minor as "amountMinor",
                       expense.occurred_at as "occurredAt",expense.finance_consent_at as "consentedAt",
                       expense.version,expense.created_at as "createdAt",expense.purchase_line_id as "purchaseLineId"
                from meal.expenses expense
                join meal.data_scopes scope on scope.id=expense.scope_id
                where scope.kind='private' and scope.user_id=${userId}::uuid
                  and expense.return_id is null
                  and expense.occurred_at>=${from}::date and expense.occurred_at<(${to}::date+interval '1 day')
                  and (${category}::text is null or expense.kind=${category})
                order by expense.occurred_at desc,expense.id desc
            `.execute(tx)
        ).rows;
    }

    private async budgetRows(tx: Tx, userId: string, createdThrough?: string) {
        return (
            await sql<BudgetRow>`
                select budget.id,budget.amount_minor as "amountMinor",budget.starts_on::text as "startsOn",
                       budget.ends_on::text as "endsOn",budget.version,budget.created_at as "createdAt"
                from meal.budgets budget
                join meal.data_scopes scope on scope.id=budget.scope_id
                where scope.kind='private' and scope.user_id=${userId}::uuid and budget.category_id is null
                  and (${createdThrough ?? null}::date is null or budget.created_at<(${createdThrough ?? null}::date+interval '1 day'))
                order by budget.starts_on desc,budget.created_at desc,budget.id desc
            `.execute(tx)
        ).rows;
    }

    private async replay<T>(tx: Tx, userId: string, target: string, key: string, body: unknown, run: () => Promise<T>) {
        const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const prior = await tx
            .selectFrom('idempotency_records')
            .select(['request_hash', 'response_snapshot'])
            .where('actor_namespace', '=', `user:${userId}`)
            .where('operation', '=', 'finance')
            .where('target_binding', '=', target)
            .where('key', '=', key)
            .executeTakeFirst();
        if (prior) {
            if (prior.request_hash !== hash) throw new HttpException('Ключ уже использован с другими данными', 409);
            return prior.response_snapshot as T;
        }
        const result = await run();
        await tx
            .insertInto('idempotency_records')
            .values({
                id: randomUUID(),
                operation: 'finance',
                target_binding: target,
                key,
                request_hash: hash,
                status: 'completed',
                response_snapshot: JSON.stringify(result),
                expires_at: new Date('9999-12-31T00:00:00Z'),
                user_id: userId,
                scope_id: null,
                actor_namespace: `user:${userId}`,
            })
            .execute();
        return result;
    }

    private async audit(
        tx: Tx,
        userId: string,
        action: string,
        targetType: string,
        targetId: string,
        key: string,
        after: unknown,
    ) {
        await tx
            .insertInto('audit_events')
            .values({
                id: randomUUID(),
                action,
                target_type: targetType,
                target_id: targetId,
                effective_at: new Date(),
                recorded_at: new Date(),
                reason: null,
                before_redacted: null,
                after_redacted: JSON.stringify(after),
                request_id: key,
                actor_id: userId,
                scope_id: null,
            })
            .execute();
    }

    async expenses(userId: string, from: string, to: string, category: string | null) {
        await this.ready();
        dateRange(from, to);
        return this.database.transaction(async (tx) => {
            const access = await this.access.resolve(userId, tx);
            const dataThrough = this.dataThrough(access.periodEndsAt, to);
            const items = (await this.expenseRows(tx, userId, from, dataThrough, category)).map(expense);
            return financeExpenseListSchema.parse({
                access,
                scope: 'private',
                period: { from, to, dataThrough },
                category,
                items,
                totalMinor: items.reduce((sum, item) => sum + item.amountMinor, 0),
                currency: 'RUB',
            });
        });
    }

    async expense(userId: string, id: string) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            const access = await this.access.resolve(userId, tx);
            const cutoff = access.mode === 'read_only' ? access.periodEndsAt : null;
            const row = (
                await sql<ExpenseRow>`
                    select expense.id,expense.kind as category,expense.amount_minor as "amountMinor",
                           expense.occurred_at as "occurredAt",expense.finance_consent_at as "consentedAt",
                           expense.version,expense.created_at as "createdAt",expense.purchase_line_id as "purchaseLineId"
                    from meal.expenses expense join meal.data_scopes scope on scope.id=expense.scope_id
                    where expense.id=${id}::uuid and scope.kind='private' and scope.user_id=${userId}::uuid
                      and expense.return_id is null
                      and (${cutoff}::timestamptz is null or expense.created_at<=${cutoff}::timestamptz)
                `.execute(tx)
            ).rows[0];
            if (!row) throw new HttpException('Расход не найден', 404);
            return financeExpenseResultSchema.parse({ access, expense: expense(row) });
        });
    }

    async createExpense(userId: string, input: FinanceExpenseCreate) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            const access = await this.access.requireActive(userId, tx);
            return this.replay(tx, userId, 'expense:new', input.idempotencyKey, input, async () => {
                const scopeId = await this.scope(tx, userId);
                const id = randomUUID();
                const now = new Date();
                await tx
                    .insertInto('expenses')
                    .values({
                        id,
                        kind: input.category,
                        amount_minor: input.amountMinor,
                        currency: 'RUB',
                        occurred_at: input.occurredAt,
                        finance_consent_at: now,
                        scope_id: scopeId,
                        purchase_line_id: null,
                        return_id: null,
                        actor_id: userId,
                        created_at: now,
                        version: 1,
                    })
                    .execute();
                const result = financeExpenseResultSchema.parse({
                    access,
                    expense: expense({
                        id,
                        category: input.category,
                        amountMinor: input.amountMinor,
                        occurredAt: new Date(input.occurredAt),
                        consentedAt: now,
                        version: 1,
                        createdAt: now,
                        purchaseLineId: null,
                    }),
                });
                await this.audit(
                    tx,
                    userId,
                    'finance.expense.created',
                    'expense',
                    id,
                    input.idempotencyKey,
                    result.expense,
                );
                return result;
            });
        });
    }

    async updateExpense(userId: string, id: string, input: FinanceExpenseUpdate) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            const access = await this.access.requireActive(userId, tx);
            return this.replay(tx, userId, `expense:${id}`, input.idempotencyKey, input, async () => {
                const updated = await sql`
                    update meal.expenses expense set kind=${input.category},amount_minor=${input.amountMinor},
                        occurred_at=${input.occurredAt}::timestamptz,version=expense.version+1
                    from meal.data_scopes scope
                    where expense.id=${id}::uuid and expense.scope_id=scope.id and scope.kind='private'
                      and scope.user_id=${userId}::uuid and expense.purchase_line_id is null and expense.return_id is null
                      and expense.version=${input.expectedVersion}
                `.execute(tx);
                if (Number(updated.numAffectedRows) !== 1)
                    throw new HttpException('Расход изменился или недоступен', 412);
                const row = (
                    await sql<ExpenseRow>`select id,kind as category,amount_minor as "amountMinor",occurred_at as "occurredAt",
                        finance_consent_at as "consentedAt",version,created_at as "createdAt",purchase_line_id as "purchaseLineId" from meal.expenses where id=${id}::uuid`.execute(
                        tx,
                    )
                ).rows[0];
                if (!row) throw new ServiceUnavailableException();
                const result = financeExpenseResultSchema.parse({ access, expense: expense(row) });
                await this.audit(
                    tx,
                    userId,
                    'finance.expense.updated',
                    'expense',
                    id,
                    input.idempotencyKey,
                    result.expense,
                );
                return result;
            });
        });
    }

    async budgets(userId: string) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            const access = await this.access.resolve(userId, tx);
            const cutoff = access.mode === 'read_only' ? access.periodEndsAt?.slice(0, 10) : undefined;
            return financeBudgetListSchema.parse({
                access,
                scope: 'private',
                supportsCategoryBudgets: false,
                items: (await this.budgetRows(tx, userId, cutoff)).map(budget),
            });
        });
    }

    private async assertBudgetPeriod(tx: Tx, scopeId: string, startsOn: string, endsOn: string, exceptId?: string) {
        if (startsOn > endsOn) throw new HttpException('Начало бюджета позже окончания', 400);
        const overlap = await tx
            .selectFrom('budgets')
            .select('id')
            .where('scope_id', '=', scopeId)
            .where('category_id', 'is', null)
            .where('starts_on', '<=', endsOn)
            .where('ends_on', '>=', startsOn)
            .$if(!!exceptId, (query) => query.where('id', '!=', exceptId!))
            .executeTakeFirst();
        if (overlap) throw new HttpException('На этот период уже есть общий бюджет', 409);
    }

    async createBudget(userId: string, input: FinanceBudgetCreate) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            await this.access.requireActive(userId, tx);
            return this.replay(tx, userId, 'budget:new', input.idempotencyKey, input, async () => {
                const scopeId = await this.scope(tx, userId);
                await this.assertBudgetPeriod(tx, scopeId, input.startsOn, input.endsOn);
                const id = randomUUID();
                const now = new Date();
                await tx
                    .insertInto('budgets')
                    .values({
                        id,
                        amount_minor: input.amountMinor,
                        currency: 'RUB',
                        starts_on: input.startsOn,
                        ends_on: input.endsOn,
                        scope_id: scopeId,
                        category_id: null,
                        created_at: now,
                        version: 1,
                    })
                    .execute();
                const result = financeBudgetResultSchema.parse({
                    budget: budget({
                        id,
                        amountMinor: input.amountMinor,
                        startsOn: input.startsOn,
                        endsOn: input.endsOn,
                        version: 1,
                        createdAt: now,
                    }),
                });
                await this.audit(
                    tx,
                    userId,
                    'finance.budget.created',
                    'budget',
                    id,
                    input.idempotencyKey,
                    result.budget,
                );
                return result;
            });
        });
    }

    async updateBudget(userId: string, id: string, input: FinanceBudgetUpdate) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            await this.access.requireActive(userId, tx);
            return this.replay(tx, userId, `budget:${id}`, input.idempotencyKey, input, async () => {
                const scopeId = await this.scope(tx, userId);
                await this.assertBudgetPeriod(tx, scopeId, input.startsOn, input.endsOn, id);
                const updated = await tx
                    .updateTable('budgets')
                    .set({
                        amount_minor: input.amountMinor,
                        starts_on: input.startsOn,
                        ends_on: input.endsOn,
                        version: sql`version+1`,
                    })
                    .where('id', '=', id)
                    .where('scope_id', '=', scopeId)
                    .where('category_id', 'is', null)
                    .where('version', '=', String(input.expectedVersion))
                    .executeTakeFirst();
                if (Number(updated.numUpdatedRows) !== 1)
                    throw new HttpException('Бюджет изменился или недоступен', 412);
                const row = (await this.budgetRows(tx, userId)).find((item) => item.id === id);
                if (!row) throw new ServiceUnavailableException();
                const result = financeBudgetResultSchema.parse({ budget: budget(row) });
                await this.audit(
                    tx,
                    userId,
                    'finance.budget.updated',
                    'budget',
                    id,
                    input.idempotencyKey,
                    result.budget,
                );
                return result;
            });
        });
    }

    async overview(userId: string, from: string, to: string) {
        await this.ready();
        dateRange(from, to);
        return this.database.transaction(async (tx) => {
            const access = await this.access.resolve(userId, tx);
            const dataThrough = this.dataThrough(access.periodEndsAt, to);
            const expenses = (await this.expenseRows(tx, userId, from, dataThrough, null)).map(expense);
            const budgets = (
                await this.budgetRows(tx, userId, access.mode === 'read_only' ? dataThrough : undefined)
            ).map(budget);
            const activeBudget = budgets.find((item) => item.startsOn <= dataThrough && item.endsOn >= from) ?? null;
            const totalMinor = expenses.reduce((sum, item) => sum + item.amountMinor, 0);
            const spent = activeBudget
                ? expenses
                      .filter(
                          (item) =>
                              item.occurredAt.slice(0, 10) >= activeBudget.startsOn &&
                              item.occurredAt.slice(0, 10) <= activeBudget.endsOn,
                      )
                      .reduce((sum, item) => sum + item.amountMinor, 0)
                : null;
            return financeOverviewSchema.parse({
                access,
                scope: 'private',
                period: { from, to, dataThrough },
                expenseCount: expenses.length,
                totalMinor,
                currency: 'RUB',
                budget: activeBudget,
                budgetSpentMinor: spent,
                budgetRemainingMinor: activeBudget && spent !== null ? activeBudget.amountMinor - spent : null,
                forecastAvailable: false,
            });
        });
    }

    async analytics(userId: string, from: string, to: string, category: string | null) {
        await this.ready();
        dateRange(from, to);
        return this.database.transaction(async (tx) => {
            const access = await this.access.resolve(userId, tx);
            const dataThrough = this.dataThrough(access.periodEndsAt, to);
            const days =
                Math.floor((Date.parse(`${dataThrough}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
            if (days < 1) throw new HttpException('Период Pro закончился до выбранного диапазона', 400);
            const rows = (
                await sql<{
                    amountMinor: string | number | bigint;
                    category: string;
                    purchaseId: string | null;
                    receiptId: string | null;
                    originalAmountMinor: string | number | bigint | null;
                    storeName: string | null;
                }>`select e.amount_minor as "amountMinor",e.kind as category,pl.purchase_id as "purchaseId",p.receipt_id as "receiptId",
                pl.original_amount_minor as "originalAmountMinor",nullif(trim(r.raw_review_snapshot->'financial'->>'storeName'),'') as "storeName"
                from meal.expenses e join meal.data_scopes ds on ds.id=e.scope_id
                left join meal.purchase_lines pl on pl.id=e.purchase_line_id left join meal.purchases p on p.id=pl.purchase_id
                left join meal.receipts r on r.id=p.receipt_id
                where ds.kind='private' and ds.user_id=${userId}::uuid and e.return_id is null
                  and e.occurred_at>=${from}::date and e.occurred_at<(${dataThrough}::date+interval '1 day')
                  and (${category}::text is null or e.kind=${category})`.execute(tx)
            ).rows;
            const total = rows.reduce((sum, row) => sum + Number(row.amountMinor), 0);
            const receiptGroups = new Map<string, { amount: number; storeName: string | null }>();
            const categories = new Map<string, { amountMinor: number; count: number }>();
            let knownOriginal = 0,
                savings = 0,
                receiptLines = 0;
            for (const row of rows) {
                const amount = Number(row.amountMinor);
                const group = categories.get(row.category) ?? { amountMinor: 0, count: 0 };
                group.amountMinor += amount;
                group.count++;
                categories.set(row.category, group);
                if (row.receiptId) {
                    receiptLines++;
                    const receipt = receiptGroups.get(row.receiptId) ?? { amount: 0, storeName: row.storeName };
                    receipt.amount += amount;
                    receiptGroups.set(row.receiptId, receipt);
                    if (row.originalAmountMinor !== null) {
                        knownOriginal++;
                        savings += Math.max(0, Number(row.originalAmountMinor) - amount);
                    }
                }
            }
            const stores = new Map<string, { storeName: string | null; amountMinor: number; receiptCount: number }>();
            for (const receipt of receiptGroups.values()) {
                const key = receipt.storeName ?? '__unknown__';
                const item = stores.get(key) ?? { storeName: receipt.storeName, amountMinor: 0, receiptCount: 0 };
                item.amountMinor += receipt.amount;
                item.receiptCount++;
                stores.set(key, item);
            }
            const forecastAvailable = days >= 28 && rows.length >= 3;
            return financeAnalyticsSchema.parse({
                access,
                scope: 'private',
                period: { from, to, dataThrough, days },
                category,
                currency: 'RUB',
                totals: {
                    expenseMinor: total,
                    expenseCount: rows.length,
                    receiptCount: receiptGroups.size,
                    averageReceiptMinor: receiptGroups.size
                        ? Math.round(
                              [...receiptGroups.values()].reduce((sum, item) => sum + item.amount, 0) /
                                  receiptGroups.size,
                          )
                        : null,
                    purchaseFrequencyPer30Days: receiptGroups.size
                        ? Number(((receiptGroups.size * 30) / days).toFixed(2))
                        : null,
                    confirmedSavingsMinor: knownOriginal ? savings : null,
                },
                completeness: {
                    receiptLineCount: receiptLines,
                    originalPriceKnownLineCount: knownOriginal,
                    savingsCoveragePercent: receiptLines
                        ? Number(((knownOriginal / receiptLines) * 100).toFixed(1))
                        : null,
                },
                categories: [...categories.entries()]
                    .map(([name, item]) => ({ category: name, ...item }))
                    .sort((a, b) => b.amountMinor - a.amountMinor),
                stores: [...stores.values()].sort((a, b) => b.amountMinor - a.amountMinor),
                forecast: {
                    available: forecastAvailable,
                    projected30DayMinor: forecastAvailable ? Math.round((total / days) * 30) : null,
                    basisDays: days,
                    reason: forecastAvailable ? 'available' : 'insufficient_history',
                },
            });
        });
    }
}
