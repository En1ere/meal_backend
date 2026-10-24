import { Injectable, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import {
    productDetailSchema,
    productListSchema,
    productReferenceSchema,
    validProductBarcode,
    type ProductProposal,
    type ProductSearch,
} from './products.contracts.js';

type Tx = Transaction<DatabaseSchema>;
const visible = (userId: string) =>
    sql`(i.status in ('active','approved','published') or exists(select 1 from meal.catalog_proposals cp join meal.brand_products bp on bp.id=cp.product_id join meal.ingredient_variants iv on iv.id=bp.variant_id where iv.ingredient_id=i.id and cp.author_id=${userId}::uuid and cp.status in ('draft','pending','submitted','needs_changes')))`;
const summary = sql`i.id,i.name,c.code as "categoryCode",u.code as "defaultUnit",case when i.status in ('active','approved','published') then 'approved' else 'pending' end as status`;
@Injectable()
export class ProductsService {
    constructor(private readonly database: DatabaseService) {}
    private async run<T>(userId: string, write: boolean, work: (tx: Tx) => Promise<T>) {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.transaction(async (tx) => {
            const user = await tx
                .selectFrom('users')
                .select('id')
                .where('id', '=', userId)
                .where('status', '=', 'active')
                .where('archived_at', 'is', null)
                .forUpdate()
                .executeTakeFirst();
            if (!user) throw new HttpException('Аккаунт недоступен', 403);
            if (write) {
                const banned =
                    await sql`select id from meal.sanctions where user_id=${userId}::uuid and scope in ('account','publications') and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                        tx,
                    );
                if (banned.rows.length) throw new HttpException('Доступен только просмотр', 403);
            }
            return work(tx);
        });
    }
    references(userId: string) {
        return this.run(userId, false, async (tx) => {
            const categories = await tx
                .selectFrom('categories')
                .select(['id', 'code', 'name'])
                .orderBy('name')
                .limit(1000)
                .execute();
            const allergens = await tx
                .selectFrom('allergens')
                .select(['code', 'name'])
                .orderBy('name')
                .limit(100)
                .execute();
            return productReferenceSchema.parse({ categories, allergens });
        });
    }
    list(userId: string, q: ProductSearch) {
        return this.run(userId, false, async (tx) => {
            if (q.barcode && !validProductBarcode(q.barcode))
                throw new HttpException('Неверная контрольная цифра штрихкода', 400);
            const filter = sql`${visible(userId)} and (position(lower(${q.q}) in lower(i.name))>0 or exists(select 1 from jsonb_array_elements_text(coalesce(i.aliases,'[]'::jsonb)) a(value) where position(lower(${q.q}) in lower(a.value))>0)) and (${q.barcode ?? null}::text is null or exists(select 1 from meal.ingredient_variants v join meal.brand_products bp on bp.variant_id=v.id join meal.product_barcodes bc on bc.product_id=bp.id where v.ingredient_id=i.id and bc.code=${q.barcode ?? null} and (bp.status in ('active','approved','published') or exists(select 1 from meal.catalog_proposals own where own.product_id=bp.id and own.author_id=${userId}::uuid and own.status in ('draft','pending','submitted','needs_changes'))))) `;
            const rows = await sql<
                Record<string, unknown>
            >`select ${summary},i.status not in ('active','approved','published') as owned from meal.ingredients i join meal.categories c on c.id=i.primary_category_id join meal.units u on u.id=i.default_unit_id where ${filter} order by lower(i.name),i.id limit ${q.limit} offset ${q.offset}`.execute(
                tx,
            );
            const count = await sql<{
                total: number;
            }>`select count(*)::integer as total from meal.ingredients i where ${filter}`.execute(tx);
            return productListSchema.parse({
                items: rows.rows,
                total: count.rows[0]?.total ?? 0,
                limit: q.limit,
                offset: q.offset,
            });
        });
    }
    detail(userId: string, id: string) {
        return this.run(userId, false, (tx) => this.read(tx, userId, id));
    }
    private async composition(tx: Tx, column: 'ingredient_id' | 'product_id', id: string) {
        const rows = await sql<
            Record<string, unknown>
        >`select cv.id,cv.kcal::text,cv.protein::text,cv.fat::text,cv.carbs::text,cv.basis_quantity::text as "basisQuantity",u.code as "basisUnit",cv.source,cv.confidence::text,cv.composition_text as "compositionText" from meal.composition_versions cv join meal.units u on u.id=cv.basis_unit_id where ${sql.ref('cv.' + column)}=${id}::uuid order by cv.revision desc limit 1`.execute(
            tx,
        );
        const row = rows.rows[0];
        if (!row) return { nutrition: null, allergens: [] };
        const allergens =
            await sql`select a.code,a.name,ca.status,ca.source from meal.composition_allergens ca join meal.allergens a on a.id=ca.allergen_id where ca.composition_id=${String(row.id)}::uuid order by a.code`.execute(
                tx,
            );
        const { id: ignored, ...nutrition } = row;
        void ignored;
        return { nutrition, allergens: allergens.rows };
    }
    private async read(tx: Tx, userId: string, id: string) {
        const rows = await sql<
            Record<string, unknown>
        >`select ${summary},i.version::integer,coalesce(i.aliases,'[]'::jsonb) as aliases,i.status not in ('active','approved','published') as owned from meal.ingredients i join meal.categories c on c.id=i.primary_category_id join meal.units u on u.id=i.default_unit_id where i.id=${id}::uuid and ${visible(userId)}`.execute(
            tx,
        );
        const item = rows.rows[0];
        if (!item) throw new HttpException('Продукт недоступен', 404);
        const variants = await sql<{
            id: string;
            name: string;
        }>`select v.id,v.name from meal.ingredient_variants v where v.ingredient_id=${id}::uuid and (v.status in ('active','approved','published') or exists(select 1 from meal.brand_products p join meal.catalog_proposals cp on cp.product_id=p.id where p.variant_id=v.id and cp.author_id=${userId}::uuid and cp.status in ('draft','pending','submitted','needs_changes'))) order by v.name limit 100`.execute(
            tx,
        );
        const products = await sql<{
            id: string;
            variantId: string;
            name: string;
            brand: string | null;
            packageQuantity: string | null;
            packageUnit: string;
        }>`select p.id,p.variant_id as "variantId",p.name,b.name as brand,p.package_quantity::text as "packageQuantity",u.code as "packageUnit" from meal.brand_products p join meal.units u on u.id=p.package_unit_id left join meal.brands b on b.id=p.brand_id where p.variant_id=any(${variants.rows.map((v) => v.id)}::uuid[]) and (p.status in ('active','approved','published') or exists(select 1 from meal.catalog_proposals cp where cp.product_id=p.id and cp.author_id=${userId}::uuid and cp.status in ('draft','pending','submitted','needs_changes'))) order by p.name,p.id limit 500`.execute(
            tx,
        );
        const ids = products.rows.map((p) => p.id);
        const codes = await sql<{
            product_id: string;
            code: string;
        }>`select product_id,code from meal.product_barcodes where product_id=any(${ids}::uuid[]) order by code`.execute(
            tx,
        );
        const compositions = await sql<
            Record<string, unknown>
        >`select distinct on(cv.product_id) cv.id,cv.product_id,cv.kcal::text,cv.protein::text,cv.fat::text,cv.carbs::text,cv.basis_quantity::text as "basisQuantity",u.code as "basisUnit",cv.source,cv.confidence::text,cv.composition_text as "compositionText" from meal.composition_versions cv join meal.units u on u.id=cv.basis_unit_id where cv.product_id=any(${ids}::uuid[]) order by cv.product_id,cv.revision desc`.execute(
            tx,
        );
        const compositionIds = compositions.rows.map((c) => String(c.id));
        const allergens = await sql<{
            composition_id: string;
            code: string;
            name: string;
            status: string;
            source: string;
        }>`select ca.composition_id,a.code,a.name,ca.status,ca.source from meal.composition_allergens ca join meal.allergens a on a.id=ca.allergen_id where ca.composition_id=any(${compositionIds}::uuid[]) order by a.code`.execute(
            tx,
        );
        const expanded = variants.rows.map((variant) => ({
            ...variant,
            products: products.rows
                .filter((p) => p.variantId === variant.id)
                .map(({ variantId, ...product }) => {
                    void variantId;
                    const composition = compositions.rows.find((c) => c.product_id === product.id);
                    const { id: compositionId, product_id: subject, ...nutrition } = composition ?? {};
                    void subject;
                    return {
                        ...product,
                        barcodes: codes.rows.filter((c) => c.product_id === product.id).map((c) => c.code),
                        nutrition: composition ? nutrition : null,
                        allergens: allergens.rows
                            .filter((a) => a.composition_id === compositionId)
                            .map(({ composition_id, ...a }) => {
                                void composition_id;
                                return a;
                            }),
                    };
                }),
        }));
        const proposal = await sql<{
            id: string;
        }>`select cp.id from meal.catalog_proposals cp join meal.brand_products p on p.id=cp.product_id join meal.ingredient_variants v on v.id=p.variant_id where v.ingredient_id=${id}::uuid and cp.author_id=${userId}::uuid order by cp.created_at desc limit 1`.execute(
            tx,
        );
        return {
            product: productDetailSchema.parse({
                ...item,
                ...(await this.composition(tx, 'ingredient_id', id)),
                variants: expanded,
                provenance: item.owned ? 'Предложено вами; ожидает модерации' : 'Каталог',
                proposalId: proposal.rows[0]?.id ?? null,
            }),
        };
    }
    propose(userId: string, input: ProductProposal) {
        return this.run(userId, true, async (tx) => {
            if (input.barcode && !validProductBarcode(input.barcode))
                throw new HttpException('Некорректный штрихкод', 400);
            if (new Set(input.allergens.map((a) => a.code)).size !== input.allergens.length)
                throw new HttpException('Аллерген указан повторно', 400);
            if (input.packageQuantity !== null && !/[1-9]/.test(input.packageQuantity))
                throw new HttpException('Фасовка должна быть больше нуля', 400);
            const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            const prior = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', 'catalog.propose')
                .where('target_binding', '=', 'catalog')
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (prior) {
                if (prior.request_hash !== hash) throw new HttpException('Ключ использован для другого запроса', 409);
                const value = prior.response_snapshot as { ingredientId?: unknown };
                if (typeof value.ingredientId !== 'string') throw new HttpException('Результат недоступен', 409);
                return this.read(tx, userId, value.ingredientId);
            }
            const category = await tx
                .selectFrom('categories')
                .select('id')
                .where('id', '=', input.categoryId)
                .executeTakeFirst();
            const unit = await tx.selectFrom('units').select('id').where('code', '=', input.unit).executeTakeFirst();
            const basisUnit = await tx
                .selectFrom('units')
                .select('id')
                .where('code', '=', input.nutritionBasisUnit)
                .executeTakeFirst();
            if (!category || !unit || !basisUnit) throw new HttpException('Неизвестная категория или единица', 400);
            if (input.barcode) {
                await sql`select pg_advisory_xact_lock(hashtextextended(${input.barcode},0))`.execute(tx);
                const used = await tx
                    .selectFrom('product_barcodes')
                    .select('id')
                    .where('code', '=', input.barcode)
                    .executeTakeFirst();
                if (used) throw new HttpException('Штрихкод уже связан с товаром; выберите существующий', 409);
            }
            const ingredientId = randomUUID(),
                variantId = randomUUID(),
                productId = randomUUID(),
                proposalId = randomUUID(),
                revisionId = randomUUID(),
                compositionId = randomUUID();
            let brandId: string | null = null;
            if (input.brand) {
                brandId = randomUUID();
                await tx.insertInto('brands').values({ id: brandId, name: input.brand, country_code: null }).execute();
            }
            await tx
                .insertInto('ingredients')
                .values({
                    id: ingredientId,
                    name: input.name,
                    aliases: sql`'[]'::jsonb`,
                    status: 'pending',
                    default_storage_type: null,
                    primary_category_id: category.id,
                    default_unit_id: unit.id,
                })
                .execute();
            await tx
                .insertInto('ingredient_variants')
                .values({
                    id: variantId,
                    name: input.name,
                    attributes: null,
                    status: 'pending',
                    ingredient_id: ingredientId,
                })
                .execute();
            await tx
                .insertInto('brand_products')
                .values({
                    id: productId,
                    name: input.name,
                    package_quantity: input.packageQuantity,
                    status: 'pending',
                    variant_id: variantId,
                    brand_id: brandId,
                    package_unit_id: unit.id,
                })
                .execute();
            const provenance = { source: input.source, text: input.sourceText, reviewedBy: userId };
            await tx
                .insertInto('composition_versions')
                .values({
                    id: compositionId,
                    revision: 1,
                    composition_text: input.compositionText,
                    kcal: input.kcal,
                    protein: input.protein,
                    fat: input.fat,
                    carbs: input.carbs,
                    basis_quantity: '100',
                    basis_unit_id: basisUnit.id,
                    source: input.source,
                    confidence: null,
                    dietary_flags: sql`'[]'::jsonb`,
                    ingredient_id: null,
                    variant_id: null,
                    product_id: productId,
                })
                .execute();
            for (const allergen of input.allergens) {
                const record = await tx
                    .selectFrom('allergens')
                    .select('id')
                    .where('code', '=', allergen.code)
                    .executeTakeFirst();
                if (!record) throw new HttpException('Неизвестный аллерген', 400);
                await tx
                    .insertInto('composition_allergens')
                    .values({
                        id: randomUUID(),
                        composition_id: compositionId,
                        allergen_id: record.id,
                        status: allergen.status,
                        source: input.source,
                        confidence: null,
                    })
                    .execute();
            }
            if (input.barcode)
                await tx
                    .insertInto('product_barcodes')
                    .values({
                        id: randomUUID(),
                        code: input.barcode,
                        format:
                            input.barcode.length === 8
                                ? 'EAN-8'
                                : input.barcode.length === 12
                                  ? 'UPC-A'
                                  : input.barcode.length === 13
                                    ? 'EAN-13'
                                    : 'GTIN-14',
                        verified_at: null,
                        provenance,
                        product_id: productId,
                    })
                    .execute();
            await tx
                .insertInto('catalog_proposals')
                .values({
                    id: proposalId,
                    status: 'pending',
                    draft: { ...input, ingredientId, variantId },
                    provenance,
                    submitted_at: new Date(),
                    author_id: userId,
                    product_id: productId,
                })
                .execute();
            await tx
                .insertInto('catalog_proposal_revisions')
                .values({
                    id: revisionId,
                    revision: 1,
                    draft_snapshot: input,
                    provenance,
                    proposal_id: proposalId,
                    author_id: userId,
                })
                .execute();
            await tx
                .insertInto('moderation_cases')
                .values({
                    id: randomUUID(),
                    kind: 'catalog',
                    status: 'pending',
                    reason: 'Новый товар',
                    submitted_at: new Date(),
                    queue_priority: 0,
                    evidence: { proposalId },
                    reporter_id: userId,
                    catalog_proposal_revision_id: revisionId,
                    recipe_revision_id: null,
                    comment_id: null,
                    asset_id: null,
                    assigned_to: null,
                })
                .execute();
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'catalog.propose',
                    target_binding: 'catalog',
                    key: input.idempotencyKey,
                    request_hash: hash,
                    status: 'completed',
                    response_snapshot: { ingredientId },
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: userId,
                    scope_id: null,
                    actor_namespace: `user:${userId}`,
                })
                .execute();
            return this.read(tx, userId, ingredientId);
        }).catch((error: unknown) => {
            if (
                error instanceof Error &&
                'code' in error &&
                error.code === '23505' &&
                'constraint' in error &&
                error.constraint === 'uq_product_barcodes_code'
            )
                throw new HttpException('Штрихкод уже связан с товаром; выберите существующий', 409);
            throw error;
        });
    }
}
