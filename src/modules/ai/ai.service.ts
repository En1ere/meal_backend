import {
    ConflictException,
    ForbiddenException,
    HttpException,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/public.js';
import { AiProvider, AiProviderError } from './ai-provider.js';
import { LegalConsentService } from '../legal-consents/public.js';
import {
    aiBalanceSchema,
    aiCapabilitiesSchema,
    aiContinueRequestSchema,
    aiConversationSchema,
    aiHistoryArchiveResultSchema,
    aiHistoryArchiveSchema,
    aiHistoryItemSchema,
    aiHistoryQuerySchema,
    aiHistorySchema,
    aiFamilySharingSchema,
    aiPreviewRequestSchema,
    aiPreviewSchema,
    aiOperationSchema,
    aiRunRequestSchema,
    aiRunSchema,
    aiTransferDecisionSchema,
    aiTransferRequestSchema,
    aiTransferResultSchema,
    type AiTaskType,
} from './ai.contracts.js';
import { aiContinuationPolicy } from './ai.domain.js';
import {
    AI_CONTEXT_POLICY_VERSION,
    aiContextSnapshotHash,
    aiContextSourceCount,
    aiContextSnapshotSchema,
    aiNutritionContextSchema,
    aiPreferencesContextSchema,
    aiTaskContextPolicies,
    aiTaskRequiresPersonalData,
    parseAiContextSnapshot,
    renderAiContext,
    type AiContextSnapshot,
} from './ai-context.js';
import {
    AI_TASK_RULE_VERSION,
    aiAvailableTasks,
    aiOrchestration,
    aiTask,
    aiTaskAvailable,
    aiTasks,
    aiTokenBudget,
    type AiContextManifest,
} from './ai-orchestration.js';

type Tx = Transaction<DatabaseSchema>;
type Allocation = { bucketId: string; amount: number };
type Snapshot = {
    allocations?: Allocation[];
    text?: string;
    failure?: string;
    refunded?: boolean;
    charged?: boolean;
    continuation?: boolean;
};
const aiCostSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
type LegacyReserveResult =
    | { item: z.infer<typeof aiHistoryItemSchema> }
    | {
          operationId: string;
          replayed: false;
          prompt: string;
          taskType: AiTaskType;
          usePersonalData: boolean;
          personalContext: AiContextSnapshot | null;
          cost: z.infer<typeof aiCostSchema>;
      };
type CanonicalReserveResult = { operationId: string; replayed: boolean };
type LegacyContinuationReserveResult =
    | { replayed: true }
    | {
          replayed: false;
          operationId: string;
          taskType: AiTaskType;
          usePersonalData: boolean;
          personalContext: AiContextSnapshot | null;
          cost: z.infer<typeof aiCostSchema>;
      };
const sourceLabels = {
    user_prompt: 'Текст запроса',
    personal_inventory: 'Личные запасы',
    preferences: 'Предпочтения и ограничения',
    nutrition_profile: 'Профиль и цели питания',
} as const;

const objectValue = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const stringValues = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const decimalValue = (value: unknown): string | null => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const normalized = String(value);
    return /^\d+(?:\.\d{1,8})?$/.test(normalized) ? normalized : null;
};

const MOSCOW_OFFSET = 3 * 60 * 60 * 1000;
const localBoundary = (
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    ms: number,
) => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(day, lastDay), hour, minute, second, ms) - MOSCOW_OFFSET);
};
export function monthlyQuotaWindow(activatedAt: Date, now: Date, subscriptionEndsAt: Date) {
    const activation = new Date(activatedAt.getTime() + MOSCOW_OFFSET);
    const localNow = new Date(now.getTime() + MOSCOW_OFFSET);
    const day = activation.getUTCDate();
    const parts = [
        activation.getUTCHours(),
        activation.getUTCMinutes(),
        activation.getUTCSeconds(),
        activation.getUTCMilliseconds(),
    ] as const;
    let year = localNow.getUTCFullYear();
    let month = localNow.getUTCMonth();
    let startsAt = localBoundary(year, month, day, ...parts);
    if (startsAt > now) {
        month--;
        if (month < 0) {
            month = 11;
            year--;
        }
        startsAt = localBoundary(year, month, day, ...parts);
    }
    let nextMonth = month + 1;
    let nextYear = year;
    if (nextMonth > 11) {
        nextMonth = 0;
        nextYear++;
    }
    const naturalEnd = localBoundary(nextYear, nextMonth, day, ...parts);
    return { startsAt, endsAt: naturalEnd < subscriptionEndsAt ? naturalEnd : subscriptionEndsAt };
}
const taskTypes = new Set<AiTaskType>(aiTasks.map((task) => task.code));
const legacyTaskTypes = new Set<AiTaskType>([
    'culinary_question',
    'recipe_from_stock',
    'substitution',
    'storage_advice',
]);
const statuses = new Set(['preview', 'processing', 'completed', 'failed', 'refunded']);
const historyCursorSchema = aiHistoryQuerySchema.pick({ archived: true }).extend({
    createdAt: z.iso.datetime(),
    id: z.uuid(),
});

@Injectable()
export class AiService {
    constructor(
        private readonly database: DatabaseService,
        private readonly provider: AiProvider,
        private readonly entitlements: EntitlementsService,
        private readonly legalConsents: LegalConsentService,
    ) {}

    private async ensureMonthlyAllowance(tx: Tx, userId: string) {
        const entitlement = await this.entitlements.resolve(userId, tx);
        const allowance = entitlement.capabilities.aiMonthlyAllowance;
        // Trial has its own fixed 10-action bucket. It must never receive the regular Pro allowance.
        if (entitlement.source === 'trial') return;
        if (!allowance || !entitlement.subscriptionId || !entitlement.periodEndsAt) return;
        const source = await tx
            .selectFrom('subscription_periods')
            .select(['starts_at as startsAt', 'ends_at as endsAt'])
            .where('subscription_id', '=', entitlement.subscriptionId)
            .where('starts_at', '<=', new Date())
            .where('ends_at', '>', new Date())
            .orderBy('starts_at', 'desc')
            .executeTakeFirst();
        if (!source) return;
        await tx
            .selectFrom('subscriptions')
            .select('id')
            .where('id', '=', entitlement.subscriptionId)
            .forUpdate()
            .executeTakeFirstOrThrow();
        const window = monthlyQuotaWindow(new Date(source.startsAt), new Date(), new Date(source.endsAt));
        if (entitlement.source !== 'family') {
            const existing = await tx
                .selectFrom('ai_quota_periods')
                .select('id')
                .where('subscription_id', '=', entitlement.subscriptionId)
                .where('starts_at', '=', window.startsAt)
                .where('ends_at', '=', window.endsAt)
                .executeTakeFirst();
            if (existing) return;
            const periodId = randomUUID();
            const bucketId = randomUUID();
            await tx
                .insertInto('ai_quota_periods')
                .values({
                    id: periodId,
                    starts_at: window.startsAt,
                    ends_at: window.endsAt,
                    granted_actions: allowance,
                    allocation_snapshot: { mode: 'personal', userId, amount: allowance },
                    subscription_id: entitlement.subscriptionId,
                    family_coverage_id: null,
                    trial_claim_id: null,
                })
                .execute();
            await tx
                .insertInto('ai_buckets')
                .values({
                    id: bucketId,
                    kind: 'subscription',
                    granted: allowance,
                    expires_at: window.endsAt,
                    balance_projection: allowance,
                    reserved_projection: 0,
                    user_id: userId,
                    family_id: null,
                    quota_period_id: periodId,
                    order_id: null,
                })
                .execute();
            await tx
                .insertInto('ai_ledger')
                .values({
                    id: randomUUID(),
                    kind: 'grant',
                    delta: allowance,
                    reserved_delta: 0,
                    recorded_at: new Date(),
                    idempotency_key: `quota:${periodId}:${userId}`,
                    bucket_id: bucketId,
                    operation_id: null,
                    compensates_id: null,
                })
                .execute();
            return;
        }
        if (!entitlement.familyId) return;
        const coverage = await tx
            .selectFrom('family_coverages')
            .select('id')
            .where('family_id', '=', entitlement.familyId)
            .where('subscription_id', '=', entitlement.subscriptionId)
            .where('selected_at', 'is not', null)
            .where((expression) =>
                expression.or([expression('ends_at', 'is', null), expression('ends_at', '>', new Date())]),
            )
            .forUpdate()
            .executeTakeFirst();
        if (!coverage) return;
        const existing = await tx
            .selectFrom('ai_quota_periods')
            .select('id')
            .where('family_coverage_id', '=', coverage.id)
            .where('starts_at', '=', window.startsAt)
            .where('ends_at', '=', window.endsAt)
            .executeTakeFirst();
        if (existing) return;
        const members = await tx
            .selectFrom('family_memberships')
            .select('user_id as userId')
            .where('family_id', '=', entitlement.familyId)
            .where('left_at', 'is', null)
            .orderBy('stable_order', 'asc')
            .execute();
        if (!members.length) return;
        const share = Math.floor(allowance / members.length);
        const reserve = allowance - share * members.length;
        const periodId = randomUUID();
        await tx
            .insertInto('ai_quota_periods')
            .values({
                id: periodId,
                starts_at: window.startsAt,
                ends_at: window.endsAt,
                granted_actions: allowance,
                allocation_snapshot: {
                    mode: 'family_equal',
                    members: members.map((member) => ({ userId: member.userId, amount: share })),
                    reserve,
                },
                subscription_id: null,
                family_coverage_id: coverage.id,
                trial_claim_id: null,
            })
            .execute();
        for (const member of members) {
            const bucketId = randomUUID();
            await tx
                .insertInto('ai_buckets')
                .values({
                    id: bucketId,
                    kind: 'subscription',
                    granted: share,
                    expires_at: window.endsAt,
                    balance_projection: share,
                    reserved_projection: 0,
                    user_id: member.userId,
                    family_id: null,
                    quota_period_id: periodId,
                    order_id: null,
                })
                .execute();
            await tx
                .insertInto('ai_ledger')
                .values({
                    id: randomUUID(),
                    kind: 'grant',
                    delta: share,
                    reserved_delta: 0,
                    recorded_at: new Date(),
                    idempotency_key: `quota:${periodId}:${member.userId}`,
                    bucket_id: bucketId,
                    operation_id: null,
                    compensates_id: null,
                })
                .execute();
        }
        if (reserve) {
            const bucketId = randomUUID();
            await tx
                .insertInto('ai_buckets')
                .values({
                    id: bucketId,
                    kind: 'family_reserve',
                    granted: reserve,
                    expires_at: window.endsAt,
                    balance_projection: reserve,
                    reserved_projection: 0,
                    user_id: null,
                    family_id: entitlement.familyId,
                    quota_period_id: periodId,
                    order_id: null,
                })
                .execute();
            await tx
                .insertInto('ai_ledger')
                .values({
                    id: randomUUID(),
                    kind: 'grant',
                    delta: reserve,
                    reserved_delta: 0,
                    recorded_at: new Date(),
                    idempotency_key: `quota:${periodId}:reserve`,
                    bucket_id: bucketId,
                    operation_id: null,
                    compensates_id: null,
                })
                .execute();
        }
    }

    async capabilities(userId: string) {
        const provider = this.provider.status();
        let storageReady = false;
        let availableTasks: ReadonlyArray<(typeof aiTasks)[number]> = [];
        if (this.database.db && (await this.database.ready())) {
            try {
                const [rule, entitlement] = await Promise.all([
                    sql<{
                        available: boolean;
                    }>`select exists(select 1 from meal.ai_rule_versions where kind='cost' and config->>'taskRuleVersion'=${AI_TASK_RULE_VERSION} and effective_at<=now()) and exists(select 1 from meal.ai_rule_versions where kind='context' and config->>'contextVersion'=${AI_CONTEXT_POLICY_VERSION} and effective_at<=now()) as available`.execute(
                        this.database.db,
                    ),
                    this.entitlements.resolve(userId, this.database.db),
                ]);
                storageReady = rule.rows[0]?.available === true;
                availableTasks = aiAvailableTasks(entitlement.plan);
            } catch {
                storageReady = false;
                availableTasks = [];
            }
        }
        return aiCapabilitiesSchema.parse({
            provider,
            executionAvailable: provider.configured && storageReady,
            purchaseMode: 'unavailable',
            freeTaskTypes: availableTasks
                .filter((task) => legacyTaskTypes.has(task.code))
                .map(({ code, label, cost }) => ({ code, label, cost })),
            taskTypes: availableTasks.map(({ code, label, taskClass, cost }) => ({
                code,
                label,
                taskClass,
                cost,
                tokenBudget: aiTokenBudget(cost),
            })),
            orchestrationRuleVersion: AI_TASK_RULE_VERSION,
            disclaimer:
                'AI может ошибаться. Проверяйте рецепты и советы. AI не заменяет врача или профессионального диетолога.',
        });
    }

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    private async writable(tx: Tx, userId: string) {
        const user =
            await sql`select id from meal.users where id=${userId}::uuid and status='active' and archived_at is null for update`.execute(
                tx,
            );
        if (!user.rows[0]) throw new HttpException('Аккаунт недоступен', 403);
        const sanction =
            await sql`select id from meal.sanctions where user_id=${userId}::uuid and scope in ('account','ai') and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                tx,
            );
        if (sanction.rows.length) throw new HttpException('Доступен только просмотр', 403);
    }

    private async taskEntitlement(tx: Tx, userId: string, taskType: AiTaskType) {
        const entitlement = await this.entitlements.resolve(userId, tx);
        if (!aiTaskAvailable(aiTask(taskType), entitlement.plan))
            throw new ForbiddenException('AI-задача недоступна на текущем тарифе');
        return entitlement;
    }

    private async buckets(executor: Tx | NonNullable<DatabaseService['db']>, userId: string, lock = false) {
        return (
            await sql<{
                id: string;
                kind: string;
                granted: number;
                balance: number;
                reserved: number;
                expiresAt: Date | null;
            }>`select b.id,b.kind,b.granted::integer,b.balance_projection::integer balance,b.reserved_projection::integer reserved,b.expires_at as "expiresAt" from meal.ai_buckets b where (b.user_id=${userId}::uuid or (b.kind='family_reserve' and exists(select 1 from meal.family_memberships m join meal.family_coverages c on c.family_id=m.family_id and c.selected_at is not null and (c.ends_at is null or c.ends_at>now()) where m.family_id=b.family_id and m.user_id=${userId}::uuid and m.left_at is null))) and (b.expires_at is null or b.expires_at>now()) and (b.kind<>'subscription' or exists(select 1 from meal.ai_quota_periods q left join meal.subscriptions s on s.id=q.subscription_id left join meal.family_coverages c on c.id=q.family_coverage_id where q.id=b.quota_period_id and ((q.subscription_id is not null and s.status='active') or (q.family_coverage_id is not null and c.selected_at is not null and (c.ends_at is null or c.ends_at>now()))))) order by case b.kind when 'subscription' then 1 when 'transferred' then 2 when 'family_reserve' then 3 when 'trial' then 4 when 'purchased' then 5 else 6 end,b.expires_at nulls last,b.created_at,b.id ${sql.raw(lock ? 'for update of b' : '')}`.execute(
                executor,
            )
        ).rows;
    }

    async balance(userId: string) {
        const rows = await this.database.transaction(async (tx) => {
            await this.ensureMonthlyAllowance(tx, userId);
            return this.buckets(tx, userId);
        });
        const buckets = rows.map((row) => ({
            ...row,
            kind: ['subscription', 'transferred', 'family_reserve', 'purchased', 'trial'].includes(row.kind)
                ? row.kind
                : 'purchased',
            available: Math.max(0, row.balance - row.reserved),
            requiresConfirmation: row.kind === 'family_reserve',
            expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
        }));
        const total = buckets.reduce((sum, row) => sum + row.balance, 0);
        const reserved = buckets.reduce((sum, row) => sum + row.reserved, 0);
        return aiBalanceSchema.parse({
            buckets,
            total,
            reserved,
            available: Math.max(0, total - reserved),
            debitOrder: ['subscription', 'transferred', 'family_reserve', 'trial', 'purchased'],
            packageOffer: { actions: 40, amountMinor: 19900, currency: 'RUB', purchaseMode: 'unavailable' },
        });
    }

    async familySharing(userId: string) {
        return this.database.transaction(async (tx) => {
            await this.ensureMonthlyAllowance(tx, userId);
            const entitlement = await this.entitlements.resolve(userId, tx);
            if (entitlement.source !== 'family' || !entitlement.familyId)
                throw new HttpException('Семейный AI-баланс доступен только участнику семьи Plus/Pro', 403);
            const members = await sql<{
                userId: string;
                displayName: string;
                available: number;
            }>`select m.user_id as "userId",u.display_name as "displayName",coalesce(sum(case when b.kind='subscription' then b.balance_projection-b.reserved_projection else 0 end),0)::integer as available from meal.family_memberships m join meal.users u on u.id=m.user_id left join meal.ai_buckets b on b.user_id=m.user_id and b.quota_period_id in(select q.id from meal.ai_quota_periods q join meal.family_coverages c on c.id=q.family_coverage_id where c.family_id=${entitlement.familyId}::uuid and q.ends_at>now()) where m.family_id=${entitlement.familyId}::uuid and m.left_at is null group by m.user_id,u.display_name,m.stable_order order by m.stable_order`.execute(
                tx,
            );
            const transfers = (await this.transferRows(tx, entitlement.familyId)).filter(
                (transfer) => transfer.donorId === userId || transfer.recipientId === userId,
            );
            return aiFamilySharingSchema.parse({
                members: members.rows.map((member) => ({
                    userId: member.userId,
                    displayName: member.displayName,
                    availableToTransfer: Math.max(0, member.available),
                    currentUser: member.userId === userId,
                })),
                transfers,
            });
        });
    }

    async requestTransfer(userId: string, raw: unknown) {
        const input = aiTransferRequestSchema.parse(raw);
        if (input.donorId === userId) throw new ConflictException('Нельзя запросить передачу у себя');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            await this.ensureMonthlyAllowance(tx, userId);
            const entitlement = await this.entitlements.resolve(userId, tx);
            if (entitlement.source !== 'family' || !entitlement.familyId)
                throw new HttpException('Семейная передача недоступна', 403);
            const requestHash = createHash('sha256').update(`${input.donorId}:${input.amount}`).digest('hex');
            const previous = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', 'ai-transfer-request')
                .where('target_binding', '=', entitlement.familyId)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (previous) {
                if (previous.request_hash !== requestHash) throw new ConflictException('Idempotency key already used');
                return aiTransferResultSchema.parse(previous.response_snapshot);
            }
            const period = await tx
                .selectFrom('ai_quota_periods as quota')
                .innerJoin('family_coverages as coverage', 'coverage.id', 'quota.family_coverage_id')
                .select(['quota.id', 'quota.ends_at as endsAt'])
                .where('coverage.family_id', '=', entitlement.familyId)
                .where('quota.ends_at', '>', new Date())
                .orderBy('quota.starts_at', 'desc')
                .forUpdate('quota')
                .executeTakeFirstOrThrow();
            const donor = await tx
                .selectFrom('family_memberships')
                .select('id')
                .where('family_id', '=', entitlement.familyId)
                .where('user_id', '=', input.donorId)
                .where('left_at', 'is', null)
                .executeTakeFirst();
            if (!donor) throw new ConflictException('Донор больше не состоит в семье');
            const recipient = await tx
                .selectFrom('ai_buckets')
                .select(['balance_projection as balance', 'reserved_projection as reserved'])
                .where('quota_period_id', '=', period.id)
                .where('user_id', '=', userId)
                .where('kind', '=', 'subscription')
                .executeTakeFirstOrThrow();
            if (Number(recipient.balance) - Number(recipient.reserved) > 0)
                throw new ConflictException('Запросить передачу можно после исчерпания своей доли');
            const from = await tx
                .selectFrom('ai_buckets')
                .select(['id', 'balance_projection as balance', 'reserved_projection as reserved'])
                .where('quota_period_id', '=', period.id)
                .where('user_id', '=', input.donorId)
                .where('kind', '=', 'subscription')
                .forUpdate()
                .executeTakeFirstOrThrow();
            if (Number(from.balance) - Number(from.reserved) < input.amount)
                throw new ConflictException('У донора недостаточно доступных действий');
            let to = await tx
                .selectFrom('ai_buckets')
                .select('id')
                .where('quota_period_id', '=', period.id)
                .where('user_id', '=', userId)
                .where('kind', '=', 'transferred')
                .executeTakeFirst();
            if (!to) {
                to = { id: randomUUID() };
                await tx
                    .insertInto('ai_buckets')
                    .values({
                        id: to.id,
                        kind: 'transferred',
                        granted: 0,
                        expires_at: new Date(period.endsAt),
                        balance_projection: 0,
                        reserved_projection: 0,
                        user_id: userId,
                        family_id: null,
                        quota_period_id: period.id,
                        order_id: null,
                    })
                    .execute();
            }
            const transferId = randomUUID();
            await tx
                .insertInto('ai_transfers')
                .values({
                    id: transferId,
                    amount: input.amount,
                    status: 'pending',
                    accepted_at: null,
                    expires_at: new Date(period.endsAt),
                    from_bucket_id: from.id,
                    to_bucket_id: to.id,
                    donor_id: input.donorId,
                    recipient_id: userId,
                })
                .execute();
            const transfer = (await this.transferRows(tx, entitlement.familyId, transferId))[0]!;
            const response = aiTransferResultSchema.parse({ transfer });
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'ai-transfer-request',
                    target_binding: entitlement.familyId,
                    key: input.idempotencyKey,
                    request_hash: requestHash,
                    status: 'completed',
                    response_snapshot: response,
                    expires_at: new Date(period.endsAt),
                    user_id: userId,
                    scope_id: null,
                    actor_namespace: `user:${userId}`,
                })
                .execute();
            return response;
        });
    }

    async decideTransfer(userId: string, rawTransferId: string, raw: unknown) {
        const transferId = aiRunRequestSchema.shape.previewId.parse(rawTransferId);
        const input = aiTransferDecisionSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const transfer = await tx
                .selectFrom('ai_transfers')
                .selectAll()
                .where('id', '=', transferId)
                .where('donor_id', '=', userId)
                .forUpdate()
                .executeTakeFirst();
            if (!transfer) throw new HttpException('Запрос передачи не найден', 404);
            const requestHash = createHash('sha256')
                .update(`${transferId}:${input.decision}:${input.expectedVersion}`)
                .digest('hex');
            const previous = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', 'ai-transfer-decision')
                .where('target_binding', '=', transferId)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (previous) {
                if (previous.request_hash !== requestHash) throw new ConflictException('Idempotency key already used');
                return aiTransferResultSchema.parse(previous.response_snapshot);
            }
            if (Number(transfer.version) !== input.expectedVersion) throw new ConflictException('Запрос изменился');
            if (transfer.status !== 'pending' || new Date(transfer.expires_at) <= new Date())
                throw new ConflictException('Запрос передачи уже недоступен');
            if (input.decision === 'accept') {
                const [from, to] = await Promise.all([
                    tx
                        .selectFrom('ai_buckets')
                        .selectAll()
                        .where('id', '=', transfer.from_bucket_id)
                        .forUpdate()
                        .executeTakeFirstOrThrow(),
                    tx
                        .selectFrom('ai_buckets')
                        .selectAll()
                        .where('id', '=', transfer.to_bucket_id)
                        .forUpdate()
                        .executeTakeFirstOrThrow(),
                ]);
                if (Number(from.balance_projection) - Number(from.reserved_projection) < Number(transfer.amount))
                    throw new ConflictException('У донора уже недостаточно доступных действий');
                const amount = Number(transfer.amount);
                await tx
                    .updateTable('ai_buckets')
                    .set({ balance_projection: sql`balance_projection-${amount}`, version: sql`version+1` })
                    .where('id', '=', from.id)
                    .execute();
                await tx
                    .updateTable('ai_buckets')
                    .set({
                        granted: sql`granted+${amount}`,
                        balance_projection: sql`balance_projection+${amount}`,
                        version: sql`version+1`,
                    })
                    .where('id', '=', to.id)
                    .execute();
                const at = new Date();
                await tx
                    .insertInto('ai_ledger')
                    .values([
                        {
                            id: randomUUID(),
                            kind: 'transfer_out',
                            delta: -amount,
                            reserved_delta: 0,
                            recorded_at: at,
                            idempotency_key: `${transferId}:out`,
                            bucket_id: from.id,
                            operation_id: null,
                            compensates_id: null,
                        },
                        {
                            id: randomUUID(),
                            kind: 'transfer_in',
                            delta: amount,
                            reserved_delta: 0,
                            recorded_at: at,
                            idempotency_key: `${transferId}:in`,
                            bucket_id: to.id,
                            operation_id: null,
                            compensates_id: null,
                        },
                    ])
                    .execute();
            }
            await tx
                .updateTable('ai_transfers')
                .set({
                    status: input.decision === 'accept' ? 'accepted' : 'rejected',
                    accepted_at: input.decision === 'accept' ? new Date() : null,
                    version: sql`version+1`,
                })
                .where('id', '=', transferId)
                .execute();
            const familyId = await tx
                .selectFrom('family_memberships')
                .select('family_id as familyId')
                .where('user_id', '=', userId)
                .where('left_at', 'is', null)
                .executeTakeFirstOrThrow();
            const current = (await this.transferRows(tx, familyId.familyId, transferId))[0]!;
            const response = aiTransferResultSchema.parse({ transfer: current });
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'ai-transfer-decision',
                    target_binding: transferId,
                    key: input.idempotencyKey,
                    request_hash: requestHash,
                    status: 'completed',
                    response_snapshot: response,
                    expires_at: new Date(transfer.expires_at),
                    user_id: userId,
                    scope_id: null,
                    actor_namespace: `user:${userId}`,
                })
                .execute();
            return response;
        });
    }

    private async transferRows(tx: Tx, familyId: string, transferId?: string) {
        let query = tx
            .selectFrom('ai_transfers as transfer')
            .innerJoin('users as donor', 'donor.id', 'transfer.donor_id')
            .innerJoin('users as recipient', 'recipient.id', 'transfer.recipient_id')
            .innerJoin('ai_buckets as source', 'source.id', 'transfer.from_bucket_id')
            .innerJoin('ai_quota_periods as quota', 'quota.id', 'source.quota_period_id')
            .innerJoin('family_coverages as coverage', 'coverage.id', 'quota.family_coverage_id')
            .select([
                'transfer.id',
                'transfer.donor_id as donorId',
                'donor.display_name as donorName',
                'transfer.recipient_id as recipientId',
                'recipient.display_name as recipientName',
                'transfer.amount',
                'transfer.status',
                'transfer.expires_at as expiresAt',
                'transfer.version',
            ])
            .where('coverage.family_id', '=', familyId)
            .orderBy('transfer.created_at', 'desc');
        if (transferId) query = query.where('transfer.id', '=', transferId);
        const rows = await query.execute();
        return rows.map((row) => ({
            ...row,
            amount: Number(row.amount),
            status: row.status === 'pending' && new Date(row.expiresAt) <= new Date() ? 'expired' : row.status,
            expiresAt: new Date(row.expiresAt).toISOString(),
            version: Number(row.version),
        }));
    }

    async history(userId: string, raw: unknown = {}) {
        const query = aiHistoryQuerySchema.parse(raw);
        let cursor: z.infer<typeof historyCursorSchema> | null = null;
        if (query.cursor) {
            try {
                cursor = historyCursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
            } catch {
                throw new HttpException('Некорректный cursor', 400);
            }
            if (cursor.archived !== query.archived) throw new HttpException('Cursor принадлежит другой выборке', 400);
        }
        const db = await this.db();
        const archiveFilter =
            query.archived === 'all'
                ? sql``
                : query.archived === 'archived'
                  ? sql`and c.archived_at is not null`
                  : sql`and c.archived_at is null`;
        const cursorFilter = cursor
            ? sql`and (t.created_at,t.id)<(${cursor.createdAt}::timestamptz,${cursor.id}::uuid)`
            : sql``;
        const rows =
            await sql<HistoryRow>`select t.id,c.title,t.preview->>'taskType' as "taskType",t.status,t.accepted_cost::integer cost,t.created_at as "createdAt",o.result_snapshot result,c.archived_at is not null archived,c.version::integer version from meal.ai_tasks t join meal.ai_conversations c on c.id=t.conversation_id left join lateral(select result_snapshot from meal.ai_operations o join meal.ai_intervals i on i.id=o.interval_id where i.task_id=t.id and o.result_snapshot ? 'text' order by o.created_at desc limit 1)o on true where c.user_id=${userId}::uuid ${archiveFilter} ${cursorFilter} order by t.created_at desc,t.id desc limit ${query.limit + 1}`.execute(
                db,
            );
        const count = await sql<{
            total: number;
        }>`select count(*)::integer total from meal.ai_tasks t join meal.ai_conversations c on c.id=t.conversation_id where c.user_id=${userId}::uuid ${archiveFilter}`.execute(
            db,
        );
        const page = rows.rows.slice(0, query.limit);
        const last = page.at(-1);
        return aiHistorySchema.parse({
            items: page.map((row) => this.item(row)),
            total: count.rows[0]?.total ?? 0,
            nextCursor:
                rows.rows.length > query.limit && last
                    ? Buffer.from(
                          JSON.stringify({
                              archived: query.archived,
                              createdAt: new Date(last.createdAt).toISOString(),
                              id: last.id,
                          }),
                      ).toString('base64url')
                    : null,
        });
    }

    async archiveHistory(userId: string, rawTaskId: string, raw: unknown) {
        const taskId = z.uuid().parse(rawTaskId);
        const input = aiHistoryArchiveSchema.parse(raw);
        const requestHash = createHash('sha256')
            .update(JSON.stringify({ taskId, archived: input.archived, expectedVersion: input.expectedVersion }))
            .digest('hex');
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const previous = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', 'ai-history-archive')
                .where('target_binding', '=', taskId)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (previous) {
                if (previous.request_hash !== requestHash) throw new ConflictException('Idempotency key already used');
                return aiHistoryArchiveResultSchema.parse(previous.response_snapshot);
            }
            const row = (
                await sql<
                    HistoryRow & { conversationId: string }
                >`select t.id,t.conversation_id as "conversationId",c.title,t.preview->>'taskType' as "taskType",t.status,t.accepted_cost::integer cost,t.created_at as "createdAt",o.result_snapshot result,c.archived_at is not null archived,c.version::integer version from meal.ai_tasks t join meal.ai_conversations c on c.id=t.conversation_id left join lateral(select result_snapshot from meal.ai_operations o join meal.ai_intervals i on i.id=o.interval_id where i.task_id=t.id and o.result_snapshot ? 'text' order by o.created_at desc limit 1)o on true where t.id=${taskId}::uuid and c.user_id=${userId}::uuid for update of c`.execute(
                    tx,
                )
            ).rows[0];
            if (!row) throw new HttpException('AI-беседа не найдена', 404);
            if (row.version !== input.expectedVersion) throw new ConflictException('AI-беседа уже изменена');
            const changedAt = new Date();
            await tx
                .updateTable('ai_conversations')
                .set({ archived_at: input.archived ? changedAt : null, version: row.version + 1 })
                .where('id', '=', row.conversationId)
                .execute();
            const response = aiHistoryArchiveResultSchema.parse({
                item: this.item({ ...row, archived: input.archived, version: row.version + 1 }),
            });
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'ai-history-archive',
                    target_binding: taskId,
                    key: input.idempotencyKey,
                    request_hash: requestHash,
                    status: 'completed',
                    response_snapshot: response,
                    expires_at: new Date(changedAt.getTime() + 24 * 60 * 60 * 1000),
                    user_id: userId,
                    scope_id: null,
                    actor_namespace: `user:${userId}`,
                })
                .execute();
            return response;
        });
    }

    async conversation(userId: string, rawTaskId: string) {
        const taskId = aiRunRequestSchema.shape.previewId.parse(rawTaskId);
        const db = await this.db();
        const task = (
            await sql<HistoryRow>`select t.id,c.title,t.preview->>'taskType' as "taskType",t.status,t.accepted_cost::integer cost,t.created_at as "createdAt",o.result_snapshot result,c.archived_at is not null archived,c.version::integer version from meal.ai_tasks t join meal.ai_conversations c on c.id=t.conversation_id left join lateral(select result_snapshot from meal.ai_operations o join meal.ai_intervals i on i.id=o.interval_id where i.task_id=t.id and o.result_snapshot ? 'text' order by o.created_at desc limit 1)o on true where t.id=${taskId}::uuid and c.user_id=${userId}::uuid`.execute(
                db,
            )
        ).rows[0];
        if (!task) throw new HttpException('AI-беседа не найдена', 404);
        const [messages, interval] = await Promise.all([
            sql<{
                id: string;
                role: string;
                body: string;
                createdAt: Date;
            }>`select m.id,m.role,m.body,m.created_at as "createdAt" from meal.ai_messages m join meal.ai_conversations c on c.id=m.conversation_id join meal.ai_tasks t on t.conversation_id=c.id where t.id=${taskId}::uuid and c.user_id=${userId}::uuid order by m.created_at,m.id limit 200`.execute(
                db,
            ),
            sql<{
                endsAt: Date;
                clarificationsUsed: number;
                status: string;
            }>`select ends_at as "endsAt",clarifications_used::integer as "clarificationsUsed",status from meal.ai_intervals where task_id=${taskId}::uuid order by starts_at desc,id desc limit 1`.execute(
                db,
            ),
        ]);
        const current = interval.rows[0];
        const continuationPolicy = aiContinuationPolicy({
            now: Date.now(),
            taskStatus: task.status,
            cost: task.cost,
            interval: current ?? null,
        });
        const continuation = {
            state: continuationPolicy.state,
            clarificationsUsed: continuationPolicy.clarificationsUsed,
            clarificationsRemaining: continuationPolicy.clarificationsRemaining,
            intervalEndsAt: continuationPolicy.intervalEndsAt,
            nextMessageCost: continuationPolicy.nextMessageCost,
        };
        return aiConversationSchema.parse({
            item: this.item(task),
            messages: messages.rows.map((message) => ({
                ...message,
                role: message.role === 'assistant' ? 'assistant' : 'user',
                createdAt: new Date(message.createdAt).toISOString(),
            })),
            continuation,
        });
    }

    async operation(userId: string, rawOperationId: string) {
        const operationId = z.uuid().parse(rawOperationId);
        const db = await this.db();
        const row = (
            await sql<{
                id: string;
                taskId: string;
                conversationId: string;
                taskType: string;
                lifecycleState: string;
                financialState: string;
                failureCategory: string | null;
                failureRetryable: boolean | null;
                result: unknown;
                createdAt: Date;
                updatedAt: Date;
                expiresAt: Date;
                version: number;
            }>`select o.id,i.task_id as "taskId",t.conversation_id as "conversationId",t.preview->>'taskType' as "taskType",o.lifecycle_state as "lifecycleState",o.financial_state as "financialState",o.failure_category as "failureCategory",o.failure_retryable as "failureRetryable",o.result_snapshot result,o.created_at as "createdAt",o.updated_at as "updatedAt",o.expires_at as "expiresAt",o.version::integer version from meal.ai_operations o join meal.ai_intervals i on i.id=o.interval_id join meal.ai_tasks t on t.id=i.task_id join meal.ai_conversations c on c.id=t.conversation_id where o.id=${operationId}::uuid and c.user_id=${userId}::uuid`.execute(
                db,
            )
        ).rows[0];
        if (!row || !taskTypes.has(row.taskType as AiTaskType)) throw new HttpException('AI-операция не найдена', 404);
        const snapshot = (row.result ?? {}) as Snapshot;
        const category =
            row.failureCategory === 'provider_outcome_unknown'
                ? 'provider_outcome_unknown'
                : row.failureCategory === 'process_interrupted'
                  ? 'process_interrupted'
                  : row.failureCategory
                    ? 'provider_error'
                    : null;
        const userMessage =
            category === 'provider_outcome_unknown'
                ? 'Результат запроса уточняется. Повторная отправка не требуется.'
                : category === 'process_interrupted'
                  ? 'Выполнение запроса прервалось. Результат уточняется, резерв пока сохранён.'
                  : category
                    ? 'AI-провайдер не завершил запрос. Зарезервированные действия освобождены.'
                    : null;
        return aiOperationSchema.parse({
            item: {
                id: row.id,
                taskId: row.taskId,
                conversationId: row.conversationId,
                taskType: row.taskType,
                taskPolicyVersion: AI_TASK_RULE_VERSION,
                contextManifestVersion: AI_CONTEXT_POLICY_VERSION,
                state: row.lifecycleState,
                financialState: row.financialState,
                failure: category
                    ? { category, retryable: row.failureRetryable === true, userMessage: userMessage! }
                    : null,
                result: row.lifecycleState === 'succeeded' && typeof snapshot.text === 'string' ? snapshot.text : null,
                createdAt: new Date(row.createdAt).toISOString(),
                updatedAt: new Date(row.updatedAt).toISOString(),
                expiresAt: new Date(row.expiresAt).toISOString(),
                version: Number(row.version),
                readUrl: `/api/v1/ai/operations/${row.id}`,
            },
        });
    }

    private item(row: HistoryRow) {
        const snapshot = row.result as Snapshot | null;
        return aiHistoryItemSchema.parse({
            id: row.id,
            title: row.title,
            taskType: row.taskType && taskTypes.has(row.taskType as AiTaskType) ? row.taskType : 'culinary_question',
            status: statuses.has(row.status) ? row.status : 'failed',
            cost: row.cost,
            createdAt: new Date(row.createdAt).toISOString(),
            result: typeof snapshot?.text === 'string' ? snapshot.text : null,
            archived: row.archived,
            version: row.version,
        });
    }

    async preview(userId: string, raw: unknown) {
        if (!this.provider.status().configured) throw new ServiceUnavailableException('AI provider is not configured');
        const input = aiPreviewRequestSchema.parse(raw);
        if (aiTaskRequiresPersonalData(input.taskType) && !input.usePersonalData)
            throw new HttpException('Для этой AI-задачи требуется разрешённый персональный контекст', 422);
        if (input.usePersonalData)
            await this.legalConsents.assertFeatureAccess(userId, 'ai_data_access', 'ai.personal_data');
        const taskDefinition = aiTask(input.taskType);
        const cost = taskDefinition.cost;
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            await this.ensureMonthlyAllowance(tx, userId);
            const entitlement = await this.taskEntitlement(tx, userId, input.taskType);
            const rule = (
                await sql<{
                    id: string;
                }>`select id from meal.ai_rule_versions where kind='cost' and config->>'taskRuleVersion'=${AI_TASK_RULE_VERSION} and effective_at<=now() order by version desc limit 1`.execute(
                    tx,
                )
            ).rows[0];
            if (!rule) throw new ServiceUnavailableException('AI orchestration rule is not configured');
            const contextRule = (
                await sql<{
                    available: boolean;
                }>`select exists(select 1 from meal.ai_rule_versions where kind='context' and config->>'contextVersion'=${AI_CONTEXT_POLICY_VERSION} and effective_at<=now()) as available`.execute(
                    tx,
                )
            ).rows[0];
            if (!contextRule?.available) throw new ServiceUnavailableException('AI context policy is not configured');
            const scope = (
                await sql<{
                    id: string;
                }>`select id from meal.data_scopes where kind='private' and user_id=${userId}::uuid limit 1`.execute(tx)
            ).rows[0];
            if (!scope) throw new ServiceUnavailableException('Personal data scope is not configured');
            const buckets = await this.buckets(tx, userId, true);
            const beforeReserveAvailable = buckets
                .filter((row) => row.kind !== 'family_reserve' && row.kind !== 'purchased')
                .reduce((sum, row) => sum + Math.max(0, row.balance - row.reserved), 0);
            const reserveAvailable = buckets
                .filter((row) => row.kind === 'family_reserve')
                .reduce((sum, row) => sum + Math.max(0, row.balance - row.reserved), 0);
            const purchasedAvailable = buckets
                .filter((row) => row.kind === 'purchased')
                .reduce((sum, row) => sum + Math.max(0, row.balance - row.reserved), 0);
            const available = beforeReserveAvailable + reserveAvailable + purchasedAvailable;
            if (available < cost) throw new ConflictException('Недостаточно AI-действий');
            const familyReserveRequired = Math.min(reserveAvailable, Math.max(0, cost - beforeReserveAvailable));
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 10 * 60_000);
            const conversationId = randomUUID();
            const taskId = randomUUID();
            if (input.usePersonalData)
                await this.legalConsents.assertFeatureAccess(userId, 'ai_data_access', 'ai.personal_data', tx);
            const personalContext = input.usePersonalData
                ? await this.personalContext(userId, input.taskType, entitlement.plan, tx)
                : null;
            const policy = aiTaskContextPolicies[input.taskType];
            const requiredSources = new Set<string>(policy.required);
            const sourceKinds = [
                'user_prompt' as const,
                ...new Set([...policy.required, ...policy.optional].filter((kind) => kind !== 'user_prompt')),
            ];
            const context: AiContextManifest = {
                personalDataUsed: personalContext !== null,
                sources: sourceKinds.flatMap((kind) => {
                    if (kind !== 'user_prompt' && !personalContext) return [];
                    const itemCount = kind === 'user_prompt' ? 1 : aiContextSourceCount(personalContext!, kind);
                    if (kind !== 'user_prompt' && itemCount === 0 && !requiredSources.has(kind)) return [];
                    return [
                        {
                            kind,
                            label: sourceLabels[kind],
                            itemCount,
                            truncated: kind === 'personal_inventory' && Boolean(personalContext?.inventoryTruncated),
                        },
                    ];
                }),
            };
            const orchestration = aiOrchestration(
                input.taskType,
                entitlement.plan === 'pro' ? 'pro' : 'normal',
                context,
            );
            const sources = context.sources.map(
                (source) => `${source.label}: ${source.itemCount}${source.truncated ? ', показаны первые 50' : ''}`,
            );
            await tx
                .insertInto('ai_conversations')
                .values({
                    id: conversationId,
                    title: input.prompt.slice(0, 80),
                    archived_at: null,
                    user_id: userId,
                    scope_id: scope.id,
                })
                .execute();
            await tx
                .insertInto('ai_tasks')
                .values({
                    id: taskId,
                    goal: input.prompt,
                    status: 'preview',
                    preview: {
                        taskType: input.taskType,
                        prompt: input.prompt,
                        usePersonalData: input.usePersonalData,
                        personalContext,
                        contextSnapshotHash: personalContext ? aiContextSnapshotHash(personalContext) : null,
                        sources,
                        orchestration,
                        expiresAt: expiresAt.toISOString(),
                        familyReserveRequired,
                    },
                    accepted_at: null,
                    accepted_cost: cost,
                    agreement_snapshot: {
                        version: 'ai-usage-v1',
                        acceptedAt: now.toISOString(),
                        contextVersion: personalContext?.version ?? null,
                        contextSnapshotHash: personalContext ? aiContextSnapshotHash(personalContext) : null,
                    },
                    conversation_id: conversationId,
                    rule_id: rule.id,
                })
                .execute();
            return aiPreviewSchema.parse({
                previewId: taskId,
                taskType: input.taskType,
                cost,
                prompt: input.prompt,
                balanceBefore: available,
                balanceAfter: available - cost,
                sources,
                expiresAt: expiresAt.toISOString(),
                providerReady: true,
                familyReserveRequired,
                orchestration,
            });
        });
    }

    async run(userId: string, raw: unknown) {
        if (!this.provider.legacyConfigured()) throw new ServiceUnavailableException('AI provider is not configured');
        const input = aiRunRequestSchema.parse(raw);
        const reserved = await this.reserve(userId, input.previewId, input.idempotencyKey, input.familyReserveAccepted);
        if ('item' in reserved) return aiRunSchema.parse(reserved);
        try {
            const answer = await this.provider.complete(
                this.providerPrompt(reserved.taskType, reserved.prompt, reserved.personalContext),
                aiTokenBudget(reserved.cost),
            );
            return await this.finalize(userId, reserved.operationId, 'completed', answer, false);
        } catch (error) {
            if (error instanceof AiProviderError && error.disposition === 'release')
                return await this.finalize(userId, reserved.operationId, 'refunded', null, false, 'provider_error');
            return this.markUnknown(userId, reserved.operationId);
        }
    }

    async enqueue(userId: string, raw: unknown) {
        if (!this.provider.status().configured) throw new ServiceUnavailableException('AI provider is not configured');
        const input = aiRunRequestSchema.parse(raw);
        const requestHash = createHash('sha256')
            .update(
                JSON.stringify({
                    contractVersion: 1,
                    previewId: input.previewId,
                    familyReserveAccepted: input.familyReserveAccepted,
                    taskPolicyVersion: AI_TASK_RULE_VERSION,
                    contextManifestVersion: AI_CONTEXT_POLICY_VERSION,
                }),
            )
            .digest('hex');
        const reserved = await this.reserve(
            userId,
            input.previewId,
            input.idempotencyKey,
            input.familyReserveAccepted,
            { requestHash },
        );
        return this.operation(userId, reserved.operationId);
    }

    async continueTask(userId: string, rawTaskId: string, raw: unknown) {
        if (!this.provider.legacyConfigured()) throw new ServiceUnavailableException('AI provider is not configured');
        const taskId = aiRunRequestSchema.shape.previewId.parse(rawTaskId);
        const input = aiContinueRequestSchema.parse(raw);
        const reserved = await this.reserveContinuation(
            userId,
            taskId,
            input.message,
            input.idempotencyKey,
            input.familyReserveAccepted,
        );
        if (reserved.replayed) return this.conversation(userId, taskId);
        try {
            const messages = await this.conversationMessages(userId, taskId);
            const answer = await this.provider.complete(
                this.providerConversationPrompt(reserved.taskType, messages, reserved.personalContext),
                aiTokenBudget(reserved.cost),
            );
            await this.finalize(userId, reserved.operationId, 'completed', answer, false);
        } catch (error) {
            if (error instanceof AiProviderError && error.disposition === 'release') {
                await this.finalize(userId, reserved.operationId, 'refunded', null, false, 'provider_error');
                throw new ServiceUnavailableException('AI provider request failed; reserved actions were released');
            }
            await this.markUnknown(userId, reserved.operationId);
        }
        return this.conversation(userId, taskId);
    }

    async enqueueContinuation(userId: string, rawTaskId: string, raw: unknown) {
        if (!this.provider.status().configured) throw new ServiceUnavailableException('AI provider is not configured');
        const taskId = aiRunRequestSchema.shape.previewId.parse(rawTaskId);
        const input = aiContinueRequestSchema.parse(raw);
        const requestHash = createHash('sha256')
            .update(
                JSON.stringify({
                    contractVersion: 1,
                    taskId,
                    message: input.message,
                    familyReserveAccepted: input.familyReserveAccepted,
                    taskPolicyVersion: AI_TASK_RULE_VERSION,
                    contextManifestVersion: AI_CONTEXT_POLICY_VERSION,
                }),
            )
            .digest('hex');
        const reserved = await this.reserveContinuation(
            userId,
            taskId,
            input.message,
            input.idempotencyKey,
            input.familyReserveAccepted,
            { requestHash },
        );
        return this.operation(userId, reserved.operationId);
    }

    private async markUnknown(userId: string, operationId: string) {
        return this.database.transaction(async (tx) => {
            const row = (
                await sql<FinalRow>`select o.status as "operationStatus",o.interval_id as "intervalId",i.task_id as id,t.conversation_id as "conversationId",c.title,t.preview->>'taskType' as "taskType",t.status,t.accepted_cost::integer cost,t.created_at as "createdAt",o.result_snapshot result,c.archived_at is not null archived,c.version::integer version from meal.ai_operations o join meal.ai_intervals i on i.id=o.interval_id join meal.ai_tasks t on t.id=i.task_id join meal.ai_conversations c on c.id=t.conversation_id where o.id=${operationId}::uuid and c.user_id=${userId}::uuid for update of o`.execute(
                    tx,
                )
            ).rows[0];
            if (!row) throw new ConflictException('AI-операция недоступна');
            if (row.operationStatus === 'processing') {
                const snapshot = (row.result ?? {}) as Snapshot;
                const result: Snapshot = {
                    ...snapshot,
                    failure: 'provider_outcome_unknown',
                };
                await sql`update meal.ai_operations set status='unknown',result_snapshot=${JSON.stringify(result)}::jsonb,version=version+1 where id=${operationId}::uuid and status='processing'`.execute(
                    tx,
                );
                return aiRunSchema.parse({ item: this.item({ ...row, result }) });
            }
            return aiRunSchema.parse({ item: this.item(row) });
        });
    }

    private reserveContinuation(
        userId: string,
        taskId: string,
        message: string,
        idempotencyKey: string,
        familyReserveAccepted: boolean,
        canonical: { requestHash: string },
    ): Promise<CanonicalReserveResult>;
    private reserveContinuation(
        userId: string,
        taskId: string,
        message: string,
        idempotencyKey: string,
        familyReserveAccepted: boolean,
    ): Promise<LegacyContinuationReserveResult>;
    private async reserveContinuation(
        userId: string,
        taskId: string,
        message: string,
        idempotencyKey: string,
        familyReserveAccepted: boolean,
        canonical?: { requestHash: string },
    ): Promise<CanonicalReserveResult | LegacyContinuationReserveResult> {
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const existing = (
                await sql<{
                    id: string;
                    status: string;
                    body: string;
                    requestHash: string;
                }>`select o.id,o.status,m.body,o.request_hash as "requestHash" from meal.ai_operations o join meal.ai_messages m on m.id=o.message_id join meal.ai_intervals i on i.id=o.interval_id join meal.ai_tasks t on t.id=i.task_id join meal.ai_conversations c on c.id=t.conversation_id where c.user_id=${userId}::uuid and o.idempotency_key=${idempotencyKey} and (${canonical ? sql`o.contract_version=1` : sql`t.id=${taskId}::uuid`}) limit 1 for update of o`.execute(
                    tx,
                )
            ).rows[0];
            if (existing) {
                if (canonical) {
                    if (existing.requestHash !== canonical.requestHash)
                        throw new ConflictException('Idempotency key already used for another AI command');
                    return { operationId: existing.id, replayed: true as const };
                }
                if (existing.body !== message) throw new ConflictException('Idempotency key already used');
                if (existing.status === 'processing') throw new ConflictException('AI-запрос ещё выполняется');
                if (existing.status === 'refunded')
                    throw new ServiceUnavailableException('AI provider request failed; reserved actions were released');
                return { replayed: true as const };
            }
            const task = (
                await sql<{
                    id: string;
                    status: string;
                    conversationId: string;
                    taskType: string;
                    usePersonalData: boolean;
                    personalContext: unknown;
                    cost: number;
                }>`select t.id,t.status,t.conversation_id as "conversationId",t.preview->>'taskType' as "taskType",coalesce((t.preview->>'usePersonalData')::boolean,false) as "usePersonalData",coalesce(t.preview->'personalContext','[]'::jsonb) as "personalContext",t.accepted_cost::integer cost from meal.ai_tasks t join meal.ai_conversations c on c.id=t.conversation_id where t.id=${taskId}::uuid and c.user_id=${userId}::uuid and t.accepted_at is not null and t.content_purged_at is null for update of t`.execute(
                    tx,
                )
            ).rows[0];
            if (!task || !taskTypes.has(task.taskType as AiTaskType))
                throw new HttpException('AI-беседа не найдена', 404);
            await this.taskEntitlement(tx, userId, task.taskType as AiTaskType);
            if (task.usePersonalData)
                await this.legalConsents.assertFeatureAccess(userId, 'ai_data_access', 'ai.personal_data', tx);
            if (task.status === 'processing') throw new ConflictException('AI-запрос ещё выполняется');
            const previous = (
                await sql<{
                    id: string;
                    endsAt: Date;
                    clarificationsUsed: number;
                    status: string;
                }>`select id,ends_at as "endsAt",clarifications_used::integer as "clarificationsUsed",status from meal.ai_intervals where task_id=${taskId}::uuid order by starts_at desc,id desc limit 1 for update`.execute(
                    tx,
                )
            ).rows[0];
            if (!previous) throw new ConflictException('Исходный запуск беседы не найден');
            const now = new Date();
            const policy = aiContinuationPolicy({
                now: now.getTime(),
                taskStatus: task.status,
                cost: task.cost,
                interval: previous,
            });
            if (policy.state === 'processing') throw new ConflictException('AI-запрос ещё выполняется');
            if (policy.state === 'wait')
                throw new ConflictException(
                    `Следующее сообщение доступно после ${new Date(previous.endsAt).toISOString()}`,
                );
            const charged = !policy.included;
            let intervalId = previous.id;
            const allocations: Allocation[] = [];
            if (charged) {
                const buckets = await this.buckets(tx, userId, true);
                const beforeReserveAvailable = buckets
                    .filter((bucket) => bucket.kind !== 'family_reserve' && bucket.kind !== 'purchased')
                    .reduce((sum, bucket) => sum + Math.max(0, bucket.balance - bucket.reserved), 0);
                const reserveAvailable = buckets
                    .filter((bucket) => bucket.kind === 'family_reserve')
                    .reduce((sum, bucket) => sum + Math.max(0, bucket.balance - bucket.reserved), 0);
                if (
                    Math.min(reserveAvailable, Math.max(0, task.cost - beforeReserveAvailable)) &&
                    !familyReserveAccepted
                )
                    throw new ConflictException('Подтвердите использование семейного AI-резерва');
                let remaining = task.cost;
                for (const bucket of buckets) {
                    if (bucket.kind === 'family_reserve' && !familyReserveAccepted) continue;
                    const amount = Math.min(remaining, Math.max(0, bucket.balance - bucket.reserved));
                    if (amount > 0) allocations.push({ bucketId: bucket.id, amount });
                    remaining -= amount;
                    if (!remaining) break;
                }
                if (remaining) throw new ConflictException('Недостаточно AI-действий');
                intervalId = randomUUID();
                await tx
                    .insertInto('ai_intervals')
                    .values({
                        id: intervalId,
                        starts_at: now,
                        ends_at: new Date(now.getTime() + 10 * 60_000),
                        clarifications_used: 0,
                        cost: task.cost,
                        status: 'processing',
                        task_id: taskId,
                    })
                    .execute();
            } else {
                await sql`update meal.ai_intervals set clarifications_used=clarifications_used+1,status='processing',version=version+1 where id=${intervalId}::uuid and clarifications_used<2`.execute(
                    tx,
                );
            }
            const messageId = randomUUID();
            const operationId = randomUUID();
            const operationExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
            await tx
                .insertInto('ai_messages')
                .values({
                    id: messageId,
                    role: 'user',
                    body: message,
                    client_message_key: idempotencyKey,
                    conversation_id: task.conversationId,
                    interval_id: intervalId,
                })
                .execute();
            await tx
                .insertInto('ai_operations')
                .values({
                    id: operationId,
                    status: 'processing',
                    result_snapshot: { allocations, charged, continuation: true },
                    started_at: now,
                    finished_at: null,
                    provider_cost: null,
                    idempotency_key: idempotencyKey,
                    interval_id: intervalId,
                    message_id: messageId,
                    ...(canonical
                        ? {
                              user_id: userId,
                              task_id: taskId,
                              contract_version: 1,
                              command_kind: 'continuation' as const,
                              request_hash: canonical.requestHash,
                              lifecycle_state: 'queued' as const,
                              financial_state: charged ? ('reserved' as const) : ('none' as const),
                              queued_at: now,
                              next_attempt_at: now,
                              requested_model: this.provider.status().model,
                              task_policy_version: AI_TASK_RULE_VERSION,
                              context_manifest_version: AI_CONTEXT_POLICY_VERSION,
                              provider_profile_version:
                                  this.provider.status().profileVersion ?? 'openai-responses-background-v1',
                              updated_at: now,
                              expires_at: operationExpiresAt,
                          }
                        : {}),
                })
                .execute();
            for (const allocation of allocations) {
                await this.ledger(tx, operationId, allocation, 'reserve', 0, allocation.amount, now);
                await sql`update meal.ai_buckets set reserved_projection=reserved_projection+${allocation.amount},version=version+1 where id=${allocation.bucketId}::uuid`.execute(
                    tx,
                );
                await this.recordFamilyReserveConsent(tx, userId, taskId, allocation, message, now);
            }
            await sql`update meal.ai_tasks set status='processing',version=version+1 where id=${taskId}::uuid`.execute(
                tx,
            );
            return {
                replayed: false as const,
                operationId,
                taskType: task.taskType as AiTaskType,
                usePersonalData: task.usePersonalData,
                personalContext: task.usePersonalData ? parseAiContextSnapshot(task.personalContext) : null,
                cost: aiCostSchema.parse(task.cost),
            };
        });
    }

    private reserve(
        userId: string,
        previewId: string,
        idempotencyKey: string,
        familyReserveAccepted: boolean,
        canonical: { requestHash: string },
    ): Promise<CanonicalReserveResult>;
    private reserve(
        userId: string,
        previewId: string,
        idempotencyKey: string,
        familyReserveAccepted: boolean,
    ): Promise<LegacyReserveResult>;
    private async reserve(
        userId: string,
        previewId: string,
        idempotencyKey: string,
        familyReserveAccepted: boolean,
        canonical?: { requestHash: string },
    ): Promise<LegacyReserveResult | CanonicalReserveResult> {
        return this.database.transaction(async (tx) => {
            await this.writable(tx, userId);
            const existing = canonical
                ? (
                      await sql<
                          ExistingRow & { requestHash: string }
                      >`select o.id as "operationId",o.status as "operationStatus",o.request_hash as "requestHash",i.task_id as id,c.title,t.preview->>'taskType' as "taskType",t.status,t.accepted_cost::integer cost,t.created_at as "createdAt",o.result_snapshot result,c.archived_at is not null archived,c.version::integer version from meal.ai_operations o join meal.ai_intervals i on i.id=o.interval_id join meal.ai_tasks t on t.id=i.task_id join meal.ai_conversations c on c.id=t.conversation_id where o.contract_version=1 and o.idempotency_key=${idempotencyKey} and c.user_id=${userId}::uuid for update of o`.execute(
                          tx,
                      )
                  ).rows[0]
                : (
                      await sql<ExistingRow>`select o.id as "operationId",o.status as "operationStatus",i.task_id as id,c.title,t.preview->>'taskType' as "taskType",t.status,t.accepted_cost::integer cost,t.created_at as "createdAt",o.result_snapshot result,c.archived_at is not null archived,c.version::integer version from meal.ai_operations o join meal.ai_intervals i on i.id=o.interval_id join meal.ai_tasks t on t.id=i.task_id join meal.ai_conversations c on c.id=t.conversation_id where i.task_id=${previewId}::uuid and o.idempotency_key=${idempotencyKey} and c.user_id=${userId}::uuid for update of o`.execute(
                          tx,
                      )
                  ).rows[0];
            if (existing) {
                if (canonical) {
                    if ((existing as ExistingRow & { requestHash: string }).requestHash !== canonical.requestHash)
                        throw new ConflictException('Idempotency key already used for another AI command');
                    return { operationId: existing.operationId, replayed: true as const };
                }
                if (existing.operationStatus === 'processing') throw new ConflictException('AI-запрос ещё выполняется');
                return { item: this.item(existing) };
            }
            const task = (
                await sql<PreviewRow>`select t.id,t.conversation_id as "conversationId",t.goal as prompt,t.preview->>'taskType' as "taskType",coalesce((t.preview->>'usePersonalData')::boolean,false) as "usePersonalData",coalesce(t.preview->'personalContext','[]'::jsonb) as "personalContext",t.preview->>'expiresAt' as "expiresAt",t.accepted_cost::integer cost from meal.ai_tasks t join meal.ai_conversations c on c.id=t.conversation_id where t.id=${previewId}::uuid and c.user_id=${userId}::uuid and t.status='preview' and t.content_purged_at is null for update of t`.execute(
                    tx,
                )
            ).rows[0];
            if (!task || !taskTypes.has(task.taskType as AiTaskType))
                throw new ConflictException('Предпросмотр недоступен');
            await this.taskEntitlement(tx, userId, task.taskType as AiTaskType);
            if (task.usePersonalData)
                await this.legalConsents.assertFeatureAccess(userId, 'ai_data_access', 'ai.personal_data', tx);
            const expiresAt = Date.parse(task.expiresAt);
            if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
                throw new ConflictException('Предпросмотр истёк');
            const buckets = await this.buckets(tx, userId, true);
            const beforeReserveAvailable = buckets
                .filter((bucket) => bucket.kind !== 'family_reserve' && bucket.kind !== 'purchased')
                .reduce((sum, bucket) => sum + Math.max(0, bucket.balance - bucket.reserved), 0);
            const reserveAvailable = buckets
                .filter((bucket) => bucket.kind === 'family_reserve')
                .reduce((sum, bucket) => sum + Math.max(0, bucket.balance - bucket.reserved), 0);
            if (Math.min(reserveAvailable, Math.max(0, task.cost - beforeReserveAvailable)) && !familyReserveAccepted)
                throw new ConflictException('Подтвердите использование семейного AI-резерва');
            let remaining = task.cost;
            const allocations: Allocation[] = [];
            for (const bucket of buckets) {
                if (bucket.kind === 'family_reserve' && !familyReserveAccepted) continue;
                const amount = Math.min(remaining, Math.max(0, bucket.balance - bucket.reserved));
                if (amount > 0) allocations.push({ bucketId: bucket.id, amount });
                remaining -= amount;
                if (!remaining) break;
            }
            if (remaining) throw new ConflictException('Недостаточно AI-действий');
            const intervalId = randomUUID();
            const messageId = randomUUID();
            const operationId = randomUUID();
            const startedAt = new Date();
            const operationExpiresAt = new Date(startedAt.getTime() + 30 * 24 * 60 * 60_000);
            await tx
                .insertInto('ai_intervals')
                .values({
                    id: intervalId,
                    starts_at: startedAt,
                    ends_at: new Date(startedAt.getTime() + 10 * 60_000),
                    clarifications_used: 0,
                    cost: task.cost,
                    status: 'processing',
                    task_id: task.id,
                })
                .execute();
            await tx
                .insertInto('ai_messages')
                .values({
                    id: messageId,
                    role: 'user',
                    body: task.prompt,
                    client_message_key: idempotencyKey,
                    conversation_id: task.conversationId,
                    interval_id: intervalId,
                })
                .execute();
            await tx
                .insertInto('ai_operations')
                .values({
                    id: operationId,
                    status: 'processing',
                    result_snapshot: { allocations, charged: true, continuation: false },
                    started_at: startedAt,
                    finished_at: null,
                    provider_cost: null,
                    idempotency_key: idempotencyKey,
                    interval_id: intervalId,
                    message_id: messageId,
                    ...(canonical
                        ? {
                              user_id: userId,
                              task_id: task.id,
                              contract_version: 1,
                              command_kind: 'initial' as const,
                              request_hash: canonical.requestHash,
                              lifecycle_state: 'queued' as const,
                              financial_state: 'reserved' as const,
                              queued_at: startedAt,
                              next_attempt_at: startedAt,
                              requested_model: this.provider.status().model,
                              task_policy_version: AI_TASK_RULE_VERSION,
                              context_manifest_version: AI_CONTEXT_POLICY_VERSION,
                              provider_profile_version:
                                  this.provider.status().profileVersion ?? 'openai-responses-background-v1',
                              updated_at: startedAt,
                              expires_at: operationExpiresAt,
                          }
                        : {}),
                })
                .execute();
            for (const allocation of allocations) {
                await this.ledger(tx, operationId, allocation, 'reserve', 0, allocation.amount, startedAt);
                await sql`update meal.ai_buckets set reserved_projection=reserved_projection+${allocation.amount},version=version+1 where id=${allocation.bucketId}::uuid`.execute(
                    tx,
                );
                await this.recordFamilyReserveConsent(tx, userId, task.id, allocation, task.prompt, startedAt);
            }
            await sql`update meal.ai_tasks set status='processing',accepted_at=${startedAt},version=version+1 where id=${task.id}::uuid`.execute(
                tx,
            );
            return {
                operationId,
                replayed: false as const,
                prompt: task.prompt,
                taskType: task.taskType as AiTaskType,
                usePersonalData: task.usePersonalData,
                personalContext: task.usePersonalData ? parseAiContextSnapshot(task.personalContext) : null,
                cost: aiCostSchema.parse(task.cost),
            };
        });
    }

    private async finalize(
        userId: string,
        operationId: string,
        outcome: 'completed' | 'refunded',
        text: string | null,
        requireWritable = true,
        failure = 'provider_error',
    ) {
        return this.database.transaction(async (tx) => {
            if (requireWritable) await this.writable(tx, userId);
            const row = (
                await sql<FinalRow>`select o.status as "operationStatus",o.interval_id as "intervalId",i.task_id as id,t.conversation_id as "conversationId",c.title,t.preview->>'taskType' as "taskType",t.status,t.accepted_cost::integer cost,t.created_at as "createdAt",o.result_snapshot result,c.archived_at is not null archived,c.version::integer version from meal.ai_operations o join meal.ai_intervals i on i.id=o.interval_id join meal.ai_tasks t on t.id=i.task_id join meal.ai_conversations c on c.id=t.conversation_id where o.id=${operationId}::uuid and c.user_id=${userId}::uuid for update of o`.execute(
                    tx,
                )
            ).rows[0];
            if (!row) throw new ConflictException('AI-операция недоступна');
            if (row.operationStatus !== 'processing') return aiRunSchema.parse({ item: this.item(row) });
            const snapshot = (row.result ?? {}) as Snapshot;
            const allocations = Array.isArray(snapshot.allocations) ? snapshot.allocations : [];
            const charged = snapshot.charged !== false;
            if (charged && !allocations.length)
                throw new ServiceUnavailableException('AI reservation snapshot is unavailable');
            const finishedAt = new Date();
            for (const allocation of charged ? allocations : []) {
                const delta = outcome === 'completed' ? -allocation.amount : 0;
                await this.ledger(
                    tx,
                    operationId,
                    allocation,
                    outcome === 'completed' ? 'capture' : 'release',
                    delta,
                    -allocation.amount,
                    finishedAt,
                );
                const updated =
                    await sql`update meal.ai_buckets set balance_projection=balance_projection+${delta},reserved_projection=reserved_projection-${allocation.amount},version=version+1 where id=${allocation.bucketId}::uuid and reserved_projection>=${allocation.amount}`.execute(
                        tx,
                    );
                if (!updated.numAffectedRows) throw new ConflictException('AI-резерв изменился');
            }
            if (outcome === 'completed' && text)
                await tx
                    .insertInto('ai_messages')
                    .values({
                        id: randomUUID(),
                        role: 'assistant',
                        body: text,
                        client_message_key: `${operationId}:assistant`,
                        conversation_id: row.conversationId,
                        interval_id: row.intervalId,
                    })
                    .execute();
            const result: Snapshot =
                outcome === 'completed'
                    ? { allocations, charged, continuation: Boolean(snapshot.continuation), text: text! }
                    : { allocations, charged, continuation: Boolean(snapshot.continuation), failure, refunded: true };
            await sql`update meal.ai_operations set status=${outcome === 'completed' ? 'succeeded' : 'failed'},result_snapshot=${JSON.stringify(result)}::jsonb,finished_at=${finishedAt},version=version+1 where id=${operationId}::uuid`.execute(
                tx,
            );
            const intervalStatus = outcome === 'refunded' && snapshot.continuation && !charged ? 'completed' : outcome;
            await sql`update meal.ai_intervals set status=${intervalStatus},version=version+1 where id=${row.intervalId}::uuid`.execute(
                tx,
            );
            if (outcome === 'refunded' && snapshot.continuation && !charged)
                await sql`update meal.ai_intervals set clarifications_used=greatest(0,clarifications_used-1),version=version+1 where id=${row.intervalId}::uuid`.execute(
                    tx,
                );
            const taskStatus = outcome === 'refunded' && snapshot.continuation ? 'completed' : outcome;
            await sql`update meal.ai_tasks set status=${taskStatus},version=version+1 where id=${row.id}::uuid`.execute(
                tx,
            );
            return aiRunSchema.parse({ item: this.item({ ...row, status: taskStatus, result }) });
        });
    }

    private async ledger(
        tx: Tx,
        operationId: string,
        allocation: Allocation,
        kind: string,
        delta: number,
        reservedDelta: number,
        at: Date,
    ) {
        await tx
            .insertInto('ai_ledger')
            .values({
                id: randomUUID(),
                kind,
                delta,
                reserved_delta: reservedDelta,
                recorded_at: at,
                idempotency_key: `${operationId}:${kind}:${allocation.bucketId}`,
                bucket_id: allocation.bucketId,
                operation_id: operationId,
                compensates_id: null,
            })
            .execute();
    }

    private async recordFamilyReserveConsent(
        tx: Tx,
        userId: string,
        taskId: string,
        allocation: Allocation,
        previewText: string,
        acceptedAt: Date,
    ) {
        const bucket = await tx
            .selectFrom('ai_buckets')
            .select('kind')
            .where('id', '=', allocation.bucketId)
            .executeTakeFirst();
        if (bucket?.kind !== 'family_reserve') return;
        const previewHash = createHash('sha256')
            .update(`${taskId}:${allocation.bucketId}:${allocation.amount}:${previewText}`)
            .digest('hex');
        await tx
            .insertInto('ai_reserve_consents')
            .values({
                id: randomUUID(),
                accepted_at: acceptedAt,
                actions: allocation.amount,
                preview_hash: previewHash,
                user_id: userId,
                task_id: taskId,
                bucket_id: allocation.bucketId,
            })
            .execute();
    }

    private async personalContext(
        userId: string,
        taskType: AiTaskType,
        plan: 'free' | 'plus' | 'pro',
        executor?: Tx | NonNullable<DatabaseService['db']>,
    ): Promise<AiContextSnapshot> {
        const db = executor ?? (await this.db());
        await this.legalConsents.assertFeatureAccess(userId, 'ai_data_access', 'ai.personal_data', db);
        const policy = aiTaskContextPolicies[taskType];
        const sources = new Set([...policy.required, ...policy.optional]);
        const inventoryRows = sources.has('personal_inventory')
            ? (
                  await sql<{
                      name: string;
                      quantity: string | null;
                      unit: string;
                  }>`select b.name,b.quantity::text,u.code as unit from meal.inventory_batches b join meal.units u on u.id=b.unit_id join meal.data_scopes s on s.id=b.scope_id where s.kind='private' and s.user_id=${userId}::uuid and b.archived_at is null order by b.expiry_on nulls last,b.created_at desc limit 51`.execute(
                      db,
                  )
              ).rows
            : [];

        let preferences: AiContextSnapshot['preferences'] = null;
        if (sources.has('preferences')) {
            const row = (
                await sql<{
                    preferences: unknown;
                }>`select preferences from meal.user_settings where user_id=${userId}::uuid limit 1`.execute(db)
            ).rows[0];
            const raw = objectValue(row?.preferences);
            const candidate = aiPreferencesContextSchema.safeParse({
                diets: stringValues(raw.diets),
                allergens: stringValues(raw.allergens),
                dislikes: stringValues(raw.dislikes),
                allergenMode: raw.allergenMode === 'hide' ? 'hide' : 'warn',
                equipment: objectValue(raw.equipment),
                goals: stringValues(raw.goals),
            });
            if (candidate.success) {
                preferences = candidate.data;
                if (preferences.allergens.length)
                    await this.legalConsents.assertFeatureAccess(
                        userId,
                        'special_category',
                        'ai.preferences.allergens',
                        db,
                    );
            }
        }

        let nutrition: AiContextSnapshot['nutrition'] = null;
        if (sources.has('nutrition_profile') && plan === 'pro') {
            const row = (
                await sql<{
                    profileData: unknown;
                    targets: unknown;
                }>`select p.profile_data as "profileData",t.targets from meal.nutrition_profiles p left join lateral (select targets from meal.nutrition_targets where profile_id=p.id and starts_on<=current_date and (ends_on is null or ends_on>=current_date) order by starts_on desc,created_at desc limit 1) t on true where p.user_id=${userId}::uuid order by p.created_at desc limit 1`.execute(
                    db,
                )
            ).rows[0];
            if (row) {
                const profile = objectValue(row.profileData);
                const targets = objectValue(row.targets);
                const goal = ['maintain', 'lose_weight', 'gain_weight', 'custom'].includes(String(profile.goal))
                    ? profile.goal
                    : null;
                const parsed = aiNutritionContextSchema.safeParse({
                    goal,
                    target: row.targets
                        ? {
                              energyKcal: decimalValue(targets.energyKcal ?? targets.energy_kcal),
                              proteinG: decimalValue(targets.proteinG ?? targets.protein_g),
                              fatG: decimalValue(targets.fatG ?? targets.fat_g),
                              carbohydrateG: decimalValue(targets.carbohydrateG ?? targets.carbohydrate_g),
                              fiberG: decimalValue(targets.fiberG ?? targets.fiber_g),
                          }
                        : null,
                });
                if (parsed.success) nutrition = parsed.data;
            }
        }

        const snapshot = aiContextSnapshotSchema.parse({
            version: AI_CONTEXT_POLICY_VERSION,
            inventory: inventoryRows.slice(0, 50),
            inventoryTruncated: inventoryRows.length > 50,
            preferences,
            nutrition,
            capturedAt: new Date().toISOString(),
        });
        const missing = policy.required.find((kind) => aiContextSourceCount(snapshot, kind) === 0);
        if (missing) throw new HttpException(`Для AI-задачи не хватает данных: ${sourceLabels[missing]}`, 422);
        return snapshot;
    }

    private async conversationMessages(userId: string, taskId: string) {
        return (
            await sql<{
                role: string;
                body: string;
            }>`select m.role,m.body from meal.ai_messages m join meal.ai_conversations c on c.id=m.conversation_id join meal.ai_tasks t on t.conversation_id=c.id where t.id=${taskId}::uuid and c.user_id=${userId}::uuid order by m.created_at desc,m.id desc limit 40`.execute(
                await this.db(),
            )
        ).rows.reverse();
    }

    private providerPrompt(taskType: AiTaskType, prompt: string, context: AiContextSnapshot | null) {
        return `Тип задачи: ${taskType}\nЗапрос пользователя:\n${prompt}\n\nРазрешённый снимок контекста:\n${renderAiContext(context)}`;
    }

    private providerConversationPrompt(
        taskType: AiTaskType,
        messages: Array<{ role: string; body: string }>,
        context: AiContextSnapshot | null,
    ) {
        const dialogue = messages
            .map((message) => `${message.role === 'assistant' ? 'Помощник' : 'Пользователь'}: ${message.body}`)
            .join('\n\n');
        return `Тип задачи: ${taskType}\nПродолжи ту же цель беседы. История:\n${dialogue}\n\nРазрешённый снимок контекста:\n${renderAiContext(context)}`;
    }

    purchase() {
        throw new ServiceUnavailableException('Test payment adapter is available only in development mocks');
    }
}

type HistoryRow = {
    id: string;
    title: string;
    taskType: string | null;
    status: string;
    cost: number;
    createdAt: Date;
    result: unknown;
    archived: boolean;
    version: number;
};
type ExistingRow = HistoryRow & { operationId: string; operationStatus: string };
type PreviewRow = {
    id: string;
    conversationId: string;
    prompt: string;
    taskType: string;
    usePersonalData: boolean;
    personalContext: unknown;
    expiresAt: string;
    cost: number;
};
type FinalRow = HistoryRow & { operationStatus: string; intervalId: string; conversationId: string };
