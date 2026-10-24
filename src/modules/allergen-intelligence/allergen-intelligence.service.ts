import {
    ConflictException,
    HttpException,
    Injectable,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { Principal } from '../auth/auth.service.js';
import {
    allergenAdminDetailSchema,
    allergenAdminListSchema,
    allergenAdminQuerySchema,
    allergenIconMutationSchema,
    allergenIconUploadSchema,
    allergenMappingMutationSchema,
    allergenReportResultSchema,
    allergenReportSchema,
    allergenSubjectListSchema,
    allergenSubjectQuerySchema,
    recipeAllergenProjectionSchema,
} from './allergen-intelligence.contracts.js';

type Tx = Transaction<DatabaseSchema>;
const icon = (row: Record<string, unknown>) => ({
    state:
        row.iconState === 'ready'
            ? ('custom' as const)
            : row.iconState === 'unavailable'
              ? ('unavailable' as const)
              : ('fallback' as const),
    url: null,
    fallbackKey: typeof row.fallbackKey === 'string' ? row.fallbackKey : `allergen-${String(row.code)}`,
    alt: typeof row.altText === 'string' ? row.altText : `Аллерген: ${String(row.name)}`,
});
const adminSummary = (row: Record<string, unknown>) => ({
    code: row.code,
    name: row.name,
    version: row.version,
    activeMappings: row.activeMappings,
    ingredientMappings: row.ingredientMappings,
    variantMappings: row.variantMappings,
    productMappings: row.productMappings,
    icon: icon(row),
});
const statusRank = { unknown: 1, may_contain: 2, contains: 3 } as const;

@Injectable()
export class AllergenIntelligenceService {
    constructor(private readonly database: DatabaseService) {}
    private async ready() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    async recipeProjection(tx: Tx, revisionId: string) {
        const ingredientRows = await sql<
            Record<string, unknown>
        >`select ri.id as "recipeIngredientId",coalesce(bp.name,v.name,i.name,'Ингредиент') name,coalesce(ri.ingredient_id,v.ingredient_id,bpv.ingredient_id) as "ingredientId",coalesce(ri.variant_id,bp.variant_id) as "variantId",ri.product_id as "productId",cv.id as "compositionId",
          cv.id is not null and coalesce((cv.dietary_flags->>'allergensComplete')::boolean,false) as "compositionComplete"
        from meal.recipe_ingredients ri left join meal.brand_products bp on bp.id=ri.product_id left join meal.ingredient_variants v on v.id=ri.variant_id left join meal.ingredient_variants bpv on bpv.id=bp.variant_id left join meal.ingredients i on i.id=coalesce(ri.ingredient_id,v.ingredient_id,bpv.ingredient_id)
        left join lateral(select x.id,x.dietary_flags from meal.composition_versions x where (ri.product_id is not null and x.product_id=ri.product_id) or (ri.product_id is null and ri.variant_id is not null and x.variant_id=ri.variant_id) or (ri.product_id is null and ri.variant_id is null and x.ingredient_id=ri.ingredient_id) order by x.revision desc,x.created_at desc limit 1) cv on true
        where ri.revision_id=${revisionId}::uuid order by ri.position,ri.id`.execute(tx);
        const compositionIds = ingredientRows.rows
            .map((row) => row.compositionId)
            .filter((value): value is string => typeof value === 'string');
        const explicit = compositionIds.length
            ? await sql<
                  Record<string, unknown>
              >`select ca.composition_id as "compositionId",a.code,a.name as "allergenName",ca.status,ca.source as "compositionSource",ai.state as "iconState",ai.fallback_key as "fallbackKey",ai.alt_text as "altText" from meal.composition_allergens ca join meal.allergens a on a.id=ca.allergen_id left join meal.allergen_icons ai on ai.allergen_id=a.id where ca.composition_id=any(${compositionIds}::uuid[])`.execute(
                  tx,
              )
            : { rows: [] as Record<string, unknown>[] };
        const mappings = await sql<
            Record<string, unknown>
        >`select m.id as "mappingId",m.ingredient_id as "ingredientId",m.variant_id as "variantId",m.product_id as "productId",a.code,a.name as "allergenName",m.status,m.source as "mappingSource",ai.state as "iconState",ai.fallback_key as "fallbackKey",ai.alt_text as "altText" from meal.allergen_mappings m join meal.allergens a on a.id=m.allergen_id left join meal.allergen_icons ai on ai.allergen_id=a.id where m.removed_at is null and (m.ingredient_id=any(${ingredientRows.rows.map((row) => row.ingredientId).filter(Boolean)}::uuid[]) or m.variant_id=any(${ingredientRows.rows.map((row) => row.variantId).filter(Boolean)}::uuid[]) or m.product_id=any(${ingredientRows.rows.map((row) => row.productId).filter(Boolean)}::uuid[]))`.execute(
            tx,
        );
        const ingredients = new Map<string, Record<string, unknown>>();
        const allergens = new Map<
            string,
            {
                base: Record<string, unknown>;
                status: 'contains' | 'may_contain' | 'unknown';
                ingredients: Record<string, unknown>[];
                evidence: Record<string, unknown>[];
            }
        >();
        for (const ingredient of ingredientRows.rows) {
            ingredients.set(String(ingredient.recipeIngredientId), ingredient);
            const evidenceRows = [
                ...explicit.rows.filter((row) => row.compositionId === ingredient.compositionId),
                ...mappings.rows.filter(
                    (row) =>
                        (row.productId && row.productId === ingredient.productId) ||
                        (row.variantId && row.variantId === ingredient.variantId) ||
                        (row.ingredientId && row.ingredientId === ingredient.ingredientId),
                ),
            ];
            for (const evidenceRow of evidenceRows) {
                // Mapping subject IDs identify dictionary evidence; response IDs must keep the concrete recipe row.
                const row = { ...evidenceRow, ...ingredient };
                if (typeof row.code !== 'string' || typeof row.status !== 'string') continue;
                const status = row.status as 'contains' | 'may_contain' | 'unknown';
                const current = allergens.get(row.code);
                const target = current ?? { base: row, status, ingredients: [], evidence: [] };
                if (statusRank[status] > statusRank[target.status]) target.status = status;
                if (!target.ingredients.some((item) => item.recipeIngredientId === row.recipeIngredientId))
                    target.ingredients.push(row);
                if (row.compositionSource)
                    target.evidence.push({ kind: 'composition', source: row.compositionSource, mappingId: null });
                if (row.mappingId)
                    target.evidence.push({ kind: 'dictionary', source: row.mappingSource, mappingId: row.mappingId });
                allergens.set(row.code, target);
            }
        }
        const projectIngredient = (row: Record<string, unknown>) => ({
            recipeIngredientId: row.recipeIngredientId,
            name: row.name,
            ingredientId: row.ingredientId ?? null,
            variantId: row.variantId ?? null,
            productId: row.productId ?? null,
        });
        const unknownIngredients = [...ingredients.values()]
            .filter((row) => !row.compositionComplete)
            .map(projectIngredient);
        return recipeAllergenProjectionSchema.parse({
            allergens: [...allergens.values()].map((item) => ({
                code: item.base.code,
                name: item.base.allergenName,
                status: item.status,
                source: item.evidence.map((e) => e.source).join('; '),
                icon: icon({ ...item.base, name: item.base.allergenName }),
                ingredients: item.ingredients.map(projectIngredient),
                evidence: item.evidence,
            })),
            complete: unknownIngredients.length === 0,
            unknownIngredients,
        });
    }
    async list(raw: unknown) {
        const query = allergenAdminQuerySchema.parse(raw),
            db = await this.ready();
        const rows = await sql<
            Record<string, unknown>
        >`select a.code,a.name,a.version::int,coalesce(count(m.id) filter(where m.removed_at is null),0)::int as "activeMappings",coalesce(count(m.id) filter(where m.removed_at is null and m.ingredient_id is not null),0)::int as "ingredientMappings",coalesce(count(m.id) filter(where m.removed_at is null and m.variant_id is not null),0)::int as "variantMappings",coalesce(count(m.id) filter(where m.removed_at is null and m.product_id is not null),0)::int as "productMappings",i.state as "iconState",i.fallback_key as "fallbackKey",i.alt_text as "altText" from meal.allergens a left join meal.allergen_mappings m on m.allergen_id=a.id left join meal.allergen_icons i on i.allergen_id=a.id where position(lower(${query.q}) in lower(a.code||' '||a.name))>0 group by a.id,i.id order by a.name,a.code limit ${query.limit} offset ${query.offset}`.execute(
            db,
        );
        const total = await sql<{
            total: number;
        }>`select count(*)::int total from meal.allergens a where position(lower(${query.q}) in lower(a.code||' '||a.name))>0`.execute(
            db,
        );
        return allergenAdminListSchema.parse({
            items: rows.rows.map(adminSummary),
            total: total.rows[0]?.total ?? 0,
            limit: query.limit,
            offset: query.offset,
        });
    }
    async subjects(raw: unknown) {
        const query = allergenSubjectQuerySchema.parse(raw),
            db = await this.ready();
        const search = `%${query.q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        const rows =
            query.subjectType === 'ingredient'
                ? await sql<{
                      subjectType: 'ingredient';
                      subjectId: string;
                      subjectName: string;
                      imageUrl: null;
                  }>`select 'ingredient' as "subjectType",i.id as "subjectId",i.name as "subjectName",null::text as "imageUrl" from meal.ingredients i where i.status in ('active','approved','published') and i.name ilike ${search} escape '\\' order by lower(i.name),i.id limit ${query.limit}`.execute(
                      db,
                  )
                : query.subjectType === 'variant'
                  ? await sql<{
                        subjectType: 'variant';
                        subjectId: string;
                        subjectName: string;
                        imageUrl: null;
                    }>`select 'variant' as "subjectType",v.id as "subjectId",concat(i.name,' · ',v.name) as "subjectName",null::text as "imageUrl" from meal.ingredient_variants v join meal.ingredients i on i.id=v.ingredient_id where v.status in ('active','approved','published') and concat(i.name,' ',v.name) ilike ${search} escape '\\' order by lower(i.name),lower(v.name),v.id limit ${query.limit}`.execute(
                        db,
                    )
                  : await sql<{
                        subjectType: 'product';
                        subjectId: string;
                        subjectName: string;
                        imageUrl: null;
                    }>`select 'product' as "subjectType",p.id as "subjectId",concat_ws(' · ',p.name,b.name) as "subjectName",null::text as "imageUrl" from meal.brand_products p left join meal.brands b on b.id=p.brand_id where p.status in ('active','approved','published') and concat_ws(' ',p.name,b.name) ilike ${search} escape '\\' order by lower(p.name),p.id limit ${query.limit}`.execute(
                        db,
                    );
        return allergenSubjectListSchema.parse({ items: rows.rows });
    }
    async detail(code: string, tx?: Tx) {
        const db = tx ?? (await this.ready());
        const row = await sql<
            Record<string, unknown>
        >`select a.id,a.code,a.name,a.version::int,coalesce((select count(*)::int from meal.allergen_mappings m where m.allergen_id=a.id and m.removed_at is null),0) "activeMappings",coalesce((select count(*)::int from meal.allergen_mappings m where m.allergen_id=a.id and m.removed_at is null and m.ingredient_id is not null),0) "ingredientMappings",coalesce((select count(*)::int from meal.allergen_mappings m where m.allergen_id=a.id and m.removed_at is null and m.variant_id is not null),0) "variantMappings",coalesce((select count(*)::int from meal.allergen_mappings m where m.allergen_id=a.id and m.removed_at is null and m.product_id is not null),0) "productMappings",i.state as "iconState",i.fallback_key as "fallbackKey",i.alt_text as "altText" from meal.allergens a left join meal.allergen_icons i on i.allergen_id=a.id where a.code=${code}`.execute(
            db,
        );
        if (!row.rows[0]) throw new HttpException('Аллерген не найден', 404);
        const mappings = await sql<
            Record<string, unknown>
        >`select m.id,case when m.product_id is not null then 'product' when m.variant_id is not null then 'variant' else 'ingredient' end as "subjectType",coalesce(m.product_id,m.variant_id,m.ingredient_id) as "subjectId",coalesce(p.name,v.name,g.name) as "subjectName",m.status,m.source,m.version::int from meal.allergen_mappings m left join meal.brand_products p on p.id=m.product_id left join meal.ingredient_variants v on v.id=m.variant_id left join meal.ingredients g on g.id=m.ingredient_id where m.allergen_id=${String(row.rows[0].id)}::uuid and m.removed_at is null order by "subjectType","subjectName",m.id`.execute(
            db,
        );
        return allergenAdminDetailSchema.parse({
            ...adminSummary(row.rows[0]),
            mappings: mappings.rows,
            iconUpload: { mode: 'unavailable', reason: 'Object storage и malware scanner не подключены' },
        });
    }
    private async assertAdmin(tx: Tx, actor: Principal) {
        const found = await tx
            .selectFrom('sessions')
            .select('id')
            .where('id', '=', actor.sessionId)
            .where('user_id', '=', actor.id)
            .where('auth_context', '=', 'admin')
            .where('revoked_at', 'is', null)
            .where('expires_at', '>', new Date())
            .executeTakeFirst();
        if (!found || actor.context !== 'admin') throw new UnauthorizedException();
    }
    private async mutate<T extends { expectedVersion: number; idempotencyKey: string; action: string }>(
        code: string,
        operation: string,
        raw: unknown,
        parser: z.ZodType<T>,
        actor: Principal,
        requestId: string,
        work: (tx: Tx, allergen: { id: string; version: number }, input: T) => Promise<void>,
    ) {
        return this.database.transaction(async (tx) => {
            await this.assertAdmin(tx, actor);
            const input = parser.parse(raw);
            const allergen = await tx
                .selectFrom('allergens')
                .select(['id', 'version'])
                .where('code', '=', code)
                .forUpdate()
                .executeTakeFirst();
            if (!allergen) throw new HttpException('Аллерген не найден', 404);
            const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            const prior = await tx
                .selectFrom('idempotency_records')
                .select('request_hash')
                .where('actor_namespace', '=', `admin:${actor.id}`)
                .where('operation', '=', operation)
                .where('target_binding', '=', allergen.id)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (prior) {
                if (prior.request_hash !== hash) throw new ConflictException('Idempotency key already used');
                return this.detail(code, tx);
            }
            if (Number(allergen.version) !== input.expectedVersion) throw new ConflictException('Аллерген изменён');
            await work(tx, { id: allergen.id, version: Number(allergen.version) }, input);
            await tx
                .updateTable('allergens')
                .set({ version: sql`version+1` })
                .where('id', '=', allergen.id)
                .execute();
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation,
                    target_binding: allergen.id,
                    key: input.idempotencyKey,
                    request_hash: hash,
                    status: 'completed',
                    response_snapshot: null,
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: actor.id,
                    scope_id: null,
                    actor_namespace: `admin:${actor.id}`,
                })
                .execute();
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: operation,
                    target_type: 'allergen',
                    target_id: allergen.id,
                    effective_at: new Date(),
                    recorded_at: new Date(),
                    reason: 'source' in input && typeof input.source === 'string' ? input.source : input.action,
                    before_redacted: null,
                    after_redacted: { action: input.action },
                    request_id: requestId,
                    actor_id: actor.id,
                    scope_id: null,
                })
                .execute();
            return this.detail(code, tx);
        });
    }
    mapping(code: string, raw: unknown, actor: Principal, requestId: string) {
        return this.mutate(
            code,
            'admin.allergen.mapping',
            raw,
            allergenMappingMutationSchema,
            actor,
            requestId,
            async (tx, a, input) => {
                if (input.action === 'remove') {
                    if (!input.mappingId) throw new HttpException('mappingId обязателен', 400);
                    const mapping = await tx
                        .selectFrom('allergen_mappings')
                        .select('id')
                        .where('id', '=', input.mappingId)
                        .where('allergen_id', '=', a.id)
                        .where('removed_at', 'is', null)
                        .executeTakeFirst();
                    if (!mapping) throw new HttpException('Связь не найдена', 404);
                    await sql`update meal.allergen_mappings set removed_at=now(),version=version+1 where id=${input.mappingId}::uuid and allergen_id=${a.id}::uuid and removed_at is null`.execute(
                        tx,
                    );
                    return;
                }
                const exists =
                    input.subjectType === 'ingredient'
                        ? await tx
                              .selectFrom('ingredients')
                              .select('id')
                              .where('id', '=', input.subjectId)
                              .executeTakeFirst()
                        : input.subjectType === 'variant'
                          ? await tx
                                .selectFrom('ingredient_variants')
                                .select('id')
                                .where('id', '=', input.subjectId)
                                .executeTakeFirst()
                          : await tx
                                .selectFrom('brand_products')
                                .select('id')
                                .where('id', '=', input.subjectId)
                                .executeTakeFirst();
                if (!exists) throw new HttpException('Объект каталога не найден', 404);
                const duplicate =
                    await sql`select id from meal.allergen_mappings where allergen_id=${a.id}::uuid and removed_at is null and (ingredient_id=${input.subjectType === 'ingredient' ? input.subjectId : null}::uuid or variant_id=${input.subjectType === 'variant' ? input.subjectId : null}::uuid or product_id=${input.subjectType === 'product' ? input.subjectId : null}::uuid) limit 1`.execute(
                        tx,
                    );
                if (duplicate.rows.length) throw new ConflictException('Связь уже существует');
                await sql`insert into meal.allergen_mappings(id,allergen_id,ingredient_id,variant_id,product_id,status,source,created_by) values(${randomUUID()}::uuid,${a.id}::uuid,${input.subjectType === 'ingredient' ? input.subjectId : null}::uuid,${input.subjectType === 'variant' ? input.subjectId : null}::uuid,${input.subjectType === 'product' ? input.subjectId : null}::uuid,${input.status},${input.source},${actor.id}::uuid)`.execute(
                    tx,
                );
            },
        );
    }
    icon(code: string, raw: unknown, actor: Principal, requestId: string) {
        return this.mutate(
            code,
            'admin.allergen.icon',
            raw,
            allergenIconMutationSchema,
            actor,
            requestId,
            async (tx, a, input) => {
                await sql`insert into meal.allergen_icons(id,allergen_id,state,fallback_key,alt_text,asset_id,updated_by) values(${randomUUID()}::uuid,${a.id}::uuid,'fallback',${input.fallbackKey},${input.altText},null,${actor.id}::uuid) on conflict(allergen_id) do update set state='fallback',fallback_key=excluded.fallback_key,alt_text=excluded.alt_text,asset_id=null,updated_by=excluded.updated_by,version=meal.allergen_icons.version+1`.execute(
                    tx,
                );
            },
        );
    }
    upload(raw: unknown) {
        allergenIconUploadSchema.parse(raw);
        throw new ServiceUnavailableException('Object storage и malware scanner не подключены');
    }
    report(userId: string, raw: unknown) {
        const input = allergenReportSchema.parse(raw);
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
            const ban =
                await sql`select id from meal.sanctions where user_id=${userId}::uuid and scope='account' and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                    tx,
                );
            if (ban.rows.length) throw new HttpException('Доступен только просмотр', 403);
            const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            const prior = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', 'allergen.report')
                .where('target_binding', '=', input.revisionId)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (prior) {
                if (prior.request_hash !== hash) throw new ConflictException('Idempotency key already used');
                return allergenReportResultSchema.parse(prior.response_snapshot);
            }
            const linked = await sql<{
                id: string;
            }>`select ri.id from meal.recipe_ingredients ri join meal.recipe_revisions rr on rr.id=ri.revision_id join meal.recipes r on r.id=rr.recipe_id join meal.recipe_publications p on p.revision_id=rr.id where r.id=${input.recipeId}::uuid and rr.id=${input.revisionId}::uuid and p.unpublished_at is null and p.published_at<=now() and ri.id=any(${input.unknownIngredientIds}::uuid[])`.execute(
                tx,
            );
            if (linked.rows.length !== new Set(input.unknownIngredientIds).size)
                throw new HttpException('Ингредиенты не относятся к опубликованной версии', 422);
            const projection = await this.recipeProjection(tx, input.revisionId);
            const unknown = new Set(projection.unknownIngredients.map((item) => item.recipeIngredientId));
            if (input.unknownIngredientIds.some((id) => !unknown.has(id)))
                throw new HttpException('Можно отправить только ингредиенты с неизвестными аллергенами', 422);
            const ticketId = randomUUID(),
                number = `ALG-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
            await tx
                .insertInto('support_tickets')
                .values({
                    id: ticketId,
                    public_number: number,
                    category: 'complaints',
                    status: 'open',
                    subject: 'Уточнение аллергенов рецепта',
                    closed_at: null,
                    requester_id: userId,
                    assignee_id: null,
                    thread_id: null,
                })
                .execute();
            await tx
                .insertInto('support_messages')
                .values({
                    id: randomUUID(),
                    body: `Рецепт ${input.recipeId}, версия ${input.revisionId}. Неизвестные ингредиенты: ${input.unknownIngredientIds.join(', ')}${input.note ? `\n${input.note}` : ''}`,
                    internal: false,
                    ticket_id: ticketId,
                    author_id: userId,
                })
                .execute();
            await sql`insert into meal.allergen_reports(id,user_id,recipe_id,revision_id,unknown_ingredient_ids,note,ticket_id) values(${randomUUID()}::uuid,${userId}::uuid,${input.recipeId}::uuid,${input.revisionId}::uuid,${JSON.stringify(input.unknownIngredientIds)}::jsonb,${input.note},${ticketId}::uuid)`.execute(
                tx,
            );
            const result = { ticketId, ticketNumber: number };
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'allergen.report',
                    target_binding: input.revisionId,
                    key: input.idempotencyKey,
                    request_hash: hash,
                    status: 'completed',
                    response_snapshot: result,
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: userId,
                    scope_id: null,
                    actor_namespace: `user:${userId}`,
                })
                .execute();
            return allergenReportResultSchema.parse(result);
        });
    }
}
