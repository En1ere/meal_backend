import { createHash, randomUUID } from 'node:crypto';
import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { ProAccessService } from '../pro-overview/pro-access.service.js';
import {
    financeCostEstimateSchema,
    financePriceCatalogSchema,
    financePriceListSchema,
    financePriceObservationResultSchema,
    financePriceObservationSchema,
    financeResolvedPriceSchema,
    type FinancePriceObservationCreate,
} from './finance.contracts.js';

type Tx = Transaction<DatabaseSchema>;
type ObservationRow = {
    id: string;
    ingredientId: string;
    ingredientName: string;
    unit: string;
    quantity: string;
    amountMinor: string | number | bigint;
    observedAt: Date;
    provenance: unknown;
    eligibleForAggregate: boolean;
    version: string | number | bigint;
    createdAt: Date;
};
type PriceRow = {
    ingredientId: string;
    ingredientName: string;
    unit: string;
    amountMinor: string | number | bigint;
    observedAt: Date | null;
    sampleCount: number;
    methodVersion: string;
    source: 'personal_latest' | 'system_median';
};
type CostLine = { ingredientId: string | null; name: string; quantity: string | null; unit: string | null };

const disclaimer = 'Примерная стоимость. Цены зависят от региона, магазина, бренда и даты покупки.';
const observation = (row: ObservationRow) => {
    const provenance = (row.provenance ?? {}) as Record<string, unknown>;
    return financePriceObservationSchema.parse({
        id: row.id,
        ingredientId: row.ingredientId,
        ingredientName: row.ingredientName,
        unit: row.unit,
        quantity: row.quantity,
        amountMinor: Number(row.amountMinor),
        currency: 'RUB',
        observedAt: new Date(row.observedAt).toISOString(),
        source: provenance.source === 'receipt' ? 'receipt' : 'manual',
        consentedAt: typeof provenance.consentedAt === 'string' ? provenance.consentedAt : row.createdAt.toISOString(),
        eligibleForAggregate: false,
        version: Number(row.version),
        createdAt: new Date(row.createdAt).toISOString(),
    });
};
const resolved = (row: PriceRow) =>
    financeResolvedPriceSchema.parse({
        ingredientId: row.ingredientId,
        ingredientName: row.ingredientName,
        unit: row.unit,
        amountMinor: Number(row.amountMinor),
        perQuantity: '1',
        currency: 'RUB',
        source: row.source,
        observedAt: row.observedAt ? new Date(row.observedAt).toISOString() : null,
        sampleCount: Number(row.sampleCount),
        methodVersion: row.methodVersion,
    });

@Injectable()
export class PricingService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: ProAccessService,
    ) {}

    private async ready() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
    }

    private async scope(tx: Tx, userId: string) {
        const row = await tx
            .selectFrom('data_scopes')
            .select('id')
            .where('kind', '=', 'private')
            .where('user_id', '=', userId)
            .executeTakeFirst();
        if (row) return row.id;
        const id = randomUUID();
        await tx.insertInto('data_scopes').values({ id, kind: 'private', user_id: userId, family_id: null }).execute();
        return id;
    }

    private cutoff(mode: string, periodEndsAt: string | null) {
        return mode === 'read_only' ? periodEndsAt : null;
    }

    private async observationRows(tx: Tx, userId: string, cutoff: string | null) {
        return (
            await sql<ObservationRow>`select po.id,po.ingredient_id as "ingredientId",i.name as "ingredientName",
                u.code as unit,po.quantity::text,po.amount_minor as "amountMinor",po.observed_at as "observedAt",
                po.provenance,po.eligible_for_aggregate as "eligibleForAggregate",po.version,po.created_at as "createdAt"
                from meal.price_observations po join meal.data_scopes ds on ds.id=po.scope_id
                join meal.ingredients i on i.id=po.ingredient_id join meal.units u on u.id=po.unit_id
                where ds.kind='private' and ds.user_id=${userId}::uuid
                  and (${cutoff}::timestamptz is null or po.created_at<=${cutoff}::timestamptz)
                order by po.observed_at desc,po.id desc limit 200`.execute(tx)
        ).rows;
    }

    private async resolvePrice(tx: Tx, userId: string, ingredientId: string, unit: string, cutoff: string | null) {
        const personal = (
            await sql<PriceRow>`select po.ingredient_id as "ingredientId",i.name as "ingredientName",u.code as unit,
                round(po.amount_minor/po.quantity)::bigint as "amountMinor",po.observed_at as "observedAt",1::int as "sampleCount",
                'personal-latest-v1'::text as "methodVersion",'personal_latest'::text as source
                from meal.price_observations po join meal.data_scopes ds on ds.id=po.scope_id
                join meal.ingredients i on i.id=po.ingredient_id join meal.units u on u.id=po.unit_id
                where ds.kind='private' and ds.user_id=${userId}::uuid and po.ingredient_id=${ingredientId}::uuid
                  and u.code=${unit} and (${cutoff}::timestamptz is null or po.created_at<=${cutoff}::timestamptz)
                order by po.observed_at desc,po.id desc limit 1`.execute(tx)
        ).rows[0];
        if (personal) return resolved(personal);
        const aggregate = (
            await sql<PriceRow>`select pa.ingredient_id as "ingredientId",i.name as "ingredientName",u.code as unit,
                pa.median_minor as "amountMinor",null::timestamptz as "observedAt",pa.sample_count as "sampleCount",
                pa.method_version as "methodVersion",'system_median'::text as source
                from meal.price_aggregates pa join meal.ingredients i on i.id=pa.ingredient_id
                join meal.units u on u.id=pa.unit_id where pa.ingredient_id=${ingredientId}::uuid and u.code=${unit}
                  and (${cutoff}::timestamptz is null or pa.calculated_at<=${cutoff}::timestamptz)
                order by pa.calculated_at desc,pa.id desc limit 1`.execute(tx)
        ).rows[0];
        return aggregate ? resolved(aggregate) : null;
    }

    async catalog(userId: string) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            const access = await this.access.resolve(userId, tx);
            const items = (
                await sql<{
                    ingredientId: string;
                    name: string;
                    unit: string;
                }>`select i.id as "ingredientId",i.name,u.code as unit
                    from meal.ingredients i join meal.units u on u.id=i.default_unit_id
                    where i.status='active' order by i.name,i.id limit 300`.execute(tx)
            ).rows;
            return financePriceCatalogSchema.parse({ access, items });
        });
    }

    async list(userId: string) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            const access = await this.access.resolve(userId, tx);
            const cutoff = this.cutoff(access.mode, access.periodEndsAt);
            const items = (await this.observationRows(tx, userId, cutoff)).map(observation);
            const keys = [...new Map(items.map((item) => [`${item.ingredientId}:${item.unit}`, item])).values()];
            const prices = await Promise.all(
                keys.map((item) => this.resolvePrice(tx, userId, item.ingredientId, item.unit, cutoff)),
            );
            return financePriceListSchema.parse({
                access,
                scope: 'private',
                currency: 'RUB',
                disclaimer,
                items,
                resolved: prices.filter((item) => item !== null),
            });
        });
    }

    async create(userId: string, input: FinancePriceObservationCreate) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            const access = await this.access.requireActive(userId, tx);
            const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            const prior = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', 'finance-price')
                .where('target_binding', '=', 'observation:new')
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (prior) {
                if (prior.request_hash !== hash) throw new HttpException('Ключ уже использован с другими данными', 409);
                return financePriceObservationResultSchema.parse(prior.response_snapshot);
            }
            const reference = (
                await sql<{ ingredientName: string; unitId: string }>`select i.name as "ingredientName",u.id as "unitId"
                from meal.ingredients i join meal.units u on u.code=${input.unit}
                where i.id=${input.ingredientId}::uuid and i.status='active' limit 1`.execute(tx)
            ).rows[0];
            if (!reference) throw new HttpException('Ингредиент или единица не найдены', 404);
            const scopeId = await this.scope(tx, userId);
            const id = randomUUID();
            const now = new Date();
            const provenance = { source: 'manual', consentedAt: now.toISOString(), private: true };
            await tx
                .insertInto('price_observations')
                .values({
                    id,
                    amount_minor: input.amountMinor,
                    quantity: input.quantity,
                    observed_at: input.observedAt,
                    provenance: JSON.stringify(provenance),
                    eligible_for_aggregate: false,
                    scope_id: scopeId,
                    ingredient_id: input.ingredientId,
                    purchase_line_id: null,
                    unit_id: reference.unitId,
                    created_at: now,
                    version: 1,
                })
                .execute();
            const item = observation({
                id,
                ingredientId: input.ingredientId,
                ingredientName: reference.ingredientName,
                unit: input.unit,
                quantity: input.quantity,
                amountMinor: input.amountMinor,
                observedAt: new Date(input.observedAt),
                provenance,
                eligibleForAggregate: false,
                version: 1,
                createdAt: now,
            });
            const price = await this.resolvePrice(tx, userId, input.ingredientId, input.unit, null);
            if (!price) throw new ServiceUnavailableException();
            const result = financePriceObservationResultSchema.parse({ access, observation: item, resolved: price });
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'finance-price',
                    target_binding: 'observation:new',
                    key: input.idempotencyKey,
                    request_hash: hash,
                    status: 'completed',
                    response_snapshot: JSON.stringify(result),
                    expires_at: new Date('9999-12-31T00:00:00Z'),
                    user_id: userId,
                    scope_id: null,
                    actor_namespace: `user:${userId}`,
                })
                .execute();
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: 'finance.price-observation.created',
                    target_type: 'price_observation',
                    target_id: id,
                    effective_at: now,
                    recorded_at: now,
                    reason: null,
                    before_redacted: null,
                    after_redacted: JSON.stringify({
                        ingredientId: input.ingredientId,
                        unit: input.unit,
                        amountMinor: input.amountMinor,
                    }),
                    request_id: input.idempotencyKey,
                    actor_id: userId,
                    scope_id: scopeId,
                })
                .execute();
            return result;
        });
    }

    private async estimate(
        userId: string,
        type: 'recipe' | 'shopping_list' | 'meal_plan',
        id: string,
        servings?: number,
    ) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            const access = await this.access.resolve(userId, tx);
            const cutoff = this.cutoff(access.mode, access.periodEndsAt);
            let title = '';
            let lines: CostLine[] = [];
            if (type === 'recipe') {
                const header = (
                    await sql<{
                        title: string;
                        revisionId: string;
                        portions: number;
                    }>`select rr.title,rr.id as "revisionId",rr.portions
                    from meal.recipes r join meal.recipe_revisions rr on rr.recipe_id=r.id
                    where r.id=${id}::uuid and r.archived_at is null and (r.author_id=${userId}::uuid or exists(
                      select 1 from meal.recipe_publications p where p.revision_id=rr.id and p.unpublished_at is null and p.published_at<=now()))
                    order by rr.revision desc,rr.id desc limit 1`.execute(tx)
                ).rows[0];
                if (!header) throw new HttpException('Рецепт не найден', 404);
                title = header.title;
                const multiplier = (servings ?? header.portions) / header.portions;
                lines = (
                    await sql<CostLine>`select ri.ingredient_id as "ingredientId",coalesce(i.name,rr.title,'Неуточнённый ингредиент') as name,
                    case when ri.quantity is null then null else (ri.quantity*${multiplier}::numeric)::numeric(24,8)::text end as quantity,u.code as unit
                    from meal.recipe_ingredients ri left join meal.ingredients i on i.id=ri.ingredient_id
                    left join meal.recipes source on source.id=ri.source_recipe_id left join meal.recipe_revisions rr on rr.recipe_id=source.id
                    left join meal.units u on u.id=ri.unit_id where ri.revision_id=${header.revisionId}::uuid and not ri.optional
                    order by ri.position,ri.id`.execute(tx)
                ).rows;
            } else if (type === 'shopping_list') {
                const header = (
                    await sql<{
                        title: string;
                    }>`select l.title from meal.shopping_lists l join meal.data_scopes ds on ds.id=l.scope_id
                    where l.id=${id}::uuid and ds.kind='private' and ds.user_id=${userId}::uuid`.execute(tx)
                ).rows[0];
                if (!header) throw new HttpException('Список не найден', 404);
                title = header.title;
                lines = (
                    await sql<CostLine>`select si.ingredient_id as "ingredientId",si.name,si.quantity::text,u.code as unit
                    from meal.shopping_items si left join meal.units u on u.id=si.unit_id where si.list_id=${id}::uuid and si.status<>'removed'
                    order by si.position,si.id`.execute(tx)
                ).rows;
            } else {
                const header = (
                    await sql<{
                        title: string;
                        revisionId: string;
                    }>`select mp.name as title,pr.id as "revisionId" from meal.meal_plans mp
                    join meal.data_scopes ds on ds.id=mp.scope_id join meal.plan_revisions pr on pr.plan_id=mp.id and pr.status='active'
                    where mp.id=${id}::uuid and mp.archived_at is null and ds.kind='private' and ds.user_id=${userId}::uuid
                    order by pr.revision desc,pr.id desc limit 1`.execute(tx)
                ).rows[0];
                if (!header) throw new HttpException('План не найден', 404);
                title = header.title;
                lines = (
                    await sql<CostLine>`select ri.ingredient_id as "ingredientId",coalesce(i.name,'Неуточнённый ингредиент') as name,
                    case when ri.quantity is null then null else sum(ri.quantity*pe.portions/rr.portions)::numeric(24,8)::text end as quantity,u.code as unit
                    from meal.plan_entries pe join meal.recipe_revisions rr on rr.id=pe.recipe_revision_id
                    join meal.recipe_ingredients ri on ri.revision_id=rr.id and not ri.optional
                    left join meal.ingredients i on i.id=ri.ingredient_id left join meal.units u on u.id=ri.unit_id
                    where pe.revision_id=${header.revisionId}::uuid group by ri.ingredient_id,i.name,u.code,ri.quantity order by i.name nulls last`.execute(
                        tx,
                    )
                ).rows;
            }
            if (lines.length > 500) throw new HttpException('Слишком много строк для одной оценки', 422);
            const priced = await Promise.all(
                lines.map(async (line) => {
                    const reason = !line.ingredientId
                        ? 'unknown_ingredient'
                        : !line.quantity
                          ? 'unknown_quantity'
                          : !line.unit
                            ? 'unknown_unit'
                            : null;
                    const price = reason
                        ? null
                        : await this.resolvePrice(tx, userId, line.ingredientId!, line.unit!, cutoff);
                    const estimatedMinor =
                        price && line.quantity ? Math.round(price.amountMinor * Number(line.quantity)) : null;
                    return {
                        ...line,
                        estimatedMinor,
                        price,
                        reason: reason ?? (price ? 'priced' : 'price_unavailable'),
                    };
                }),
            );
            const known = priced.filter((line) => line.estimatedMinor !== null);
            const knownSubtotalMinor = known.reduce((sum, line) => sum + line.estimatedMinor!, 0);
            const complete = priced.length > 0 && known.length === priced.length;
            return financeCostEstimateSchema.parse({
                access,
                subject: { type, id, title },
                currency: 'RUB',
                approximate: true,
                disclaimer,
                complete,
                knownLineCount: known.length,
                totalLineCount: priced.length,
                knownSubtotalMinor,
                estimatedTotalMinor: complete ? knownSubtotalMinor : null,
                lines: priced,
            });
        });
    }

    recipeCost(userId: string, id: string, servings?: number) {
        return this.estimate(userId, 'recipe', id, servings);
    }
    shoppingCost(userId: string, id: string) {
        return this.estimate(userId, 'shopping_list', id);
    }
    mealPlanCost(userId: string, id: string) {
        return this.estimate(userId, 'meal_plan', id);
    }
}
