import { Injectable, HttpException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { scopedWorkflow, workflowReplay, type WorkflowScope, type WorkflowTx } from '../cooking/workflow.store.js';
import {
    preserveHistoryDetailsSchema,
    preserveSchema,
    type Preserve,
    type preserveCreateSchema,
    type preserveEditSchema,
    type preserveListQuerySchema,
    type preserveCommandSchema,
    type preserveOpenSchema,
    type preserveQuantitySchema,
    type preserveConsumePreviewInputSchema,
    type preserveConsumeSchema,
    type preserveHistoryQuerySchema,
} from './preserves.contracts.js';
import { preserveTotal, preserveRemainder, preserveImage } from './preserves.domain.js';
import { consumePreserveContainer } from './preserves.store.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';

const projection = sql`p.id,p.batch_id as "batchId",p.version::integer,b.name,p.type,p.created_on::text as "createdOn",b.expiry_on::text as "expiryOn",p.shelf_life_days as "shelfLifeDays",b.location_id as "locationId",u.code as unit,p.volume_per_unit::text as "volumePerUnit",p.notes,coalesce(p.tags,'[]'::jsonb) as tags,coalesce(p.ingredients_snapshot,'[]'::jsonb) as ingredients,b.metadata->>'imageUrl' as "imageUrl",b.quantity::text,p.created_at as "createdAt",b.archived_at as "archivedAt",p.recipe_revision_id as "recipeRevisionId",rr.recipe_id as "recipeId",rr.title as "recipeTitle",coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'label',c.label,'initialQuantity',c.initial_quantity::text,'remainingQuantity',c.remaining_quantity::text,'openedAt',to_char(c.opened_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'depletedAt',to_char(c.depleted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'version',c.version) order by c.created_at,c.id) from meal.preserve_containers c where c.preserve_id=p.id),'[]'::jsonb) as containers`;
const joins = sql`from meal.preserve_details p join meal.inventory_batches b on b.id=p.batch_id left join meal.units u on u.id=b.unit_id left join meal.recipe_revisions rr on rr.id=p.recipe_revision_id`;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
const historyDetails = (value: unknown) => {
    const source =
        value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const result: Record<string, unknown> = {};
    for (const key of ['containerId', 'quantity', 'before', 'after', 'openedAt', 'recipeId', 'revisionId'] as const)
        if (typeof source[key] === 'string' || source[key] === null) result[key] = source[key];
    if (typeof source.containerCount === 'number') result.containerCount = source.containerCount;
    if (typeof source.labelId === 'string') result.labelId = source.labelId;
    if (typeof source.revision === 'number') result.revision = source.revision;
    return preserveHistoryDetailsSchema.parse(result);
};
const hydrate = (row: Record<string, unknown>, qr = false, scope: WorkflowScope = 'private') =>
    preserveSchema.parse({
        ...row,
        createdAt: iso(row.createdAt),
        archivedAt: iso(row.archivedAt),
        scope,
        capabilities: { qr, print: qr, reason: qr ? null : 'requires-plus' },
    });
function fail(message: string, status = 422): never {
    throw new HttpException(message, status);
}
@Injectable()
export class PreservesService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
    ) {}
    private async get(tx: WorkflowTx, scope: string, id: string, scopeKind: WorkflowScope) {
        const row = (
            await sql<
                Record<string, unknown>
            >`select ${projection} ${joins} where p.id=${id}::uuid and b.scope_id=${scope}::uuid and b.kind='preserve' for update of p,b`.execute(
                tx,
            )
        ).rows[0];
        if (!row) return fail('Заготовка не найдена', 404);
        return hydrate(row, false, scopeKind);
    }
    private check(p: Preserve, version: number, allowArchived = false) {
        if (p.version !== version) fail('Заготовка изменилась', 412);
        if (p.archivedAt && !allowArchived) fail('Заготовка в архиве', 409);
    }
    private async audit(
        tx: WorkflowTx,
        userId: string,
        scope: string | null,
        id: string,
        action: string,
        key: string,
        details: unknown,
    ) {
        await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,reason,before_redacted,after_redacted,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,${`preserve.${action}`},'preserve',${id}::uuid,now(),now(),null,null,${JSON.stringify(details)}::jsonb,${key},${userId}::uuid,${scope}::uuid)`.execute(
            tx,
        );
    }
    private async refs(tx: WorkflowTx, scope: string | null, unit: string | null, location: string | null) {
        const unitRow = unit
            ? (await sql<{ id: string }>`select id from meal.units where code=${unit}`.execute(tx)).rows[0]
            : null;
        if (unit && !unitRow) fail('Единица не найдена');
        if (
            location &&
            !(
                await sql`select id from meal.storage_locations where id=${location}::uuid and scope_id=${scope}::uuid and archived_at is null`.execute(
                    tx,
                )
            ).rows.length
        )
            fail('Место хранения недоступно');
        return unitRow?.id ?? null;
    }
    private async ingredientRefs(tx: WorkflowTx, userId: string, ingredients: Preserve['ingredients']) {
        for (const line of ingredients)
            if (
                line.ingredientId &&
                !(
                    await sql`select i.id from meal.ingredients i where i.id=${line.ingredientId}::uuid and (i.status in ('active','approved','published') or exists(select 1 from meal.catalog_proposals cp join meal.brand_products bp on bp.id=cp.product_id join meal.ingredient_variants v on v.id=bp.variant_id where v.ingredient_id=i.id and cp.author_id=${userId}::uuid and cp.status in ('draft','pending','submitted','needs_changes')))`.execute(
                        tx,
                    )
                ).rows.length
            )
                fail('Ингредиент недоступен');
    }
    list(userId: string, q: z.infer<typeof preserveListQuerySchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, q.scope, false, async (tx, scope) => {
            const qr = (await this.entitlements.resolve(userId, tx)).capabilities.qr;
            const base = sql`b.scope_id=${scope}::uuid and b.kind='preserve' and position(lower(${q.q}) in lower(b.name))>0 and (${q.type ?? null}::text is null or p.type=${q.type ?? null}) and (${q.locationId ?? null}::text is null or (${q.locationId ?? null}='none' and b.location_id is null) or b.location_id::text=${q.locationId ?? null}) and (${q.status}='all' or (${q.status}='active' and b.archived_at is null) or (${q.status}='archived' and b.archived_at is not null))`;
            const attention = sql`(${q.attention}='all' or (${q.attention}='unknown' and b.expiry_on is null) or (${q.attention}='expired' and b.expiry_on<${q.localDate}::date) or (${q.attention}='expiring' and b.expiry_on<=${q.localDate}::date+${q.days}::integer))`;
            const rows = await sql<
                Record<string, unknown>
            >`select ${projection} ${joins} where ${base} and ${attention} order by p.created_on desc,p.id limit ${q.limit} offset ${(q.page - 1) * q.limit}`.execute(
                tx,
            );
            const counts = (
                await sql<{
                    total: number;
                    attentionCount: number;
                }>`select count(*) filter(where ${attention})::integer as total,count(*) filter(where b.archived_at is null and b.expiry_on<=${q.localDate}::date+${q.days}::integer)::integer as "attentionCount" ${joins} where ${base}`.execute(
                    tx,
                )
            ).rows[0];
            return {
                items: rows.rows.map((row) => hydrate(row, qr, q.scope)),
                total: counts?.total ?? 0,
                attentionCount: counts?.attentionCount ?? 0,
                page: q.page,
                limit: q.limit,
            };
        });
    }
    detail(userId: string, id: string, scopeKind: WorkflowScope = 'private') {
        return scopedWorkflow(this.database, this.entitlements, userId, scopeKind, false, async (tx, scope) => {
            const qr = (await this.entitlements.resolve(userId, tx)).capabilities.qr;
            const preserve = await this.get(tx, scope, id, scopeKind);
            return {
                preserve: preserveSchema.parse({
                    ...preserve,
                    capabilities: { qr, print: qr, reason: qr ? null : 'requires-plus' },
                }),
            };
        });
    }
    qrLabel(userId: string, id: string, scopeKind: WorkflowScope = 'private') {
        return scopedWorkflow(this.database, this.entitlements, userId, scopeKind, false, async (tx, scope) => {
            await this.get(tx, scope, id, scopeKind);
            const available = (await this.entitlements.resolve(userId, tx)).capabilities.qr;
            const row = (
                await sql<{
                    id: string;
                    revision: number;
                    issuedAt: Date;
                    revokedAt: Date | null;
                    payload: unknown;
                }>`select q.id,q.revision::integer,q.issued_at as "issuedAt",q.revoked_at as "revokedAt",q.payload from meal.qr_labels q join meal.preserve_details p on p.id=q.preserve_id join meal.inventory_batches b on b.id=p.batch_id where q.preserve_id=${id}::uuid and b.scope_id=${scope}::uuid and q.revoked_at is null order by q.revision desc limit 1`.execute(
                    tx,
                )
            ).rows[0];
            return {
                label: row
                    ? { ...row, issuedAt: row.issuedAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null }
                    : null,
                capability: { available, reason: available ? null : ('requires-plus' as const) },
            };
        });
    }
    issueQrLabel(
        userId: string,
        id: string,
        input: { preserveVersion: number; idempotencyKey: string; scope: WorkflowScope },
    ) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'preserve-qr', id, input, async () => {
                const preserve = await this.get(tx, scope, id, input.scope);
                this.check(preserve, input.preserveVersion, true);
                if (!(await this.entitlements.resolve(userId, tx)).capabilities.qr)
                    fail('QR-этикетки доступны на тарифах Plus и Pro', 403);
                const revision = (
                    await sql<{
                        revision: number;
                    }>`select coalesce(max(revision),0)::integer+1 revision from meal.qr_labels where preserve_id=${id}::uuid`.execute(
                        tx,
                    )
                ).rows[0]!.revision;
                await sql`update meal.qr_labels set revoked_at=now(),version=version+1 where preserve_id=${id}::uuid and revoked_at is null`.execute(
                    tx,
                );
                const labelId = randomUUID();
                const payload = {
                    schemaVersion: 1 as const,
                    id: preserve.id,
                    name: preserve.name,
                    type: preserve.type,
                    createdOn: preserve.createdOn,
                    expiryOn: preserve.expiryOn,
                    appUrl: `mealplanner://preserve/${preserve.id}`,
                };
                await sql`insert into meal.qr_labels(id,payload,revision,issued_at,preserve_id) values(${labelId}::uuid,${JSON.stringify(payload)}::jsonb,${revision},now(),${id}::uuid)`.execute(
                    tx,
                );
                await this.audit(tx, userId, scope, id, 'qr-issued', input.idempotencyKey, { labelId, revision });
                return {
                    label: { id: labelId, revision, issuedAt: new Date().toISOString(), revokedAt: null, payload },
                    capability: { available: true, reason: null },
                };
            }),
        );
    }
    create(userId: string, input: z.infer<typeof preserveCreateSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'preserve', 'create', input, async () => {
                const unit = await this.refs(tx, scope, input.unit, input.locationId),
                    image = preserveImage(input.imageUrl);
                await this.ingredientRefs(tx, userId, input.ingredients);
                if (
                    input.recipeRevisionId &&
                    !(
                        await sql`select rr.id from meal.recipe_revisions rr join meal.recipes r on r.id=rr.recipe_id where rr.id=${input.recipeRevisionId}::uuid and r.archived_at is null and r.status not in ('hidden','deleted','unpublished','archived') and (r.scope_id=${scope}::uuid or exists(select 1 from meal.recipe_publications p where p.revision_id=rr.id and p.unpublished_at is null and p.published_at<=now()))`.execute(
                            tx,
                        )
                    ).rows.length
                )
                    fail('Рецепт-источник недоступен');
                const quantity = preserveTotal(input.containers.map((c) => c.quantity));
                if (quantity !== null && !unit) fail('Укажите единицу количества');
                const id = randomUUID(),
                    batchId = randomUUID();
                await sql`insert into meal.inventory_batches(id,kind,name,quantity,quantity_known,precision,package_state,expiry_on,scope_id,unit_id,location_id,created_by,metadata) values(${batchId}::uuid,'preserve',${input.name},${quantity}::numeric,${quantity !== null},'exact','sealed',${input.expiryOn}::date,${scope}::uuid,${unit}::uuid,${input.locationId}::uuid,${userId}::uuid,${JSON.stringify({ imageUrl: image, quantitySource: 'user' })}::jsonb)`.execute(
                    tx,
                );
                await sql`insert into meal.preserve_details(id,type,shelf_life_days,volume_per_unit,notes,tags,batch_id,recipe_revision_id,created_on,ingredients_snapshot) values(${id}::uuid,${input.type},${input.shelfLifeDays},${input.volumePerUnit}::numeric,${input.notes},${JSON.stringify(input.tags)}::jsonb,${batchId}::uuid,${input.recipeRevisionId}::uuid,${input.createdOn}::date,${JSON.stringify(input.ingredients)}::jsonb)`.execute(
                    tx,
                );
                for (const c of input.containers)
                    await sql`insert into meal.preserve_containers(id,preserve_id,label,initial_quantity,remaining_quantity,opened_at,depleted_at) values(${randomUUID()}::uuid,${id}::uuid,${c.label},${c.quantity}::numeric,${c.quantity}::numeric,null,case when ${c.quantity}::numeric=0 then now() else null end)`.execute(
                        tx,
                    );
                await this.audit(tx, userId, scope, id, 'created', input.idempotencyKey, {
                    quantity,
                    unit: input.unit,
                    containerCount: input.containers.length,
                });
                return { preserve: await this.get(tx, scope, id, input.scope) };
            }),
        );
    }
    edit(userId: string, id: string, input: z.infer<typeof preserveEditSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'preserve', `${id}:edit`, input, async () => {
                const p = await this.get(tx, scope, id, input.scope);
                this.check(p, input.version);
                const f = input.fields;
                if (
                    (
                        await sql`select 1 from meal.preserve_containers where preserve_id=${id}::uuid and opened_on<${f.createdOn}::date limit 1`.execute(
                            tx,
                        )
                    ).rows.length
                )
                    fail('Дата приготовления не может быть позже первого открытия');
                if (p.unit !== null && p.unit !== f.unit) fail('Единицу существующих банок менять нельзя', 409);
                if (f.unit === null && p.containers.some((c) => c.remainingQuantity !== null))
                    fail('Для количества нужна единица');
                const unit = await this.refs(tx, scope, f.unit, f.locationId);
                await this.ingredientRefs(tx, userId, f.ingredients);
                const image = preserveImage(f.imageUrl);
                await sql`update meal.inventory_batches set name=${f.name},unit_id=${unit}::uuid,location_id=${f.locationId}::uuid,expiry_on=${f.expiryOn}::date,metadata=coalesce(metadata,'{}'::jsonb)||${JSON.stringify({ imageUrl: image })}::jsonb,version=version+1 where id=${p.batchId}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                await sql`update meal.preserve_details set type=${f.type},shelf_life_days=${f.shelfLifeDays},volume_per_unit=${f.volumePerUnit}::numeric,notes=${f.notes},tags=${JSON.stringify(f.tags)}::jsonb,created_on=${f.createdOn}::date,ingredients_snapshot=${JSON.stringify(f.ingredients)}::jsonb,version=version+1 where id=${id}::uuid and version=${input.version}`.execute(
                    tx,
                );
                await this.audit(tx, userId, scope, id, 'edited', input.idempotencyKey, {
                    before: { name: p.name, type: p.type, locationId: p.locationId, expiryOn: p.expiryOn },
                    after: f,
                });
                return { preserve: await this.get(tx, scope, id, input.scope) };
            }),
        );
    }
    command(userId: string, id: string, action: 'archive' | 'restore', input: z.infer<typeof preserveCommandSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'preserve', `${id}:${action}`, input, async () => {
                const p = await this.get(tx, scope, id, input.scope);
                this.check(p, input.version, true);
                await sql`update meal.inventory_batches set archived_at=${action === 'archive' ? new Date() : null},version=version+1 where id=${p.batchId}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                await sql`update meal.preserve_details set version=version+1 where id=${id}::uuid and version=${input.version}`.execute(
                    tx,
                );
                await this.audit(tx, userId, scope, id, action, input.idempotencyKey, {});
                return { preserve: await this.get(tx, scope, id, input.scope) };
            }),
        );
    }
    open(userId: string, id: string, containerId: string, input: z.infer<typeof preserveOpenSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'preserve', `${id}:${containerId}:open`, input, async () => {
                const p = await this.get(tx, scope, id, input.scope);
                this.check(p, input.version);
                const c = p.containers.find((c) => c.id === containerId);
                if (!c) fail('Банка не найдена', 404);
                if (c.version !== input.containerVersion) fail('Банка изменилась', 412);
                if (c.openedAt) fail('Дата первого открытия уже записана', 409);
                if (Date.parse(input.openedAt) > Date.now()) fail('Дата открытия не может быть в будущем');
                const parts = new Intl.DateTimeFormat('en', {
                    timeZone: input.timezone,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                }).formatToParts(new Date(input.openedAt));
                const localDate = ['year', 'month', 'day']
                    .map((type) => parts.find((part) => part.type === type)!.value)
                    .join('-');
                if (localDate < p.createdOn) fail('Дата открытия раньше даты приготовления');
                await sql`update meal.preserve_containers set opened_at=${input.openedAt}::timestamptz,opened_on=${localDate}::date,updated_at=now(),version=version+1 where id=${containerId}::uuid and preserve_id=${id}::uuid and version=${input.containerVersion} and opened_at is null`.execute(
                    tx,
                );
                await sql`update meal.preserve_details set version=version+1 where id=${id}::uuid and version=${input.version}`.execute(
                    tx,
                );
                await this.audit(tx, userId, scope, id, 'opened', input.idempotencyKey, {
                    containerId,
                    openedAt: input.openedAt,
                });
                return { preserve: await this.get(tx, scope, id, input.scope) };
            }),
        );
    }
    quantity(userId: string, id: string, containerId: string, input: z.infer<typeof preserveQuantitySchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'preserve', `${id}:${containerId}:quantity`, input, async () => {
                const p = await this.get(tx, scope, id, input.scope);
                this.check(p, input.version);
                const c = p.containers.find((c) => c.id === containerId);
                if (!c) fail('Банка не найдена', 404);
                if (c.version !== input.containerVersion) fail('Банка изменилась', 412);
                if (input.quantity !== null && !p.unit) fail('Сначала укажите единицу в карточке');
                const quantity = preserveTotal(
                    p.containers.map((line) => (line.id === containerId ? input.quantity : line.remainingQuantity)),
                );
                await sql`update meal.preserve_containers set initial_quantity=case when ${input.quantity}::numeric is null then null else greatest(coalesce(initial_quantity,${input.quantity}::numeric),${input.quantity}::numeric) end,remaining_quantity=${input.quantity}::numeric,depleted_at=case when ${input.quantity}::numeric=0 then now() else null end,updated_at=now(),version=version+1 where id=${containerId}::uuid and preserve_id=${id}::uuid and version=${input.containerVersion}`.execute(
                    tx,
                );
                await sql`update meal.inventory_batches set quantity=${quantity}::numeric,quantity_known=${quantity !== null},version=version+1 where id=${p.batchId}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                await sql`update meal.preserve_details set version=version+1 where id=${id}::uuid and version=${input.version}`.execute(
                    tx,
                );
                await this.audit(tx, userId, scope, id, 'quantity-adjusted', input.idempotencyKey, {
                    containerId,
                    before: c.remainingQuantity,
                    initialQuantityBefore: c.initialQuantity,
                    after: input.quantity,
                });
                return { preserve: await this.get(tx, scope, id, input.scope) };
            }),
        );
    }
    private preview(userId: string, p: Preserve, input: z.infer<typeof preserveConsumePreviewInputSchema>) {
        this.check(p, input.version);
        const c = p.containers.find((c) => c.id === input.containerId);
        if (!c) fail('Банка не найдена', 404);
        if (c.version !== input.containerVersion) fail('Банка изменилась', 412);
        if (!p.unit) fail('Укажите единицу');
        const after = preserveRemainder(c.remainingQuantity, input.quantity),
            previewToken = createHash('sha256')
                .update(
                    JSON.stringify({
                        userId,
                        id: p.id,
                        version: p.version,
                        containerId: c.id,
                        containerVersion: c.version,
                        before: c.remainingQuantity,
                        quantity: input.quantity,
                        unit: p.unit,
                    }),
                )
                .digest('hex');
        return {
            preserveId: p.id,
            containerId: c.id,
            before: c.remainingQuantity!,
            after,
            unit: p.unit,
            previewToken,
        };
    }
    consumePreview(userId: string, id: string, input: z.infer<typeof preserveConsumePreviewInputSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.scope, false, async (tx, scope) =>
            this.preview(userId, await this.get(tx, scope, id, input.scope), input),
        );
    }
    consume(userId: string, id: string, input: z.infer<typeof preserveConsumeSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'preserve', `${id}:consume`, input, async () => {
                const p = await this.get(tx, scope, id, input.scope),
                    preview = this.preview(userId, p, input);
                if (preview.previewToken !== input.previewToken) fail('Предпросмотр устарел', 409);
                const batch = await sql<{
                    version: number;
                }>`select version::integer from meal.inventory_batches where id=${p.batchId}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                const batchVersion = batch.rows[0]!.version;
                const consumed = await consumePreserveContainer(
                    tx,
                    scope,
                    p.batchId,
                    input.containerId,
                    input.containerVersion,
                    input.quantity,
                );
                await sql`update meal.inventory_batches set quantity=${consumed.quantity}::numeric,quantity_known=${consumed.quantity !== null},version=version+1 where id=${p.batchId}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                );
                const operation = randomUUID(),
                    unit = await this.refs(tx, scope, p.unit, p.locationId);
                await sql`insert into meal.inventory_operations(id,kind,effective_at,recorded_at,status,idempotency_key,scope_id,actor_id) values(${operation}::uuid,'consume',now(),now(),'completed',${`preserve:${input.idempotencyKey}`},${scope}::uuid,${userId}::uuid)`.execute(
                    tx,
                );
                await sql`insert into meal.inventory_movements(id,quantity_delta,before_snapshot,after_snapshot,base_version,operation_id,batch_id,unit_id) values(${randomUUID()}::uuid,${`-${input.quantity}`}::numeric,${JSON.stringify(this.stockSnapshot({ ...p, version: batchVersion }))}::jsonb,${JSON.stringify(this.stockSnapshot({ ...p, quantity: consumed.quantity, version: batchVersion + 1 }))}::jsonb,${batchVersion},${operation}::uuid,${p.batchId}::uuid,${unit}::uuid)`.execute(
                    tx,
                );
                await this.audit(tx, userId, scope, id, 'consumed', input.idempotencyKey, preview);
                return { preserve: await this.get(tx, scope, id, input.scope) };
            }),
        );
    }
    private stockSnapshot(p: Preserve) {
        return {
            id: p.batchId,
            name: p.name,
            quantity: p.quantity,
            unit: p.unit,
            version: p.version,
            locationId: p.locationId,
            ingredientId: null,
            openedAt: null,
            purchasedOn: null,
            expiryOn: p.expiryOn,
            packageState: 'unknown',
            precision: 'exact',
            quantitySource: 'user',
            confidence: null,
            pricePaidRub: null,
            storeName: null,
            barcode: null,
            scope: p.scope,
            archivedAt: p.archivedAt,
            createdAt: p.createdAt,
        };
    }
    history(userId: string, id: string, q: z.infer<typeof preserveHistoryQuerySchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, q.scope, false, async (tx, scope) => {
            await this.get(tx, scope, id, q.scope);
            const rows = await sql<{
                id: string;
                action: string;
                recordedAt: Date;
                details: unknown;
            }>`select id,action,recorded_at as "recordedAt",after_redacted as details from meal.audit_events where target_type='preserve' and target_id=${id}::uuid and scope_id=${scope}::uuid order by recorded_at desc,id limit ${q.limit} offset ${(q.page - 1) * q.limit}`.execute(
                tx,
            );
            const count = (
                await sql<{
                    total: number;
                }>`select count(*)::integer total from meal.audit_events where target_type='preserve' and target_id=${id}::uuid and scope_id=${scope}::uuid`.execute(
                    tx,
                )
            ).rows[0];
            return {
                items: rows.rows.map((r) => ({
                    ...r,
                    recordedAt: r.recordedAt.toISOString(),
                    details: historyDetails(r.details),
                })),
                total: count?.total ?? 0,
                page: q.page,
                limit: q.limit,
            };
        });
    }
    recipeBase(userId: string, id: string, input: z.infer<typeof preserveCommandSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, input.scope, true, (tx, scope) =>
            workflowReplay(tx, userId, scope, 'preserve', `${id}:recipe-base`, input, async () => {
                const p = await this.get(tx, scope, id, input.scope);
                if (p.recipeRevisionId && p.recipeId) return { recipeId: p.recipeId, revisionId: p.recipeRevisionId };
                this.check(p, input.version);
                await this.ingredientRefs(tx, userId, p.ingredients);
                const recipeId = randomUUID(),
                    revisionId = randomUUID();
                await sql`insert into meal.recipes(id,title,status,author_id,scope_id) values(${recipeId}::uuid,${p.name},'draft',${userId}::uuid,${scope}::uuid)`.execute(
                    tx,
                );
                const description = `Основа из заготовки «${p.name}».\n${p.ingredients.map((i) => i.name).join(', ')}${p.notes ? '\n' + p.notes : ''}`;
                await sql`insert into meal.recipe_revisions(id,revision,title,portions,method,recipe_id,created_by,description,category,image_url,tags,change_kind) values(${revisionId}::uuid,1,${p.name},1,'',${recipeId}::uuid,${userId}::uuid,${description},null,${p.imageUrl},${p.tags}::text[],'preserve-base')`.execute(
                    tx,
                );
                for (const [index, line] of p.ingredients.entries())
                    if (line.ingredientId)
                        await sql`insert into meal.recipe_ingredients(id,position,quantity,optional,revision_id,ingredient_id,unit_id) values(${randomUUID()}::uuid,${index + 1},${line.quantity}::numeric,false,${revisionId}::uuid,${line.ingredientId}::uuid,(select id from meal.units where code=${line.unit}))`.execute(
                            tx,
                        );
                await sql`update meal.preserve_details set recipe_revision_id=${revisionId}::uuid,version=version+1 where id=${id}::uuid and version=${input.version} and recipe_revision_id is null`.execute(
                    tx,
                );
                await this.audit(tx, userId, scope, id, 'recipe-base-created', input.idempotencyKey, {
                    recipeId,
                    revisionId,
                });
                return { recipeId, revisionId };
            }),
        );
    }
}
