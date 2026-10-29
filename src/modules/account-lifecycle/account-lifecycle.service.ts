import {
    ConflictException,
    HttpException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { AuthService } from '../auth/auth.service.js';
import { hashPassword, newToken } from '../auth/crypto.js';
import { CriticalReauthService } from './critical-reauth.service.js';
import { AdminAccessService } from '../admin-auth/admin-access.service.js';
import type { Principal } from '../auth/auth.service.js';
import {
    deletionPreviewSchema,
    deletionRequestSchema,
    lifecycleStateSchema,
    retentionRunResultSchema,
} from './account-lifecycle.contracts.js';

type Connection = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;
const policySchema = z.strictObject({
    version: z.string().min(1).max(100),
    graceDays: z.number().int().min(1).max(365),
    accountDataDays: z.number().int().min(0).max(3650),
    paymentDocuments: z.strictObject({ mode: z.literal('retain'), days: z.number().int().min(1).max(7300) }),
    supportHistory: z.strictObject({ mode: z.literal('retain'), days: z.number().int().min(1).max(7300) }),
    auditHistory: z.strictObject({ mode: z.literal('retain'), days: z.number().int().min(1).max(7300) }),
    backups: z.strictObject({ mode: z.literal('expire_by_rotation'), maxDays: z.number().int().min(1).max(730) }),
    sharedFamilyHistory: z.literal('retain_pseudonymized'),
});
type RequestRow = {
    id: string;
    status: string;
    requested_at: Date;
    cancel_until: Date | null;
    cancelled_at: Date | null;
    finalization_not_before: Date | null;
    executed_at: Date | null;
    approved_at: Date | null;
    policy_version: string | null;
    blocker_snapshot: unknown;
    export_id: string | null;
    version: string | number;
};
type RequestRowWithUser = RequestRow & { user_id: string };

@Injectable()
export class AccountLifecycleService {
    constructor(
        private readonly database: DatabaseService,
        private readonly reauth: CriticalReauthService,
        private readonly auth: AuthService,
        private readonly adminAccess: AdminAccessService,
    ) {}
    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    private projection(row: RequestRow) {
        return deletionRequestSchema.parse({
            id: row.id,
            status: row.status,
            requestedAt: row.requested_at.toISOString(),
            cancelUntil: row.cancel_until?.toISOString() ?? null,
            finalizationNotBefore: row.finalization_not_before?.toISOString() ?? null,
            cancelledAt: row.cancelled_at?.toISOString() ?? null,
            finalizedAt: row.executed_at?.toISOString() ?? null,
            policyVersion: row.policy_version,
            blockers: row.blocker_snapshot,
            version: Number(row.version),
        });
    }
    private async current(userId: string, db: Connection, lock = false) {
        const suffix = lock ? sql`for update` : sql``;
        const rows =
            await sql<RequestRow>`select id,status,requested_at,cancel_until,cancelled_at,finalization_not_before,executed_at,approved_at,policy_version,blocker_snapshot,export_id,version
            from meal.legal_requests where user_id=${userId}::uuid and kind='account_deletion' order by requested_at desc,id desc limit 1 ${suffix}`.execute(
                db,
            );
        return rows.rows[0] ?? null;
    }
    private async deletionById(id: string, db: Connection, lock = false) {
        const suffix = lock ? sql`for update` : sql``;
        const rows =
            await sql<RequestRowWithUser>`select id,user_id,status,requested_at,cancel_until,cancelled_at,finalization_not_before,executed_at,approved_at,policy_version,blocker_snapshot,export_id,version
            from meal.legal_requests where id=${id}::uuid and kind='account_deletion' ${suffix}`.execute(db);
        return rows.rows[0] ?? null;
    }
    private async policy(db: Connection) {
        const result = await sql<{
            rules: unknown;
        }>`select rules from meal.feature_rule_versions where key='account_deletion_retention' and enabled and effective_at<=now() order by version desc limit 1`.execute(
            db,
        );
        const parsed = policySchema.safeParse(result.rows[0]?.rules);
        return parsed.success ? parsed.data : null;
    }
    private async blockers(userId: string, db: Connection, deletionRequestId: string | null = null) {
        const policy = await this.policy(db);
        const facts = await sql<{
            family_owner: boolean;
            active_subscription: boolean;
            payment_records: boolean;
            support_history: boolean;
            audit_history: boolean;
            legal_hold: boolean;
            export_ready: boolean;
        }>`select
          exists(select 1 from meal.families f join meal.family_memberships fm on fm.id=f.owner_membership_id where fm.user_id=${userId}::uuid and fm.left_at is null and f.archived_at is null) family_owner,
          exists(select 1 from meal.subscriptions s where s.owner_id=${userId}::uuid and s.status in('active','grace')) active_subscription,
          exists(select 1 from meal.billing_orders b where b.payer_id=${userId}::uuid or b.recipient_id=${userId}::uuid) payment_records,
          exists(select 1 from meal.support_tickets t where t.requester_id=${userId}::uuid) support_history,
          exists(select 1 from meal.audit_events a where a.actor_id=${userId}::uuid) audit_history,
          exists(select 1 from meal.legal_requests l where l.user_id=${userId}::uuid and l.kind='legal_hold' and l.status in('active','approved')) legal_hold,
          exists(
            select 1 from meal.legal_requests l
            join meal.export_jobs e on e.id=l.export_id
            where l.id=${deletionRequestId}::uuid and l.user_id=${userId}::uuid and l.kind='account_deletion'
              and e.user_id=l.user_id and e.kind='personal_data' and e.format='json'
              and e.status='ready' and e.file_id is not null and e.expires_at>now()
          ) export_ready`.execute(db);
        const f = facts.rows[0]!;
        const blockers = [] as Array<{ code: string; message: string; blocksFinalization: boolean }>;
        if (f.family_owner)
            blockers.push({
                code: 'family_owner',
                message: 'Сначала передайте владение семьёй.',
                blocksFinalization: true,
            });
        if (f.active_subscription)
            blockers.push({
                code: 'active_subscription',
                message: 'Сначала завершите активную подписку.',
                blocksFinalization: true,
            });
        if (f.legal_hold)
            blockers.push({
                code: 'legal_hold',
                message: 'Удаление приостановлено действующим legal hold.',
                blocksFinalization: true,
            });
        if (deletionRequestId && !f.export_ready)
            blockers.push({
                code: 'export_not_ready',
                message: 'Перед удалением подготовьте актуальный экспорт персональных данных.',
                blocksFinalization: true,
            });
        if (!policy)
            blockers.push({
                code: 'retention_policy_unconfigured',
                message: 'Политика хранения данных аккаунта ещё не опубликована.',
                blocksFinalization: true,
            });
        else
            blockers.push({
                code: 'backup_exclusion',
                message: `Резервные копии истекают по ротации максимум через ${policy.backups.maxDays} дн.; точечное удаление из backup не выполняется.`,
                blocksFinalization: false,
            });
        if (f.payment_records)
            blockers.push({
                code: 'payment_records',
                message: 'Платёжные документы сохраняются по опубликованной политике.',
                blocksFinalization: false,
            });
        if (f.support_history)
            blockers.push({
                code: 'support_history',
                message: 'История поддержки сохраняется по опубликованной политике.',
                blocksFinalization: false,
            });
        if (f.audit_history)
            blockers.push({
                code: 'audit_history',
                message: 'Аудит сохраняется в минимизированном виде по опубликованной политике.',
                blocksFinalization: false,
            });
        return { policy, blockers };
    }
    async state(userId: string) {
        const db = await this.db();
        const user = await sql<{
            archived_at: Date | null;
        }>`select archived_at from meal.users where id=${userId}::uuid`.execute(db);
        const row = await this.current(userId, db);
        return lifecycleStateSchema.parse({
            archived: !!user.rows[0]?.archived_at,
            deletion: row ? this.projection(row) : null,
        });
    }
    async preview(userId: string) {
        const db = await this.db();
        const { policy, blockers } = await this.blockers(userId, db);
        const shown = [
            ...blockers,
            {
                code: 'admin_approval_required' as const,
                message: 'Перед финализацией требуется отдельное критичное подтверждение администратора.',
                blocksFinalization: true,
            },
        ];
        return deletionPreviewSchema.parse({
            canRequest: true,
            canFinalize: false,
            blockers: shown,
            policyVersion: policy?.version ?? null,
            finalizationNotBefore: policy
                ? new Date(Date.now() + Math.max(policy.graceDays, policy.accountDataDays) * 86400000).toISOString()
                : null,
        });
    }
    async archive(userId: string, sessionId: string, token: string, idempotencyKey: string, requestId: string) {
        return this.database.transaction(async (tx) => {
            const key = `account.archive:${idempotencyKey}`;
            const requestHash = createHash('sha256')
                .update(JSON.stringify({ reauthToken: token, idempotencyKey }))
                .digest('hex');
            await sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`},0))`.execute(tx);
            const replay = await sql<{
                response_snapshot: unknown;
                request_hash: string;
            }>`select response_snapshot,request_hash from meal.idempotency_records where actor_namespace='user' and user_id=${userId}::uuid and operation='account.archive' and key=${key}`.execute(
                tx,
            );
            if (replay.rows[0]) {
                if (replay.rows[0].request_hash !== requestHash)
                    throw new ConflictException('Idempotency key already used with another request');
                return replay.rows[0].response_snapshot;
            }
            await this.reauth.consume(tx, userId, sessionId, token, 'account_lifecycle');
            await sql`update meal.users set status='archived',archived_at=coalesce(archived_at,now()),version=version+1 where id=${userId}::uuid and status='active'`.execute(
                tx,
            );
            await sql`update meal.sessions set revoked_at=coalesce(revoked_at,now()),version=version+1 where user_id=${userId}::uuid and revoked_at is null`.execute(
                tx,
            );
            const response = { archived: true as const };
            await sql`insert into meal.idempotency_records(id,operation,target_binding,key,request_hash,status,response_snapshot,expires_at,user_id,scope_id,actor_namespace)
              values(${randomUUID()}::uuid,'account.archive',${userId},${key},${requestHash},'completed',${JSON.stringify(response)}::jsonb,now()+interval '30 days',${userId}::uuid,null,'user')`.execute(
                tx,
            );
            await this.auth.audit(tx, userId, 'account.archived', userId, requestId);
            return response;
        });
    }
    async requestDeletion(userId: string, sessionId: string, token: string, idempotencyKey: string, requestId: string) {
        return this.database.transaction(async (tx) => {
            await sql`select pg_advisory_xact_lock(hashtextextended(${`account-deletion:${userId}`},0))`.execute(tx);
            const replay =
                await sql<RequestRow>`select id,status,requested_at,cancel_until,cancelled_at,finalization_not_before,executed_at,approved_at,policy_version,blocker_snapshot,export_id,version from meal.legal_requests where user_id=${userId}::uuid and kind='account_deletion' and idempotency_key=${idempotencyKey}::uuid limit 1`.execute(
                    tx,
                );
            if (replay.rows[0]) return this.projection(replay.rows[0]);
            await this.reauth.consume(tx, userId, sessionId, token, 'account_lifecycle');
            const existing = await this.current(userId, tx, true);
            if (existing && ['requested', 'retention_wait', 'ready', 'blocked'].includes(existing.status))
                return this.projection(existing);
            const { policy, blockers } = await this.blockers(userId, tx);
            const now = new Date();
            const id = randomUUID();
            const cancelUntil = policy ? new Date(now.getTime() + policy.graceDays * 86400000) : null;
            const notBefore = policy
                ? new Date(now.getTime() + Math.max(policy.graceDays, policy.accountDataDays) * 86400000)
                : null;
            await sql`insert into meal.legal_requests(id,kind,status,scope_snapshot,retention_basis,user_id,idempotency_key,requested_at,cancel_until,finalization_not_before,policy_version,blocker_snapshot)
              values(${id}::uuid,'account_deletion',${policy ? 'retention_wait' : 'blocked'},${JSON.stringify({ requesterId: userId })}::jsonb,${JSON.stringify(policy ?? { configured: false })}::jsonb,${userId}::uuid,${idempotencyKey}::uuid,${now},${cancelUntil},${notBefore},${policy?.version ?? null},${JSON.stringify(blockers)}::jsonb)`.execute(
                tx,
            );
            await this.auth.audit(tx, userId, 'account.deletion.requested', id, requestId);
            return this.projection((await this.current(userId, tx, true))!);
        });
    }
    async cancelDeletion(userId: string, sessionId: string, token: string, expectedVersion: number, requestId: string) {
        return this.database.transaction(async (tx) => {
            await this.reauth.consume(tx, userId, sessionId, token, 'account_lifecycle');
            const row = await this.current(userId, tx, true);
            if (!row) throw new NotFoundException();
            if (!['requested', 'retention_wait', 'ready', 'blocked'].includes(row.status))
                throw new ConflictException('Запрос уже нельзя отменить');
            if (Number(row.version) !== expectedVersion) throw new HttpException('Запрос изменился', 412);
            await sql`update meal.legal_requests set status='cancelled',cancelled_at=now(),version=version+1 where id=${row.id}::uuid`.execute(
                tx,
            );
            await this.auth.audit(tx, userId, 'account.deletion.cancelled', row.id, requestId);
            return this.projection((await this.current(userId, tx, true))!);
        });
    }
    async finalizeDeletion(
        userId: string,
        sessionId: string,
        token: string,
        expectedVersion: number,
        requestId: string,
    ) {
        return this.database.transaction(async (tx) => {
            await this.reauth.consume(tx, userId, sessionId, token, 'account_lifecycle');
            return this.finalize(tx, userId, expectedVersion, requestId);
        });
    }
    async reviewDeletion(
        actor: Principal,
        id: string,
        input: {
            decision: 'approve' | 'reject';
            expectedVersion: number;
            reason: string;
            idempotencyKey: string;
        },
        requestId: string,
    ) {
        const operation = 'admin.account-deletion.review';
        const namespace = `admin:${actor.id}`;
        const requestHash = createHash('sha256')
            .update(
                JSON.stringify({
                    decision: input.decision,
                    expectedVersion: input.expectedVersion,
                    reason: input.reason,
                }),
            )
            .digest('hex');
        return this.database.transaction(async (tx) => {
            await this.adminAccess.assertAdminRole(tx, actor);
            await this.adminAccess.assertCritical(tx, actor);
            await sql`select pg_advisory_xact_lock(hashtextextended(${`${namespace}:${operation}:${id}:${input.idempotencyKey}`},0))`.execute(
                tx,
            );
            const replay = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', namespace)
                .where('operation', '=', operation)
                .where('target_binding', '=', id)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (replay) {
                if (replay.request_hash !== requestHash)
                    throw new ConflictException('Ключ идемпотентности уже использован для другого запроса');
                return deletionRequestSchema.parse(replay.response_snapshot);
            }
            const row = await this.deletionById(id, tx, true);
            if (!row) throw new NotFoundException();
            if (Number(row.version) !== input.expectedVersion) throw new HttpException('Запрос изменился', 412);
            if (!['requested', 'retention_wait', 'blocked'].includes(row.status))
                throw new ConflictException('Запрос уже рассмотрен');
            if (input.decision === 'reject')
                await sql`update meal.legal_requests set status='rejected',handled_by=${actor.id}::uuid,version=version+1 where id=${id}::uuid`.execute(
                    tx,
                );
            else {
                const policy = await this.policy(tx);
                if (!policy) throw new ConflictException('Сначала опубликуйте политику хранения');
                const exportJob = await sql<{ id: string }>`select id from meal.export_jobs
                    where user_id=${row.user_id}::uuid and kind='personal_data' and format='json'
                      and status='ready' and file_id is not null and expires_at>now()
                    order by requested_at desc,id desc limit 1`.execute(tx);
                const cancelUntil = new Date(row.requested_at.getTime() + policy.graceDays * 86400000),
                    notBefore = new Date(
                        row.requested_at.getTime() + Math.max(policy.graceDays, policy.accountDataDays) * 86400000,
                    );
                await sql`update meal.legal_requests set status=case when ${notBefore}<=now() then 'ready' else 'retention_wait' end,approved_at=now(),handled_by=${actor.id}::uuid,finalization_not_before=${notBefore},cancel_until=${cancelUntil},policy_version=${policy.version},retention_basis=${JSON.stringify(policy)}::jsonb,export_id=${exportJob.rows[0]?.id ?? null}::uuid,version=version+1 where id=${id}::uuid`.execute(
                    tx,
                );
            }
            await sql`insert into meal.legal_request_steps(id,kind,status,evidence,completed_at,request_id,approved_by) values(${randomUUID()}::uuid,'admin_review',${input.decision},${JSON.stringify({ reason: input.reason })}::jsonb,now(),${id}::uuid,${actor.id}::uuid)`.execute(
                tx,
            );
            await this.auth.audit(
                tx,
                actor.id,
                input.decision === 'approve' ? 'account.deletion.approved' : 'account.deletion.rejected',
                id,
                requestId,
            );
            const updated = await this.deletionById(id, tx, true);
            const result = this.projection(updated!);
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation,
                    target_binding: id,
                    key: input.idempotencyKey,
                    request_hash: requestHash,
                    status: 'completed',
                    response_snapshot: result,
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: actor.id,
                    scope_id: null,
                    actor_namespace: namespace,
                })
                .execute();
            return result;
        });
    }
    private async finalize(
        tx: Transaction<DatabaseSchema>,
        userId: string,
        expectedVersion: number | null,
        requestId: string,
    ) {
        const row = await this.current(userId, tx, true);
        if (!row) throw new NotFoundException();
        if (expectedVersion !== null && Number(row.version) !== expectedVersion)
            throw new HttpException('Запрос изменился', 412);
        if (!['retention_wait', 'ready', 'blocked'].includes(row.status))
            throw new ConflictException('Запрос нельзя финализировать');
        const { policy, blockers } = await this.blockers(userId, tx, row.id);
        if (
            !policy ||
            row.policy_version !== policy.version ||
            !row.approved_at ||
            !row.finalization_not_before ||
            row.finalization_not_before > new Date() ||
            blockers.some((b) => b.blocksFinalization)
        ) {
            const all = [...blockers];
            if (policy && row.policy_version !== policy.version)
                all.push({
                    code: 'retention_policy_changed',
                    message: 'Политика хранения изменилась; требуется повторное административное подтверждение.',
                    blocksFinalization: true,
                });
            if (!row.approved_at)
                all.push({
                    code: 'admin_approval_required',
                    message: 'Требуется отдельное административное подтверждение.',
                    blocksFinalization: true,
                });
            if (row.finalization_not_before && row.finalization_not_before > new Date())
                all.push({
                    code: 'retention_wait',
                    message: 'Защитный срок отмены ещё не завершён.',
                    blocksFinalization: true,
                });
            await sql`update meal.legal_requests set status='blocked',blocker_snapshot=${JSON.stringify(all)}::jsonb,version=version+1 where id=${row.id}::uuid`.execute(
                tx,
            );
            await this.auth.audit(tx, userId, 'account.deletion.blocked', row.id, requestId);
            return this.projection((await this.current(userId, tx, true))!);
        }
        const alias = `deleted-${userId}`;
        const disabledPasswordHash = await hashPassword(newToken());
        await sql`update meal.users set login=${alias},display_name='Удалённый пользователь',email_normalized=${alias + '@deleted.invalid'},status='deleted',archived_at=coalesce(archived_at,now()),version=version+1 where id=${userId}::uuid`.execute(
            tx,
        );
        await sql`update meal.password_credentials set password_hash=${disabledPasswordHash},changed_at=now(),version=version+1 where user_id=${userId}::uuid`.execute(
            tx,
        );
        await sql`update meal.sessions set revoked_at=coalesce(revoked_at,now()),version=version+1 where user_id=${userId}::uuid and revoked_at is null`.execute(
            tx,
        );
        await sql`update meal.account_tokens set revoked_at=coalesce(revoked_at,now()) where user_id=${userId}::uuid and used_at is null`.execute(
            tx,
        );
        await sql`update meal.account_email_changes set cancelled_at=coalesce(cancelled_at,now()) where user_id=${userId}::uuid and applied_at is null`.execute(
            tx,
        );
        await sql`update meal.account_devices set revoked_at=coalesce(revoked_at,now()) where user_id=${userId}::uuid and revoked_at is null`.execute(
            tx,
        );
        await sql`update meal.mfa_recovery_codes set used_at=coalesce(used_at,now()),version=version+1 where factor_id in(select id from meal.mfa_factors where user_id=${userId}::uuid) and used_at is null`.execute(
            tx,
        );
        await sql`update meal.mfa_factors set revoked_at=coalesce(revoked_at,now()),version=version+1 where user_id=${userId}::uuid and revoked_at is null`.execute(
            tx,
        );
        await sql`update meal.user_critical_grants set used_at=coalesce(used_at,now()),version=version+1 where user_id=${userId}::uuid and used_at is null`.execute(
            tx,
        );
        await sql`update meal.staff_role_assignments set revoked_at=coalesce(revoked_at,now()),version=version+1 where user_id=${userId}::uuid and revoked_at is null`.execute(
            tx,
        );
        await sql`update meal.staff_grants set revoked_at=coalesce(revoked_at,now()) where user_id=${userId}::uuid and revoked_at is null`.execute(
            tx,
        );
        await sql`update meal.legal_requests set status='finalized',executed_at=now(),blocker_snapshot=${JSON.stringify(blockers)}::jsonb,version=version+1 where id=${row.id}::uuid`.execute(
            tx,
        );
        await this.auth.audit(tx, userId, 'account.deletion.finalized', row.id, requestId);
        return this.projection((await this.current(userId, tx, true))!);
    }
    async runRetentionBatch(limit = 25) {
        const db = await this.db();
        const rows = await sql<{
            user_id: string;
        }>`select user_id from meal.legal_requests where kind='account_deletion' and status in('retention_wait','ready') and finalization_not_before<=now() order by finalization_not_before,id limit ${limit}`.execute(
            db,
        );
        let finalized = 0,
            blocked = 0;
        for (const row of rows.rows) {
            try {
                const result = await this.database.transaction((tx) =>
                    this.finalize(tx, row.user_id, null, randomUUID()),
                );
                if (result.status === 'finalized') finalized++;
                else blocked++;
            } catch {
                blocked++;
            }
        }
        return retentionRunResultSchema.parse({ inspected: rows.rows.length, finalized, blocked });
    }
}
