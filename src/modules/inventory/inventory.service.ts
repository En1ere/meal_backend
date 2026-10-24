import { Injectable, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import {
    inventoryBatchSchema,
    inventoryFieldsSchema,
    type InventoryBatch,
    type InventoryCreate,
    type InventoryCommand,
    inventoryLocationCommandSchema,
    inventoryScopeSchema,
} from './inventory.contracts.js';
import { transition, decimal, decimalText } from './inventory.domain.js';
type Tx = Transaction<DatabaseSchema>;
const projection = sql`b.id, b.name, b.quantity::text AS quantity, u.code AS unit, b.location_id AS "locationId", b.ingredient_id AS "ingredientId", b.opened_at AS "openedAt", b.purchased_on::text AS "purchasedOn", b.expiry_on::text AS "expiryOn", b.package_state AS "packageState", b.precision, coalesce(b.metadata->>'quantitySource','user') as "quantitySource", (b.metadata->>'confidence')::double precision as confidence, b.barcode_snapshot AS barcode, b.metadata->>'pricePaidRub' AS "pricePaidRub", b.metadata->>'storeName' AS "storeName", b.version::integer AS version, b.archived_at AS "archivedAt", b.created_at AS "createdAt", case when s.kind='family' then 'family' else 'private' end AS scope`;
function hydrate(row: Record<string, unknown>): InventoryBatch {
    return inventoryBatchSchema.parse({
        ...row,
        openedAt: row.openedAt instanceof Date ? row.openedAt.toISOString() : row.openedAt,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        archivedAt: row.archivedAt instanceof Date ? row.archivedAt.toISOString() : row.archivedAt,
    });
}
export const inventoryQuerySchema = z
    .object({
        q: z.string().max(200).default(''),
        status: z.enum(['active', 'archived', 'all']).default('active'),
        attention: z.enum(['all', 'expiring', 'unknown']).default('all'),
        days: z.coerce
            .number()
            .pipe(z.union([z.literal(3), z.literal(7), z.literal(14)]))
            .default(3),
        localDate: z.iso.date(),
        locationId: z.uuid().optional(),
        ingredientId: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        scope: inventoryScopeSchema.default('private'),
    })
    .strict();
@Injectable()
export class InventoryService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
    ) {}
    private async run<T>(
        userId: string,
        requestedScope: z.infer<typeof inventoryScopeSchema>,
        write: boolean,
        task: (tx: Tx, scopeId: string) => Promise<T>,
        empty?: T,
    ): Promise<T> {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.transaction(async (tx) => {
            const migrated = await sql<{
                ok: boolean;
            }>`select exists(select 1 from meal.schema_migrations where version=6) as ok`.execute(tx);
            if (!migrated.rows[0]?.ok) throw new ServiceUnavailableException('Требуется миграция 006');
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
                    await sql`select id from meal.sanctions where user_id=${userId}::uuid and scope='account' and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                        tx,
                    );
                if (banned.rows.length) throw new HttpException('Доступен только просмотр', 403);
            }
            let scope =
                requestedScope === 'private'
                    ? await tx
                          .selectFrom('data_scopes')
                          .select('id')
                          .where('user_id', '=', userId)
                          .where('kind', '=', 'private')
                          .executeTakeFirst()
                    : await tx
                          .selectFrom('family_memberships as membership')
                          .innerJoin('families as family', 'family.id', 'membership.family_id')
                          .innerJoin('data_scopes as scope', 'scope.family_id', 'family.id')
                          .select(['scope.id', 'family.id as familyId'])
                          .where('membership.user_id', '=', userId)
                          .where('membership.left_at', 'is', null)
                          .where('family.status', '=', 'active')
                          .where('scope.kind', '=', 'family')
                          .executeTakeFirst();
            if (requestedScope === 'family' && scope && 'familyId' in scope) {
                const entitlement = await this.entitlements.resolveFamily(userId, z.uuid().parse(scope.familyId), tx);
                if (!entitlement.capabilities.family) throw new HttpException('Семейный доступ приостановлен', 403);
            }
            if (!scope && requestedScope === 'family') throw new HttpException('Семейный доступ не найден', 404);
            if (!scope && write) {
                scope = { id: randomUUID() };
                await tx
                    .insertInto('data_scopes')
                    .values({ id: scope.id, kind: 'private', user_id: userId, family_id: null })
                    .execute();
            }
            if (!scope) {
                if (empty !== undefined) return empty;
                throw new HttpException('Объект не найден', 404);
            }
            return task(tx, scope.id);
        });
    }
    private async batch(tx: Tx, scope: string, id: string) {
        const rows = await sql<
            Record<string, unknown>
        >`select ${projection} from meal.inventory_batches b join meal.units u on u.id=b.unit_id join meal.data_scopes s on s.id=b.scope_id where b.id=${id}::uuid and b.scope_id=${scope}::uuid and b.kind='ingredient' for update of b`.execute(
            tx,
        );
        if (!rows.rows[0]) throw new HttpException('Партия не найдена', 404);
        return hydrate(rows.rows[0]);
    }
    async list(userId: string, query: z.infer<typeof inventoryQuerySchema>) {
        return this.run(
            userId,
            query.scope,
            false,
            async (tx, scope) => {
                const where = sql`b.scope_id=${scope}::uuid and b.kind='ingredient'
                and (${query.status}='all' or (${query.status}='active' and b.archived_at is null) or (${query.status}='archived' and b.archived_at is not null))
                and (${query.ingredientId ?? null}::uuid is null or b.ingredient_id=${query.ingredientId ?? null}::uuid)
                and position(lower(${query.q}) in lower(b.name))>0
                and (${query.locationId ?? null}::uuid is null or b.location_id=${query.locationId ?? null}::uuid)
                and (${query.attention}='all' or (${query.attention}='unknown' and b.expiry_on is null) or (${query.attention}='expiring' and b.expiry_on<=${query.localDate}::date+${query.days}::integer))`;
                const rows = await sql<
                    Record<string, unknown>
                >`select ${projection} from meal.inventory_batches b join meal.units u on u.id=b.unit_id join meal.data_scopes s on s.id=b.scope_id where ${where} order by b.created_at desc,b.id limit ${query.limit} offset ${query.offset}`.execute(
                    tx,
                );
                const count = await sql<{
                    total: number;
                }>`select count(*)::integer as total from meal.inventory_batches b where ${where}`.execute(tx);
                return { items: rows.rows.map(hydrate), total: count.rows[0]?.total ?? 0 };
            },
            { items: [], total: 0 },
        );
    }
    detail(userId: string, id: string, scopeKind: z.infer<typeof inventoryScopeSchema>) {
        return this.run(userId, scopeKind, false, async (tx, scope) => ({ batch: await this.batch(tx, scope, id) }));
    }
    private async replay<T>(
        tx: Tx,
        userId: string,
        scope: string,
        target: string,
        key: string,
        body: unknown,
        execute: () => Promise<T>,
    ): Promise<T> {
        const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const prior = await tx
            .selectFrom('idempotency_records')
            .select(['request_hash', 'response_snapshot'])
            .where('actor_namespace', '=', `user:${userId}`)
            .where('operation', '=', 'inventory')
            .where('target_binding', '=', target)
            .where('key', '=', key)
            .executeTakeFirst();
        if (prior) {
            if (prior.request_hash !== hash) throw new HttpException('Ключ уже использован с другими данными', 409);
            return prior.response_snapshot as T;
        }
        const result = await execute();
        await tx
            .insertInto('idempotency_records')
            .values({
                id: randomUUID(),
                operation: 'inventory',
                target_binding: target,
                key,
                request_hash: hash,
                status: 'completed',
                response_snapshot: JSON.stringify(result),
                expires_at: new Date('9999-12-31T00:00:00Z'),
                user_id: userId,
                scope_id: scope,
                actor_namespace: `user:${userId}`,
            })
            .execute();
        return result;
    }
    private async references(tx: Tx, scope: string, batch: InventoryBatch) {
        if (batch.locationId) {
            const location = await tx
                .selectFrom('storage_locations')
                .select('id')
                .where('id', '=', batch.locationId)
                .where('scope_id', '=', scope)
                .where('archived_at', 'is', null)
                .executeTakeFirst();
            if (!location) throw new HttpException('Место хранения не найдено', 422);
        }
        const unit = await tx.selectFrom('units').select('id').where('code', '=', batch.unit).executeTakeFirst();
        if (!unit) throw new HttpException('Единица измерения не найдена', 422);
        return unit.id;
    }
    private async movement(
        tx: Tx,
        userId: string,
        scope: string,
        key: string,
        action: string,
        before: InventoryBatch | null,
        after: InventoryBatch,
        unitId: string,
    ) {
        const operation = randomUUID();
        const now = new Date();
        await tx
            .insertInto('inventory_operations')
            .values({
                id: operation,
                kind: action,
                effective_at: now,
                recorded_at: now,
                status: 'completed',
                idempotency_key: `${after.id}:${key}`,
                preview_hash: null,
                scope_id: scope,
                actor_id: userId,
                compensates_id: null,
            })
            .execute();
        const delta =
            after.quantity !== null && (before === null || (before.quantity !== null && before.unit === after.unit))
                ? decimalText(decimal(after.quantity) - (before?.quantity ? decimal(before.quantity) : 0n))
                : null;
        await tx
            .insertInto('inventory_movements')
            .values({
                id: randomUUID(),
                quantity_delta: delta,
                before_snapshot: JSON.stringify(before),
                after_snapshot: JSON.stringify(after),
                base_version: before?.version ?? null,
                operation_id: operation,
                batch_id: after.id,
                unit_id: unitId,
                compensates_id: null,
            })
            .execute();
    }
    private async createIn(tx: Tx, scope: string, userId: string, input: InventoryCreate) {
        const ingredient = (
            await sql<{
                id: string;
            }>`select i.id from meal.ingredients i where i.id=${input.ingredientId}::uuid and (i.status in ('active','approved','published') or (${input.scope}='private' and exists(select 1 from meal.catalog_proposals cp join meal.brand_products bp on bp.id=cp.product_id join meal.ingredient_variants iv on iv.id=bp.variant_id where iv.ingredient_id=i.id and cp.author_id=${userId}::uuid and cp.status in ('draft','pending','submitted','needs_changes'))))`.execute(
                tx,
            )
        ).rows[0];
        if (!ingredient) throw new HttpException('Ингредиент не найден', 422);
        const batch = inventoryBatchSchema.parse({
            ...inventoryFieldsSchema.parse(
                Object.fromEntries(
                    Object.entries(input).filter(([key]) => !['ingredientId', 'scope', 'idempotencyKey'].includes(key)),
                ),
            ),
            ingredientId: input.ingredientId,
            scope: input.scope,
            id: randomUUID(),
            version: 1,
            archivedAt: null,
            createdAt: new Date().toISOString(),
        });
        const unitId = await this.references(tx, scope, batch);
        await sql`insert into meal.inventory_batches(id,kind,name,quantity,quantity_known,precision,package_state,opened_at,purchased_on,expiry_on,barcode_snapshot,scope_id,unit_id,location_id,ingredient_id,created_by,created_at,metadata) values(${batch.id}::uuid,'ingredient',${batch.name},${batch.quantity}::numeric,${batch.quantity !== null},${batch.precision},${batch.packageState},${batch.openedAt}::timestamptz,${batch.purchasedOn}::date,${batch.expiryOn}::date,${batch.barcode},${scope}::uuid,${unitId}::uuid,${batch.locationId}::uuid,${batch.ingredientId}::uuid,${userId}::uuid,${batch.createdAt}::timestamptz,${JSON.stringify({ pricePaidRub: batch.pricePaidRub, storeName: batch.storeName, quantitySource: batch.quantitySource, confidence: batch.confidence })}::jsonb)`.execute(
            tx,
        );
        await this.movement(tx, userId, scope, input.idempotencyKey, 'purchase', null, batch, unitId);
        return { batch };
    }
    importMany(userId: string, input: { rows: InventoryCreate[]; idempotencyKey: string }) {
        const scopeKind = input.rows[0]?.scope ?? 'private';
        if (input.rows.some((row) => row.scope !== scopeKind))
            throw new HttpException('Импорт не смешивает области', 400);
        return this.run(userId, scopeKind, true, (tx, scope) =>
            this.replay(tx, userId, scope, 'import', input.idempotencyKey, input, async () => {
                const ids = [...new Set(input.rows.map((row) => row.ingredientId))];
                const ingredients = await sql<{
                    id: string;
                }>`select i.id from meal.ingredients i where i.id in (${sql.join(ids.map((id) => sql`${id}::uuid`))}) and (i.status in ('active','approved','published') or (${scopeKind}='private' and exists(select 1 from meal.catalog_proposals cp join meal.brand_products bp on bp.id=cp.product_id join meal.ingredient_variants iv on iv.id=bp.variant_id where iv.ingredient_id=i.id and cp.author_id=${userId}::uuid and cp.status in ('draft','pending','submitted','needs_changes'))))`.execute(
                    tx,
                );
                if (ingredients.rows.length !== ids.length) throw new HttpException('Ингредиент не найден', 422);
                const units = await tx
                    .selectFrom('units')
                    .select(['id', 'code'])
                    .where('code', 'in', [...new Set(input.rows.map((row) => row.unit))])
                    .execute();
                const unitIds = new Map(units.map((row) => [row.code, row.id]));
                const locationIds = [...new Set(input.rows.map((row) => row.locationId))];
                const locations = await tx
                    .selectFrom('storage_locations')
                    .select('id')
                    .where('id', 'in', locationIds)
                    .where('scope_id', '=', scope)
                    .where('archived_at', 'is', null)
                    .execute();
                if (locations.length !== locationIds.length) throw new HttpException('Место хранения не найдено', 422);
                const now = new Date();
                const items = input.rows.map((input) => {
                    if (!unitIds.has(input.unit)) throw new HttpException('Единица измерения не найдена', 422);
                    const { idempotencyKey: ignored, ...fields } = input;
                    void ignored;
                    return inventoryBatchSchema.parse({
                        ...fields,
                        id: randomUUID(),
                        version: 1,
                        archivedAt: null,
                        createdAt: now.toISOString(),
                    });
                });
                const operation = randomUUID();
                await tx
                    .insertInto('inventory_operations')
                    .values({
                        id: operation,
                        kind: 'purchase',
                        effective_at: now,
                        recorded_at: now,
                        status: 'completed',
                        idempotency_key: 'import:' + input.idempotencyKey,
                        preview_hash: null,
                        scope_id: scope,
                        actor_id: userId,
                        compensates_id: null,
                    })
                    .execute();
                for (let index = 0; index < items.length; index += 200) {
                    const chunk = items.slice(index, index + 200);
                    const values = chunk.map(
                        (batch) =>
                            sql`(${batch.id}::uuid,'ingredient',${batch.name},${batch.quantity}::numeric,${batch.quantity !== null},${batch.precision},${batch.packageState},${batch.openedAt}::timestamptz,${batch.purchasedOn}::date,${batch.expiryOn}::date,${batch.barcode},${scope}::uuid,${unitIds.get(batch.unit)!}::uuid,${batch.locationId}::uuid,${batch.ingredientId}::uuid,${userId}::uuid,${now},${JSON.stringify({ pricePaidRub: batch.pricePaidRub, storeName: batch.storeName, quantitySource: batch.quantitySource, confidence: batch.confidence })}::jsonb)`,
                    );
                    await sql`insert into meal.inventory_batches(id,kind,name,quantity,quantity_known,precision,package_state,opened_at,purchased_on,expiry_on,barcode_snapshot,scope_id,unit_id,location_id,ingredient_id,created_by,created_at,metadata) values ${sql.join(values)}`.execute(
                        tx,
                    );
                    await tx
                        .insertInto('inventory_movements')
                        .values(
                            chunk.map((batch) => ({
                                id: randomUUID(),
                                quantity_delta: batch.quantity,
                                before_snapshot: 'null',
                                after_snapshot: JSON.stringify(batch),
                                base_version: null,
                                operation_id: operation,
                                batch_id: batch.id,
                                unit_id: unitIds.get(batch.unit)!,
                                compensates_id: null,
                            })),
                        )
                        .execute();
                }
                return { items };
            }),
        );
    }
    create(userId: string, input: InventoryCreate) {
        return this.run(userId, input.scope, true, (tx, scope) =>
            this.replay(tx, userId, scope, 'create', input.idempotencyKey, input, async () => {
                return this.createIn(tx, scope, userId, input);
            }),
        );
    }
    command(userId: string, id: string, input: InventoryCommand) {
        return this.run(userId, input.scope, true, (tx, scope) =>
            this.replay(tx, userId, scope, id, input.idempotencyKey, input, async () => {
                const before = await this.batch(tx, scope, id);
                const batch = transition(before, input, new Date().toISOString());
                const unitId = await this.references(tx, scope, batch);
                await sql`update meal.inventory_batches set name=${batch.name},quantity=${batch.quantity}::numeric,quantity_known=${batch.quantity !== null},unit_id=${unitId}::uuid,location_id=${batch.locationId}::uuid,precision=${batch.precision},package_state=${batch.packageState},opened_at=${batch.openedAt}::timestamptz,purchased_on=${batch.purchasedOn}::date,expiry_on=${batch.expiryOn}::date,barcode_snapshot=${batch.barcode},archived_at=${batch.archivedAt}::timestamptz,metadata=${JSON.stringify({ pricePaidRub: batch.pricePaidRub, storeName: batch.storeName, quantitySource: batch.quantitySource, confidence: batch.confidence })}::jsonb,version=${batch.version} where id=${id}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                await this.movement(
                    tx,
                    userId,
                    scope,
                    input.idempotencyKey,
                    input.action === 'edit' ? 'adjust' : input.action,
                    before,
                    batch,
                    unitId,
                );
                return { batch };
            }),
        );
    }
    locations(userId: string, scopeKind: z.infer<typeof inventoryScopeSchema>) {
        return this.run(
            userId,
            scopeKind,
            false,
            async (tx, scope) => ({
                items: (
                    await sql`select id,name,type,version::integer as version from meal.storage_locations where scope_id=${scope}::uuid and archived_at is null order by name,id`.execute(
                        tx,
                    )
                ).rows,
            }),
            { items: [] },
        );
    }
    location(userId: string, input: z.infer<typeof inventoryLocationCommandSchema>) {
        return this.run(userId, input.scope, true, (tx, scope) =>
            this.replay(
                tx,
                userId,
                scope,
                input.action === 'rename' ? input.id : 'locations',
                input.idempotencyKey,
                input,
                async () => {
                    if (input.action === 'create') {
                        const location = { id: randomUUID(), name: input.name, type: input.type, version: 1 };
                        await tx
                            .insertInto('storage_locations')
                            .values({ ...location, scope_id: scope, archived_at: null })
                            .execute();
                        return { location };
                    }
                    const found = await tx
                        .selectFrom('storage_locations')
                        .select(['id', 'name', 'type', 'version'])
                        .where('id', '=', input.id)
                        .where('scope_id', '=', scope)
                        .where('archived_at', 'is', null)
                        .forUpdate()
                        .executeTakeFirst();
                    if (!found) throw new HttpException('Место хранения не найдено', 404);
                    if (Number(found.version) !== input.version)
                        throw new HttpException('Версия места изменилась', 412);
                    await tx
                        .updateTable('storage_locations')
                        .set({ name: input.name, version: input.version + 1 })
                        .where('id', '=', input.id)
                        .where('scope_id', '=', scope)
                        .execute();
                    return { location: { ...found, name: input.name, version: input.version + 1 } };
                },
            ),
        );
    }
    history(
        userId: string,
        scopeKind: z.infer<typeof inventoryScopeSchema>,
        batchId?: string,
        limit = 100,
        offset = 0,
        filters: {
            q?: string | undefined;
            action?: string | undefined;
            from?: string | undefined;
            to?: string | undefined;
        } = {},
    ) {
        return this.run(
            userId,
            scopeKind,
            false,
            async (tx, scope) => {
                const where = sql`o.scope_id=${scope}::uuid and b.scope_id=${scope}::uuid and (${batchId ?? null}::uuid is null or b.id=${batchId ?? null}::uuid) and position(lower(${filters.q ?? ''}) in lower(m.after_snapshot->>'name'))>0 and (${filters.action ?? null}::text is null or o.kind=${filters.action ?? null}) and (${filters.from ?? null}::timestamptz is null or o.effective_at>=${filters.from ?? null}::timestamptz) and (${filters.to ?? null}::timestamptz is null or o.effective_at<=${filters.to ?? null}::timestamptz)`;
                const rows = await sql<{
                    id: string;
                    action: string;
                    quantityDelta: string | null;
                    recordedAt: Date;
                    effectiveAt: Date;
                    actorId: string | null;
                    before: InventoryBatch | null;
                    after: InventoryBatch;
                }>`select m.id,o.kind as action,m.quantity_delta::text as "quantityDelta",o.recorded_at as "recordedAt",o.effective_at as "effectiveAt",o.actor_id as "actorId",m.before_snapshot as before,m.after_snapshot as after from meal.inventory_movements m join meal.inventory_operations o on o.id=m.operation_id join meal.inventory_batches b on b.id=m.batch_id where ${where} order by o.recorded_at desc,m.id limit ${limit} offset ${offset}`.execute(
                    tx,
                );
                const count = await sql<{
                    total: number;
                }>`select count(*)::integer as total from meal.inventory_movements m join meal.inventory_operations o on o.id=m.operation_id join meal.inventory_batches b on b.id=m.batch_id where ${where}`.execute(
                    tx,
                );
                return {
                    total: count.rows[0]?.total ?? 0,
                    limit,
                    offset,
                    items: rows.rows.map((row) => ({
                        ...row,
                        recordedAt: row.recordedAt.toISOString(),
                        effectiveAt: row.effectiveAt.toISOString(),
                    })),
                };
            },
            { items: [], total: 0, limit, offset },
        );
    }
}
