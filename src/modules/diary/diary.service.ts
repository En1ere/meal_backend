import { createHash, randomUUID } from 'node:crypto';
import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { decimal, decimalText } from '../inventory/inventory.domain.js';
import { ProAccessService } from '../pro-overview/pro-access.service.js';
import { LegalConsentService } from '../legal-consents/legal-consent.service.js';
import {
    diaryComponentSchema,
    diaryDaySchema,
    diaryEntrySchema,
    diaryMediaCapabilitySchema,
    diaryPortionDecisionResultSchema,
    diaryPortionProposalSchema,
    diaryResultSchema,
    diarySourcesSchema,
    type DiaryArchive,
    type DiaryComponent,
    type DiaryCreate,
    type DiaryEntry,
    type DiaryMediaUpload,
    type DiaryPortionDecision,
    type DiaryPortionProposal,
    type DiaryUpdate,
} from './diary.contracts.js';
import {
    aggregateNutrition,
    completeness,
    portionTransition,
    scaleNutrition,
    unknownNutrition,
} from './diary.domain.js';

type Tx = Transaction<DatabaseSchema>;
type EntryRow = {
    id: string;
    eatenAt: Date;
    meal: string;
    state: string;
    confirmationMethod: string;
    note: string | null;
    nutrition: unknown;
    proposalId: string | null;
    version: bigint | number;
    createdAt: Date;
};
type ProposalRow = {
    id: string;
    recipientId: string;
    batchId: string;
    name: string;
    quantity: string;
    unit: string;
    unitId: string;
    movementId: string;
    state: string;
    confirmationMethod: string | null;
    nutrition: unknown;
    availableAt: Date;
    dueAt: Date;
    decisionAt: Date | null;
    version: number;
};
type ComponentRow = {
    id: string;
    entryId: string;
    quantity: string;
    unit: string;
    source: unknown;
    nutrition: unknown;
};

const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const mediaCapability = diaryMediaCapabilitySchema.parse({
    mode: 'unavailable',
    reason: 'Object storage, KMS и malware scanner ещё не подключены',
    acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 10 * 1024 * 1024,
});

const nutritionSnapshot = (value: unknown): DiaryEntry['nutrition'] => {
    const source = record(value);
    const nested = record(source.nutrition);
    const candidate = Object.keys(nested).length ? nested : source;
    const pick = (camel: string, snake: string) => {
        const current = candidate[camel] ?? candidate[snake];
        return typeof current === 'string' || typeof current === 'number' ? String(current) : null;
    };
    return {
        energyKcal: pick('energyKcal', 'energy_kcal'),
        proteinG: pick('proteinG', 'protein_g'),
        fatG: pick('fatG', 'fat_g'),
        carbohydrateG: pick('carbohydrateG', 'carbohydrate_g'),
        fiberG: pick('fiberG', 'fiber_g'),
    };
};

@Injectable()
export class DiaryService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: ProAccessService,
        private readonly legalConsents: LegalConsentService,
    ) {}

    private async ready() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
    }

    private component(row: ComponentRow): DiaryComponent {
        const nutrition = { ...unknownNutrition(), ...record(row.nutrition) };
        const source = record(row.source);
        return diaryComponentSchema.parse({
            id: row.id,
            source: {
                type: source.type,
                id: source.id ?? null,
                name: source.name,
                scope: source.scope,
            },
            quantity: row.quantity,
            unit: row.unit,
            nutrition,
            completeness: completeness(nutrition),
            confidence: source.confidence ?? 'unconfirmed',
        });
    }

    private entry(row: EntryRow, components: DiaryComponent[]): DiaryEntry {
        const nutrition = { ...unknownNutrition(), ...record(row.nutrition) };
        return diaryEntrySchema.parse({
            id: row.id,
            eatenAt: new Date(row.eatenAt).toISOString(),
            meal: row.meal,
            state: row.state,
            confirmationMethod: row.confirmationMethod,
            proposalId: row.proposalId,
            note: row.note,
            nutrition,
            completeness: completeness(nutrition),
            components,
            version: Number(row.version),
            createdAt: new Date(row.createdAt).toISOString(),
        });
    }

    private async entries(tx: Tx, userId: string, date?: string, id?: string): Promise<DiaryEntry[]> {
        const rows = await sql<EntryRow>`
            select entry.id,entry.eaten_at as "eatenAt",entry.meal,entry.state,
                   entry.confirmation_method as "confirmationMethod",entry.note,
                   entry.nutrition_snapshot as nutrition,entry.proposal_id as "proposalId",
                   entry.version,entry.created_at as "createdAt"
            from meal.diary_entries entry
            where entry.owner_id=${userId}::uuid
              and (${id ?? null}::uuid is null or entry.id=${id ?? null}::uuid)
              and (${date ?? null}::date is null or (
                    entry.eaten_at at time zone coalesce(
                        (select settings.timezone from meal.user_settings settings where settings.user_id=${userId}::uuid),
                        'UTC'
                    )
                  )::date=${date ?? null}::date)
            order by entry.eaten_at,entry.created_at,entry.id
        `.execute(tx);
        if (!rows.rows.length) return [];
        const ids = rows.rows.map((row) => row.id);
        const components = await sql<ComponentRow>`
            select component.id,component.entry_id as "entryId",component.quantity::text as quantity,
                   unit.code as unit,component.food_snapshot as source,component.nutrition_snapshot as nutrition
            from meal.diary_components component
            join meal.units unit on unit.id=component.unit_id
            where component.entry_id in (${sql.join(ids.map((entryId) => sql`${entryId}::uuid`))})
            order by component.created_at,component.id
        `.execute(tx);
        const grouped = new Map<string, DiaryComponent[]>();
        for (const row of components.rows)
            grouped.set(row.entryId, [...(grouped.get(row.entryId) ?? []), this.component(row)]);
        return rows.rows.map((row) => this.entry(row, grouped.get(row.id) ?? []));
    }

    private async proposalRows(tx: Tx, userId: string, id?: string, dueOnly = false, lock = false) {
        const query = sql<ProposalRow>`
            select proposal.id,proposal.recipient_id as "recipientId",batch.id as "batchId",
                   coalesce(nullif(proposal.nutrition_snapshot->>'name',''),'Семейная порция') as name,
                   proposal.issued_quantity::text as quantity,unit.code as unit,unit.id as "unitId",
                   movement.id as "movementId",proposal.state,proposal.confirmation_method as "confirmationMethod",
                   proposal.nutrition_snapshot as nutrition,proposal.available_at as "availableAt",
                   proposal.due_at as "dueAt",proposal.decision_at as "decisionAt",proposal.version::integer
            from meal.portion_proposals proposal
            join meal.inventory_operations operation on operation.id=proposal.allocation_operation_id
            join meal.inventory_movements movement on movement.operation_id=operation.id
            join meal.inventory_batches batch on batch.id=movement.batch_id
            join meal.units unit on unit.id=proposal.issued_unit_id
            where proposal.recipient_id=${userId}::uuid
              and (${id ?? null}::uuid is null or proposal.id=${id ?? null}::uuid)
              and (${dueOnly}::boolean=false or (proposal.state='pending' and proposal.due_at<=now()))
            order by proposal.created_at desc,proposal.id
            ${lock ? sql`for update of proposal` : sql``}
        `;
        return (await query.execute(tx)).rows;
    }

    private projectProposal(row: ProposalRow, active: boolean): DiaryPortionProposal {
        return diaryPortionProposalSchema.parse({
            id: row.id,
            source: { batchId: row.batchId, name: row.name },
            quantity: row.quantity,
            unit: row.unit,
            state: row.state,
            confirmationMethod: row.confirmationMethod,
            availableAt: new Date(row.availableAt).toISOString(),
            dueAt: new Date(row.dueAt).toISOString(),
            decisionAt: row.decisionAt ? new Date(row.decisionAt).toISOString() : null,
            version: row.version,
            actions: {
                canConfirm: active && row.state === 'pending',
                canRefuse: active && row.state === 'pending',
                canCancel: row.state === 'auto_confirmed',
            },
        });
    }

    private async ensureProposalEntry(tx: Tx, row: ProposalRow, method: 'manual' | 'timeout') {
        const existing = await tx
            .selectFrom('diary_entries')
            .select('id')
            .where('proposal_id', '=', row.id)
            .executeTakeFirst();
        if (existing) return;
        const nutrition = nutritionSnapshot(row.nutrition);
        const entryId = randomUUID();
        const now = new Date();
        await tx
            .insertInto('diary_entries')
            .values({
                id: entryId,
                eaten_at: row.availableAt,
                meal: 'other',
                state: 'confirmed',
                confirmation_method: method,
                note: null,
                nutrition_snapshot: JSON.stringify(nutrition),
                owner_id: row.recipientId,
                proposal_id: row.id,
                created_at: now,
                version: 1,
            })
            .execute();
        await tx
            .insertInto('diary_components')
            .values({
                id: randomUUID(),
                quantity: row.quantity,
                food_snapshot: JSON.stringify({
                    type: 'portion_proposal',
                    id: row.id,
                    name: row.name,
                    scope: 'private',
                    confidence: 'unconfirmed',
                }),
                nutrition_snapshot: JSON.stringify(nutrition),
                entry_id: entryId,
                batch_id: row.batchId,
                movement_id: row.movementId,
                unit_id: row.unitId,
                created_at: now,
                version: 1,
            })
            .execute();
    }

    private async autoConfirmRow(tx: Tx, row: ProposalRow, syncDiary: boolean) {
        const changed = await sql<{ version: number }>`
            update meal.portion_proposals
            set state='auto_confirmed',decision_at=due_at,confirmation_method='timeout',version=version+1
            where id=${row.id}::uuid and state='pending' and due_at<=now()
            returning version::integer
        `.execute(tx);
        if (!changed.rows[0]) return row;
        const confirmed = {
            ...row,
            state: 'auto_confirmed',
            confirmationMethod: 'timeout',
            decisionAt: row.dueAt,
            version: changed.rows[0].version,
        };
        if (syncDiary) await this.ensureProposalEntry(tx, confirmed, 'timeout');
        await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,after_redacted,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,'portion.auto-confirmed','portion_proposal',${row.id}::uuid,${row.dueAt},now(),${JSON.stringify({ decision: 'auto_confirmed', confirmationMethod: 'timeout' })}::jsonb,${randomUUID()}::uuid,null,null)`.execute(
            tx,
        );
        return confirmed;
    }

    async reconcileDueForUser(tx: Tx, userId: string, syncDiary = true, eligibleBefore?: Date | null) {
        if (syncDiary) await this.legalConsents.assertFeatureAccess(userId, 'special_category', 'diary.entries', tx);
        const due = await this.proposalRows(tx, userId, undefined, true, true);
        const eligible = (row: ProposalRow) =>
            syncDiary &&
            (eligibleBefore === undefined || (eligibleBefore !== null && row.availableAt <= eligibleBefore));
        for (const row of due) await this.autoConfirmRow(tx, row, eligible(row));
        if (syncDiary) {
            const rows = await this.proposalRows(tx, userId);
            for (const row of rows) {
                if (!eligible(row)) continue;
                if (row.state === 'auto_confirmed') await this.ensureProposalEntry(tx, row, 'timeout');
                if (row.state === 'confirmed') await this.ensureProposalEntry(tx, row, 'manual');
            }
        }
    }

    async reconcileDueInScope(tx: Tx, scopeId: string) {
        const recipients = await sql<{ recipientId: string }>`
            select distinct proposal.recipient_id as "recipientId"
            from meal.portion_proposals proposal
            join meal.cooking_attempts attempt on attempt.id=proposal.attempt_id
            where attempt.scope_id=${scopeId}::uuid and proposal.state='pending' and proposal.due_at<=now()
        `.execute(tx);
        for (const row of recipients.rows) await this.reconcileDueForUser(tx, row.recipientId, false);
    }

    async runDue(limit = 100) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            const recipients = await sql<{ recipientId: string }>`
                select proposal.recipient_id as "recipientId"
                from meal.portion_proposals proposal
                where proposal.state='pending' and proposal.due_at<=now()
                group by proposal.recipient_id
                order by min(proposal.due_at),proposal.recipient_id
                limit ${limit}
            `.execute(tx);
            let processed = 0;
            for (const row of recipients.rows) {
                const before = (await this.proposalRows(tx, row.recipientId, undefined, true, true)).length;
                let syncDiary = true;
                let eligibleBefore: Date | null | undefined;
                try {
                    const access = await this.access.resolve(row.recipientId, tx);
                    if (access.mode === 'read_only')
                        eligibleBefore = access.periodEndsAt ? new Date(access.periodEndsAt) : null;
                    if (syncDiary)
                        syncDiary = await this.legalConsents.allowsFeatureAccess(
                            row.recipientId,
                            'special_category',
                            tx,
                        );
                } catch (error) {
                    if (error instanceof HttpException && error.getStatus() === 403) syncDiary = false;
                    else throw error;
                }
                await this.reconcileDueForUser(tx, row.recipientId, syncDiary, eligibleBefore);
                processed += before;
            }
            return { recipients: recipients.rows.length, processed };
        });
    }

    async decidePortionIn(tx: Tx, userId: string, proposalId: string, input: DiaryPortionDecision, syncDiary = true) {
        if (syncDiary) syncDiary = await this.legalConsents.allowsFeatureAccess(userId, 'special_category', tx);
        let row = (await this.proposalRows(tx, userId, proposalId, false, true))[0];
        if (!row) throw new HttpException('Назначение не найдено', 404);
        if (row.version !== input.expectedVersion) throw new HttpException('Назначение изменилось', 412);
        const due = row.state === 'pending' && row.dueAt.getTime() <= Date.now();
        if (due) row = await this.autoConfirmRow(tx, row, syncDiary);
        const transition = portionTransition(
            row.state as 'pending' | 'confirmed' | 'auto_confirmed' | 'refused' | 'cancelled',
            input.decision,
            false,
        );
        if (!transition) throw new HttpException('Решение недоступно в текущем состоянии', 409);
        const decisionAt = new Date();
        const changed = await sql<{ version: number }>`
            update meal.portion_proposals set state=${transition.next},decision_at=${decisionAt},
                confirmation_method=${transition.method},version=version+1
            where id=${row.id}::uuid and state=${transition.effective} and version=${row.version}
            returning version::integer
        `.execute(tx);
        if (!changed.rows[0]) throw new HttpException('Назначение изменилось', 412);
        row = {
            ...row,
            state: transition.next,
            confirmationMethod: transition.method,
            decisionAt,
            version: changed.rows[0].version,
        };
        if (syncDiary && transition.next === 'confirmed') await this.ensureProposalEntry(tx, row, 'manual');
        if (syncDiary && transition.next === 'cancelled')
            await sql`update meal.diary_entries set state='archived',version=version+1 where proposal_id=${row.id}::uuid and owner_id=${userId}::uuid and state<>'archived'`.execute(
                tx,
            );
        await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,after_redacted,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,'portion.decided','portion_proposal',${row.id}::uuid,now(),now(),${JSON.stringify({ decision: transition.next, previousState: transition.effective })}::jsonb,${input.idempotencyKey}::uuid,${userId}::uuid,null)`.execute(
            tx,
        );
        return row;
    }

    private async replay<T>(
        tx: Tx,
        userId: string,
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
            .where('operation', '=', 'diary')
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
                operation: 'diary',
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

    private async audit(tx: Tx, userId: string, action: string, entry: DiaryEntry, before: unknown) {
        await tx
            .insertInto('audit_events')
            .values({
                id: randomUUID(),
                action,
                target_type: 'diary_entry',
                target_id: entry.id,
                effective_at: new Date(entry.eatenAt),
                recorded_at: new Date(),
                reason: null,
                before_redacted: before === null ? null : JSON.stringify(before),
                after_redacted: JSON.stringify({
                    state: entry.state,
                    meal: entry.meal,
                    version: entry.version,
                    components: entry.components.length,
                }),
                request_id: randomUUID(),
                actor_id: userId,
                scope_id: null,
            })
            .execute();
    }

    private async resolveComponent(tx: Tx, userId: string, input: DiaryCreate['components'][number]) {
        const unit = await tx.selectFrom('units').select('id').where('code', '=', input.unit).executeTakeFirst();
        if (!unit) throw new HttpException('Единица измерения не найдена', 422);
        if (input.source.type === 'manual') {
            return {
                component: diaryComponentSchema.parse({
                    id: input.id,
                    source: { type: 'manual', id: null, name: input.source.name, scope: 'manual' },
                    quantity: input.quantity,
                    unit: input.unit,
                    nutrition: unknownNutrition(),
                    completeness: 'unknown',
                    confidence: 'unconfirmed',
                }),
                unitId: unit.id,
                batchId: null,
                movementId: null,
            };
        }
        if (input.source.type === 'inventory_batch') {
            const result = await sql<{
                id: string;
                name: string;
                quantity: string | null;
                version: bigint | number;
                unit: string;
                unitId: string;
                scopeId: string;
                composition: unknown;
                basis: string | null;
                basisUnit: string | null;
            }>`
                select batch.id,batch.name,batch.quantity::text as quantity,batch.version,
                       batch_unit.code as unit,batch.unit_id as "unitId",batch.scope_id as "scopeId",
                       case when composition.id is null then null else jsonb_build_object(
                           'kcal',composition.kcal,'protein',composition.protein,'fat',composition.fat,'carbs',composition.carbs
                       ) end as composition,
                       composition.basis_quantity::text as basis,basis_unit.code as "basisUnit"
                from meal.inventory_batches batch
                join meal.data_scopes scope on scope.id=batch.scope_id and scope.kind='private' and scope.user_id=${userId}::uuid
                join meal.units batch_unit on batch_unit.id=batch.unit_id
                left join meal.composition_versions composition on composition.id=batch.composition_id
                left join meal.units basis_unit on basis_unit.id=composition.basis_unit_id
                where batch.id=${input.source.batchId}::uuid and batch.archived_at is null
                for update of batch
            `.execute(tx);
            const batch = result.rows[0];
            if (!batch) throw new HttpException('Личный продукт не найден', 404);
            if (Number(batch.version) !== input.source.batchVersion)
                throw new HttpException('Версия остатка изменилась', 412);
            if (batch.unit !== input.unit) throw new HttpException('Единица должна совпадать с остатком', 422);
            if (batch.quantity === null) throw new HttpException('Сначала уточните остаток', 409);
            if (decimal(input.quantity) > decimal(batch.quantity))
                throw new HttpException('Недостаточно продукта', 422);
            const nextQuantity = decimalText(decimal(batch.quantity) - decimal(input.quantity));
            const nextVersion = Number(batch.version) + 1;
            await sql`update meal.inventory_batches set quantity=${nextQuantity}::numeric,version=${nextVersion} where id=${batch.id}::uuid and version=${Number(batch.version)}`.execute(
                tx,
            );
            const operationId = randomUUID();
            const movementId = randomUUID();
            const now = new Date();
            await tx
                .insertInto('inventory_operations')
                .values({
                    id: operationId,
                    kind: 'consume',
                    effective_at: now,
                    recorded_at: now,
                    status: 'completed',
                    idempotency_key: `diary:${input.id}`,
                    preview_hash: null,
                    scope_id: batch.scopeId,
                    actor_id: userId,
                    compensates_id: null,
                })
                .execute();
            await tx
                .insertInto('inventory_movements')
                .values({
                    id: movementId,
                    quantity_delta: decimalText(-decimal(input.quantity)),
                    before_snapshot: JSON.stringify({
                        id: batch.id,
                        quantity: batch.quantity,
                        unit: batch.unit,
                        version: Number(batch.version),
                    }),
                    after_snapshot: JSON.stringify({
                        id: batch.id,
                        quantity: nextQuantity,
                        unit: batch.unit,
                        version: nextVersion,
                    }),
                    base_version: Number(batch.version),
                    operation_id: operationId,
                    batch_id: batch.id,
                    unit_id: batch.unitId,
                    compensates_id: null,
                })
                .execute();
            const nutrition =
                batch.composition && batch.basis && batch.basisUnit === input.unit
                    ? scaleNutrition(record(batch.composition), input.quantity, batch.basis)
                    : unknownNutrition();
            return {
                component: diaryComponentSchema.parse({
                    id: input.id,
                    source: { type: 'inventory_batch', id: batch.id, name: batch.name, scope: 'private' },
                    quantity: input.quantity,
                    unit: input.unit,
                    nutrition,
                    completeness: completeness(nutrition),
                    confidence: batch.composition ? 'confirmed' : 'unconfirmed',
                }),
                unitId: batch.unitId,
                batchId: batch.id,
                movementId,
            };
        }
        if (input.source.type === 'ingredient') {
            const result = await sql<{
                id: string;
                name: string;
                unit: string;
                basis: string | null;
                composition: unknown;
            }>`
                select ingredient.id,ingredient.name,basis_unit.code as unit,composition.basis_quantity::text as basis,
                       case when composition.id is null then null else jsonb_build_object(
                           'kcal',composition.kcal,'protein',composition.protein,'fat',composition.fat,'carbs',composition.carbs
                       ) end as composition
                from meal.ingredients ingredient
                join meal.units default_unit on default_unit.id=ingredient.default_unit_id
                left join lateral (
                    select current.* from meal.composition_versions current
                    where current.ingredient_id=ingredient.id order by current.revision desc,current.created_at desc limit 1
                ) composition on true
                left join meal.units basis_unit on basis_unit.id=composition.basis_unit_id
                where ingredient.id=${input.source.ingredientId}::uuid and ingredient.status in ('active','approved','published')
            `.execute(tx);
            const ingredient = result.rows[0];
            if (!ingredient) throw new HttpException('Ингредиент не найден', 404);
            const nutrition =
                ingredient.composition && ingredient.basis && ingredient.unit === input.unit
                    ? scaleNutrition(record(ingredient.composition), input.quantity, ingredient.basis)
                    : unknownNutrition();
            return {
                component: diaryComponentSchema.parse({
                    id: input.id,
                    source: { type: 'ingredient', id: ingredient.id, name: ingredient.name, scope: 'catalog' },
                    quantity: input.quantity,
                    unit: input.unit,
                    nutrition,
                    completeness: completeness(nutrition),
                    confidence: ingredient.composition ? 'confirmed' : 'unconfirmed',
                }),
                unitId: unit.id,
                batchId: null,
                movementId: null,
            };
        }
        const result = await sql<{ id: string; name: string; portions: number; nutrition: unknown; scope: string }>`
            select recipe.id,recipe.title as name,revision.portions,revision.nutrition_snapshot as nutrition,scope.kind as scope
            from meal.recipes recipe
            join meal.data_scopes scope on scope.id=recipe.scope_id
            join lateral (
                select current.portions,current.nutrition_snapshot from meal.recipe_revisions current
                where current.recipe_id=recipe.id order by current.revision desc limit 1
            ) revision on true
            where recipe.id=${input.source.recipeId}::uuid and recipe.archived_at is null
              and (scope.kind='public' or (scope.kind='private' and scope.user_id=${userId}::uuid))
        `.execute(tx);
        const recipe = result.rows[0];
        if (!recipe) throw new HttpException('Рецепт не найден', 404);
        const nutrition =
            input.unit === 'serv' && recipe.nutrition
                ? scaleNutrition(record(recipe.nutrition), input.quantity, String(recipe.portions))
                : unknownNutrition();
        return {
            component: diaryComponentSchema.parse({
                id: input.id,
                source: {
                    type: 'recipe',
                    id: recipe.id,
                    name: recipe.name,
                    scope: recipe.scope === 'private' ? 'private' : 'public',
                },
                quantity: input.quantity,
                unit: input.unit,
                nutrition,
                completeness: completeness(nutrition),
                confidence: recipe.nutrition ? 'estimated' : 'unconfirmed',
            }),
            unitId: unit.id,
            batchId: null,
            movementId: null,
        };
    }

    async day(userId: string, date: string) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            await this.legalConsents.assertFeatureAccess(userId, 'special_category', 'diary.entries', tx);
            const access = await this.access.resolve(userId, tx);
            const eligibleBefore =
                access.mode === 'read_only' ? (access.periodEndsAt ? new Date(access.periodEndsAt) : null) : undefined;
            await this.reconcileDueForUser(tx, userId, true, eligibleBefore);
            const items = await this.entries(tx, userId, date);
            const linkedProposalIds = new Set(
                (
                    await tx
                        .selectFrom('diary_entries')
                        .select('proposal_id')
                        .where('owner_id', '=', userId)
                        .where('proposal_id', 'is not', null)
                        .execute()
                ).flatMap((row) => (row.proposal_id ? [row.proposal_id] : [])),
            );
            const proposals = (await this.proposalRows(tx, userId))
                .filter(
                    (row) =>
                        access.mode === 'active' ||
                        linkedProposalIds.has(row.id) ||
                        (eligibleBefore !== null && eligibleBefore !== undefined && row.availableAt <= eligibleBefore),
                )
                .map((row) => this.projectProposal(row, access.mode === 'active'));
            const activeItems = items.filter((entry) => entry.state !== 'archived');
            const nutrition = aggregateNutrition(activeItems.map((entry) => ({ nutrition: entry.nutrition })));
            return diaryDaySchema.parse({
                access,
                date,
                items,
                proposals,
                media: mediaCapability,
                summary: { entryCount: activeItems.length, nutrition, completeness: completeness(nutrition) },
            });
        });
    }

    async sources(userId: string, type: 'ingredient' | 'inventory_batch' | 'recipe', query: string, limit: number) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            await this.legalConsents.assertFeatureAccess(userId, 'special_category', 'diary.entries', tx);
            await this.access.resolve(userId, tx);
            if (type === 'inventory_batch') {
                const rows = await sql`
                    select 'inventory_batch' as type,batch.id,batch.name,unit.code as unit,batch.quantity::text as "availableQuantity",
                           batch.version::integer as version,'private' as scope
                    from meal.inventory_batches batch
                    join meal.data_scopes scope on scope.id=batch.scope_id and scope.kind='private' and scope.user_id=${userId}::uuid
                    join meal.units unit on unit.id=batch.unit_id
                    where batch.archived_at is null and position(lower(${query}) in lower(batch.name))>0
                    order by batch.name,batch.id limit ${limit}
                `.execute(tx);
                return diarySourcesSchema.parse({ items: rows.rows });
            }
            if (type === 'ingredient') {
                const rows = await sql`
                    select 'ingredient' as type,ingredient.id,ingredient.name,unit.code as unit,null::text as "availableQuantity",
                           null::integer as version,'catalog' as scope
                    from meal.ingredients ingredient join meal.units unit on unit.id=ingredient.default_unit_id
                    where ingredient.status in ('active','approved','published') and position(lower(${query}) in lower(ingredient.name))>0
                    order by ingredient.name,ingredient.id limit ${limit}
                `.execute(tx);
                return diarySourcesSchema.parse({ items: rows.rows });
            }
            const rows = await sql`
                select 'recipe' as type,recipe.id,recipe.title as name,'serv' as unit,null::text as "availableQuantity",
                       null::integer as version,case when scope.kind='private' then 'private' else 'public' end as scope
                from meal.recipes recipe join meal.data_scopes scope on scope.id=recipe.scope_id
                where recipe.archived_at is null and position(lower(${query}) in lower(recipe.title))>0
                  and (scope.kind='public' or (scope.kind='private' and scope.user_id=${userId}::uuid))
                order by recipe.title,recipe.id limit ${limit}
            `.execute(tx);
            return diarySourcesSchema.parse({ items: rows.rows });
        });
    }

    async create(userId: string, input: DiaryCreate) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            await this.legalConsents.assertFeatureAccess(userId, 'special_category', 'diary.entries', tx);
            await this.access.requireActive(userId, tx);
            return this.replay(tx, userId, userId, input.idempotencyKey, input, async () => {
                const resolved = [];
                for (const component of input.components)
                    resolved.push(await this.resolveComponent(tx, userId, component));
                const nutrition = aggregateNutrition(resolved.map(({ component }) => component));
                const id = randomUUID();
                const now = new Date();
                await tx
                    .insertInto('diary_entries')
                    .values({
                        id,
                        eaten_at: new Date(input.eatenAt),
                        meal: input.meal,
                        state: 'confirmed',
                        confirmation_method: 'manual',
                        note: input.note,
                        nutrition_snapshot: JSON.stringify(nutrition),
                        owner_id: userId,
                        proposal_id: null,
                        created_at: now,
                        version: 1,
                    })
                    .execute();
                await tx
                    .insertInto('diary_components')
                    .values(
                        resolved.map(({ component, unitId, batchId, movementId }) => ({
                            id: component.id,
                            quantity: component.quantity,
                            food_snapshot: JSON.stringify({ ...component.source, confidence: component.confidence }),
                            nutrition_snapshot: JSON.stringify(component.nutrition),
                            entry_id: id,
                            batch_id: batchId,
                            movement_id: movementId,
                            unit_id: unitId,
                            created_at: now,
                            version: 1,
                        })),
                    )
                    .execute();
                const entry = diaryEntrySchema.parse({
                    id,
                    eatenAt: input.eatenAt,
                    meal: input.meal,
                    state: 'confirmed',
                    confirmationMethod: 'manual',
                    proposalId: null,
                    note: input.note,
                    nutrition,
                    completeness: completeness(nutrition),
                    components: resolved.map(({ component }) => component),
                    version: 1,
                    createdAt: now.toISOString(),
                });
                await this.audit(tx, userId, 'diary.create', entry, null);
                return diaryResultSchema.parse({ entry });
            });
        });
    }

    async update(userId: string, id: string, input: DiaryUpdate) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            await this.legalConsents.assertFeatureAccess(userId, 'special_category', 'diary.entries', tx);
            await this.access.requireActive(userId, tx);
            return this.replay(tx, userId, id, input.idempotencyKey, input, async () => {
                const before = (await this.entries(tx, userId, undefined, id))[0];
                if (!before) throw new HttpException('Запись не найдена', 404);
                if (before.version !== input.expectedVersion) throw new HttpException('Версия записи изменилась', 412);
                await sql`update meal.diary_entries set eaten_at=${input.eatenAt}::timestamptz,meal=${input.meal},note=${input.note},version=${before.version + 1} where id=${id}::uuid and owner_id=${userId}::uuid and version=${before.version}`.execute(
                    tx,
                );
                const entry = diaryEntrySchema.parse({
                    ...before,
                    eatenAt: input.eatenAt,
                    meal: input.meal,
                    note: input.note,
                    version: before.version + 1,
                });
                await this.audit(tx, userId, 'diary.update', entry, {
                    state: before.state,
                    meal: before.meal,
                    version: before.version,
                    components: before.components.length,
                });
                return diaryResultSchema.parse({ entry });
            });
        });
    }

    async archive(userId: string, id: string, input: DiaryArchive) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            await this.legalConsents.assertFeatureAccess(userId, 'special_category', 'diary.entries', tx);
            await this.access.requireActive(userId, tx);
            return this.replay(tx, userId, id, input.idempotencyKey, input, async () => {
                const before = (await this.entries(tx, userId, undefined, id))[0];
                if (!before) throw new HttpException('Запись не найдена', 404);
                if (before.version !== input.expectedVersion) throw new HttpException('Версия записи изменилась', 412);
                const state = input.archived ? 'archived' : 'confirmed';
                await sql`update meal.diary_entries set state=${state},version=${before.version + 1} where id=${id}::uuid and owner_id=${userId}::uuid and version=${before.version}`.execute(
                    tx,
                );
                const entry = diaryEntrySchema.parse({ ...before, state, version: before.version + 1 });
                await this.audit(tx, userId, input.archived ? 'diary.archive' : 'diary.restore', entry, {
                    state: before.state,
                    meal: before.meal,
                    version: before.version,
                    components: before.components.length,
                });
                return diaryResultSchema.parse({ entry });
            });
        });
    }

    async decidePortion(userId: string, proposalId: string, input: DiaryPortionDecision) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            await this.legalConsents.assertFeatureAccess(userId, 'special_category', 'diary.entries', tx);
            if (input.decision === 'cancelled') await this.access.resolve(userId, tx);
            else await this.access.requireActive(userId, tx);
            return this.replay(tx, userId, proposalId, input.idempotencyKey, input, async () => {
                const row = await this.decidePortionIn(tx, userId, proposalId, input);
                const access = await this.access.resolve(userId, tx);
                return diaryPortionDecisionResultSchema.parse({
                    proposal: this.projectProposal(row, access.mode === 'active'),
                });
            });
        });
    }

    async uploadMedia(userId: string, entryId: string, input: DiaryMediaUpload) {
        void input;
        await this.ready();
        return this.database.transaction(async (tx) => {
            await this.legalConsents.assertFeatureAccess(userId, 'special_category', 'diary.entries', tx);
            await this.access.requireActive(userId, tx);
            const entry = await tx
                .selectFrom('diary_entries')
                .select('id')
                .where('id', '=', entryId)
                .where('owner_id', '=', userId)
                .executeTakeFirst();
            if (!entry) throw new HttpException('Запись не найдена', 404);
            throw new ServiceUnavailableException({
                code: 'DIARY_MEDIA_STORAGE_UNAVAILABLE',
                message: mediaCapability.reason,
            });
        });
    }
}
