import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { AdminAccessService } from '../admin-auth/admin-access.service.js';
import type { Principal } from '../auth/auth.service.js';
import {
    governanceCommandSchema,
    governanceParamsSchema,
    governanceResultSchema,
    governanceViewSchema,
} from './admin-governance.contracts.js';

type Params = ReturnType<typeof governanceParamsSchema.parse>;
type Tx = Transaction<DatabaseSchema>;

@Injectable()
export class AdminGovernanceService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: AdminAccessService,
    ) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    private async applyScheduledFamilyPlusTransfer(
        tx: Tx,
        effect: { id: string; sanctionId: string; userId: string; recipientId: string | null },
    ): Promise<'applied' | 'failed' | 'skipped'> {
        const plusContext = (
            await sql<{
                subscriptionId: string;
                familyId: string;
            }>`select s.id as "subscriptionId",f.id as "familyId" from meal.subscriptions s join meal.billing_products p on p.id=s.product_id and p.code='plus' join meal.family_coverages c on c.subscription_id=s.id and c.selected_at is not null and c.starts_at<=now() and (c.ends_at is null or c.ends_at>now()) join meal.families f on f.id=c.family_id and f.status='active' and f.archived_at is null join meal.family_memberships owner on owner.id=f.owner_membership_id and owner.user_id=${effect.userId}::uuid and owner.left_at is null where s.owner_id=${effect.userId}::uuid and s.status='active' for update of s,f,c limit 1`.execute(
                tx,
            )
        ).rows[0];
        if (!plusContext) {
            await tx
                .updateTable('scheduled_sanction_effects')
                .set({
                    status: 'skipped',
                    failure_reason: 'Active family Plus subscription not found',
                    applied_at: new Date(),
                    version: sql`version+1`,
                })
                .where('id', '=', effect.id)
                .execute();
            return 'skipped';
        }
        const recipient = effect.recipientId
            ? (
                  await sql<{
                      id: string;
                  }>`select u.id from meal.family_memberships m join meal.users u on u.id=m.user_id where m.family_id=${plusContext.familyId}::uuid and m.user_id=${effect.recipientId}::uuid and m.left_at is null and u.status='active' and u.archived_at is null and not exists(select 1 from meal.sanctions x where x.user_id=u.id and x.scope='account' and x.revoked_at is null and x.starts_at<=now() and (x.ends_at is null or x.ends_at>now())) limit 1`.execute(
                      tx,
                  )
              ).rows[0]
            : undefined;
        if (!recipient) {
            await tx
                .updateTable('scheduled_sanction_effects')
                .set({
                    status: 'failed',
                    failure_reason: 'Subscription recipient is unavailable',
                    applied_at: new Date(),
                    version: sql`version+1`,
                })
                .where('id', '=', effect.id)
                .execute();
            return 'failed';
        }
        await tx
            .updateTable('subscriptions')
            .set({ owner_id: recipient.id, auto_renew: false, version: sql`version+1` })
            .where('id', '=', plusContext.subscriptionId)
            .where('owner_id', '=', effect.userId)
            .executeTakeFirstOrThrow();
        const familyMembers = await tx
            .selectFrom('family_memberships')
            .select('user_id as userId')
            .where('family_id', '=', plusContext.familyId)
            .where('left_at', 'is', null)
            .execute();
        for (const member of familyMembers)
            await tx
                .insertInto('notifications')
                .values({
                    id: randomUUID(),
                    category: 'family',
                    priority: 'important',
                    payload_minimized: {
                        type: 'family-subscription-owner-banned',
                        familyId: plusContext.familyId,
                        transferred: true,
                    },
                    dedup_key: `family-ban:${effect.sanctionId}:${member.userId}`,
                    available_at: new Date(),
                    read_at: null,
                    fullscreen_seen_at: null,
                    user_id: member.userId,
                    ownership_transfer_id: null,
                    announcement_id: null,
                })
                .execute();
        await tx
            .updateTable('scheduled_sanction_effects')
            .set({
                status: 'applied',
                failure_reason: null,
                applied_at: new Date(),
                version: sql`version+1`,
            })
            .where('id', '=', effect.id)
            .execute();
        return 'applied';
    }

    async activateScheduledSanctionEffects(limit = 50) {
        const db = await this.db();
        const due = await sql<{
            id: string;
        }>`select e.id from meal.scheduled_sanction_effects e join meal.sanctions s on s.id=e.sanction_id where e.status='scheduled' and s.scope='account' and s.starts_at<=now() order by s.starts_at,e.created_at,e.id limit ${limit}`.execute(
            db,
        );
        const result = { selected: due.rows.length, applied: 0, failed: 0, skipped: 0 };
        for (const candidate of due.rows) {
            const outcome = await this.database.transaction(async (tx) => {
                const claimed = (
                    await sql<{
                        id: string;
                        sanctionId: string;
                        userId: string;
                        recipientId: string | null;
                        active: boolean;
                    }>`select e.id,e.sanction_id as "sanctionId",s.user_id as "userId",e.recipient_user_id as "recipientId",(s.revoked_at is null and (s.ends_at is null or s.ends_at>now())) as "active" from meal.scheduled_sanction_effects e join meal.sanctions s on s.id=e.sanction_id where e.id=${candidate.id}::uuid and e.status='scheduled' and s.scope='account' and s.starts_at<=now() for update of e,s skip locked`.execute(
                        tx,
                    )
                ).rows[0];
                if (!claimed) return null;
                if (!claimed.active) {
                    await tx
                        .updateTable('scheduled_sanction_effects')
                        .set({
                            status: 'skipped',
                            failure_reason: 'Sanction inactive at activation',
                            applied_at: new Date(),
                            version: sql`version+1`,
                        })
                        .where('id', '=', claimed.id)
                        .execute();
                    return 'skipped' as const;
                }
                return this.applyScheduledFamilyPlusTransfer(tx, claimed);
            });
            if (outcome) result[outcome]++;
        }
        return result;
    }

    async view(raw: unknown) {
        const params = governanceParamsSchema.parse(raw);
        return this.load(await this.db(), params);
    }

    private async load(db: NonNullable<DatabaseService['db']>, params: Params) {
        let userId = params.id;
        let targetVersion = '1';
        let scope: string | null = null;
        let endsAt: Date | null = null;
        let sanctionStatus: string | null = null;
        if (params.section === 'sanctions') {
            const sanction = await db
                .selectFrom('sanctions')
                .select(['user_id', 'version', 'scope', 'starts_at', 'ends_at', 'revoked_at'])
                .where('id', '=', params.id)
                .executeTakeFirst();
            if (!sanction) throw new NotFoundException();
            userId = sanction.user_id;
            targetVersion = String(sanction.version);
            scope = sanction.scope;
            endsAt = sanction.ends_at ? new Date(sanction.ends_at) : null;
            sanctionStatus = sanction.revoked_at
                ? 'revoked'
                : new Date(sanction.starts_at) > new Date()
                  ? 'scheduled'
                  : endsAt && endsAt <= new Date()
                    ? 'expired'
                    : 'active';
        } else if (params.section === 'access') {
            const role = await db
                .selectFrom('staff_role_assignments')
                .select(['user_id', 'version'])
                .where('id', '=', params.id)
                .executeTakeFirst();
            if (!role) throw new NotFoundException();
            userId = role.user_id;
            targetVersion = String(role.version);
        }
        const user = await db
            .selectFrom('users')
            .select(['id', 'display_name', 'status', 'version'])
            .where('id', '=', userId)
            .executeTakeFirst();
        if (!user) throw new NotFoundException();
        if (params.section === 'users') targetVersion = String(user.version);
        const roles = await db
            .selectFrom('staff_role_assignments')
            .select(['id', 'role', 'revoked_at'])
            .where('user_id', '=', userId)
            .orderBy('created_at', 'desc')
            .execute();
        const activeRole = roles.find((row) => !row.revoked_at);
        const adminCount = await db
            .selectFrom('staff_role_assignments')
            .select((eb) => eb.fn.countAll<string>().as('total'))
            .where('role', '=', 'admin')
            .where('revoked_at', 'is', null)
            .executeTakeFirstOrThrow();
        const plusCoverage = (
            await sql<{
                subscriptionId: string;
                familyId: string;
                familyName: string;
            }>`select s.id as "subscriptionId",f.id as "familyId",f.name as "familyName" from meal.subscriptions s join meal.billing_products p on p.id=s.product_id and p.code='plus' join meal.family_coverages c on c.subscription_id=s.id and c.selected_at is not null and c.starts_at<=now() and (c.ends_at is null or c.ends_at>now()) join meal.families f on f.id=c.family_id and f.status='active' and f.archived_at is null join meal.family_memberships owner on owner.id=f.owner_membership_id and owner.user_id=${userId}::uuid and owner.left_at is null where s.owner_id=${userId}::uuid and s.status='active' limit 1`.execute(
                db,
            )
        ).rows[0];
        const transferCandidates = plusCoverage
            ? (
                  await sql<{
                      userId: string;
                      displayName: string;
                      login: string;
                  }>`select u.id as "userId",u.display_name as "displayName",u.login from meal.family_memberships m join meal.users u on u.id=m.user_id where m.family_id=${plusCoverage.familyId}::uuid and m.left_at is null and u.id<>${userId}::uuid and u.status='active' and u.archived_at is null order by m.joined_at,m.stable_order,m.id`.execute(
                      db,
                  )
              ).rows
            : [];
        const [appeals, history] = await Promise.all([
            params.section === 'sanctions'
                ? db
                      .selectFrom('appeals')
                      .select(['id', 'version', 'body', 'status', 'decision', 'submitted_at', 'resolved_at'])
                      .where('sanction_id', '=', params.id)
                      .orderBy('submitted_at', 'desc')
                      .limit(100)
                      .execute()
                : Promise.resolve([]),
            db
                .selectFrom('audit_events')
                .select(['action', 'reason', 'recorded_at'])
                .where('target_id', 'in', [params.id, userId])
                .where('action', 'like', 'admin.governance.%')
                .orderBy('recorded_at', 'desc')
                .limit(100)
                .execute(),
        ]);
        return governanceViewSchema.parse({
            id: params.id,
            version: targetVersion,
            userId,
            name: user.display_name,
            role: activeRole?.role ?? null,
            soleAdmin: activeRole?.role === 'admin' && Number(adminCount.total) === 1,
            scope,
            endsAt: endsAt?.toISOString() ?? null,
            status: sanctionStatus ?? user.status,
            appeals: appeals.map((appeal) => {
                const decision = appeal.decision as Record<string, unknown> | null;
                return {
                    id: appeal.id,
                    version: String(appeal.version),
                    body: appeal.body,
                    status: appeal.status,
                    response: typeof decision?.response === 'string' ? decision.response : null,
                    submittedAt: new Date(appeal.submitted_at).toISOString(),
                    resolvedAt: appeal.resolved_at ? new Date(appeal.resolved_at).toISOString() : null,
                };
            }),
            history: history.map((row) => ({
                action: row.action,
                reason: row.reason ?? '',
                at: new Date(row.recorded_at).toISOString(),
            })),
            familySubscription: plusCoverage ? { ...plusCoverage, candidates: transferCandidates } : null,
        });
    }

    command(rawParams: unknown, raw: unknown, actor: Principal, requestId: string) {
        const params = governanceParamsSchema.parse(rawParams);
        const input = governanceCommandSchema.parse(raw);
        const hash = createHash('sha256')
            .update(JSON.stringify([params, input]))
            .digest('hex');
        return this.database.transaction(async (tx) => {
            await this.access.assertCritical(tx, actor);
            const namespace = `admin:${actor.id}`;
            const replay = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', namespace)
                .where('operation', '=', 'admin.governance.command')
                .where('target_binding', '=', params.id)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (replay) {
                if (replay.request_hash !== hash) throw new ConflictException('Idempotency key already used');
                return governanceResultSchema.parse(replay.response_snapshot);
            }
            let userId = params.id;
            let currentVersion: string;
            if (params.section === 'users') {
                const user = await tx
                    .selectFrom('users')
                    .select(['id', 'version'])
                    .where('id', '=', params.id)
                    .forUpdate()
                    .executeTakeFirst();
                if (!user) throw new NotFoundException();
                currentVersion = String(user.version);
            } else if (params.section === 'sanctions') {
                const sanction = await tx
                    .selectFrom('sanctions')
                    .select(['user_id', 'version'])
                    .where('id', '=', params.id)
                    .forUpdate()
                    .executeTakeFirst();
                if (!sanction) throw new NotFoundException();
                userId = sanction.user_id;
                currentVersion = String(sanction.version);
            } else {
                const role = await tx
                    .selectFrom('staff_role_assignments')
                    .select(['user_id', 'version'])
                    .where('id', '=', params.id)
                    .forUpdate()
                    .executeTakeFirst();
                if (!role) throw new NotFoundException();
                userId = role.user_id;
                currentVersion = String(role.version);
            }
            if (currentVersion !== input.version) throw new ConflictException('Target changed');
            const targetUser = await tx
                .selectFrom('users')
                .select(['id'])
                .where('id', '=', userId)
                .forUpdate()
                .executeTakeFirst();
            if (!targetUser) throw new NotFoundException();
            const soleAdmin = await sql<{ sole: boolean }>`select exists(
                select 1 from meal.staff_role_assignments r where r.user_id=${userId}::uuid and r.role='admin' and r.revoked_at is null
            ) and (select count(*) from meal.staff_role_assignments where role='admin' and revoked_at is null)=1 as sole`.execute(
                tx,
            );
            if (soleAdmin.rows[0]?.sole && ['ban', 'revokeRole'].includes(input.action))
                throw new ConflictException('Sole administrator is protected');
            let resultId = params.id;
            let resultVersion = String(Number(currentVersion) + 1);
            if (input.action === 'ban') {
                if (params.section !== 'users' || !input.category) throw new ConflictException('Category required');
                const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
                const endsAt = input.endsAt ? new Date(input.endsAt) : null;
                if (endsAt && endsAt <= startsAt) throw new ConflictException('Invalid interval');
                resultId = randomUUID();
                resultVersion = '1';
                await tx
                    .insertInto('sanctions')
                    .values({
                        id: resultId,
                        scope: input.scope,
                        starts_at: startsAt,
                        ends_at: endsAt,
                        reason: input.reason,
                        revoked_at: null,
                        rule_version: 'admin-v1',
                        user_id: userId,
                        issued_by: actor.id,
                        case_id: null,
                        safety_event_id: null,
                        approved_by: actor.id,
                        category: input.category,
                        private_note: input.privateNote || null,
                    })
                    .execute();
                if (input.scope === 'account' && startsAt <= new Date()) {
                    const plusContext = (
                        await sql<{
                            subscriptionId: string;
                            familyId: string;
                        }>`select s.id as "subscriptionId",f.id as "familyId" from meal.subscriptions s join meal.billing_products p on p.id=s.product_id and p.code='plus' join meal.family_coverages c on c.subscription_id=s.id and c.selected_at is not null and c.starts_at<=now() and (c.ends_at is null or c.ends_at>now()) join meal.families f on f.id=c.family_id and f.status='active' and f.archived_at is null join meal.family_memberships owner on owner.id=f.owner_membership_id and owner.user_id=${userId}::uuid and owner.left_at is null where s.owner_id=${userId}::uuid and s.status='active' for update of s,f,c limit 1`.execute(
                            tx,
                        )
                    ).rows[0];
                    if (input.subscriptionDisposition === 'transfer') {
                        if (!plusContext || !input.subscriptionRecipientUserId)
                            throw new ConflictException('Active family Plus subscription not found');
                        const recipient = (
                            await sql<{
                                id: string;
                            }>`select u.id from meal.family_memberships m join meal.users u on u.id=m.user_id where m.family_id=${plusContext.familyId}::uuid and m.user_id=${input.subscriptionRecipientUserId}::uuid and m.left_at is null and u.status='active' and u.archived_at is null and not exists(select 1 from meal.sanctions x where x.user_id=u.id and x.scope='account' and x.revoked_at is null and x.starts_at<=now() and (x.ends_at is null or x.ends_at>now())) limit 1`.execute(
                                tx,
                            )
                        ).rows[0];
                        if (!recipient) throw new ConflictException('Subscription recipient is unavailable');
                        await tx
                            .updateTable('subscriptions')
                            .set({ owner_id: recipient.id, auto_renew: false, version: sql`version+1` })
                            .where('id', '=', plusContext.subscriptionId)
                            .where('owner_id', '=', userId)
                            .executeTakeFirstOrThrow();
                    } else if (plusContext) {
                        await tx
                            .updateTable('subscriptions')
                            .set({ auto_renew: false, version: sql`version+1` })
                            .where('id', '=', plusContext.subscriptionId)
                            .execute();
                    }
                    if (plusContext) {
                        const familyMembers = await tx
                            .selectFrom('family_memberships')
                            .select('user_id as userId')
                            .where('family_id', '=', plusContext.familyId)
                            .where('left_at', 'is', null)
                            .execute();
                        for (const member of familyMembers)
                            await tx
                                .insertInto('notifications')
                                .values({
                                    id: randomUUID(),
                                    category: 'family',
                                    priority: 'important',
                                    payload_minimized: {
                                        type: 'family-subscription-owner-banned',
                                        familyId: plusContext.familyId,
                                        transferred: input.subscriptionDisposition === 'transfer',
                                    },
                                    dedup_key: `family-ban:${resultId}:${member.userId}`,
                                    available_at: new Date(),
                                    read_at: null,
                                    fullscreen_seen_at: null,
                                    user_id: member.userId,
                                    ownership_transfer_id: null,
                                    announcement_id: null,
                                })
                                .execute();
                    }
                } else if (input.subscriptionDisposition === 'transfer') {
                    await tx
                        .insertInto('scheduled_sanction_effects')
                        .values({
                            id: randomUUID(),
                            sanction_id: resultId,
                            kind: 'family_plus_transfer',
                            recipient_user_id: input.subscriptionRecipientUserId,
                            status: 'scheduled',
                            failure_reason: null,
                            applied_at: null,
                        })
                        .execute();
                }
            } else if (input.action === 'revoke' || input.action === 'extend') {
                if (params.section !== 'sanctions') throw new ConflictException();
                const row = await tx
                    .selectFrom('sanctions')
                    .select(['revoked_at', 'ends_at'])
                    .where('id', '=', params.id)
                    .executeTakeFirstOrThrow();
                if (row.revoked_at) throw new ConflictException('Already revoked');
                if (input.action === 'extend') {
                    if (!row.ends_at || !input.endsAt || new Date(input.endsAt) <= new Date(row.ends_at))
                        throw new ConflictException('Extension must increase end date');
                    await tx
                        .updateTable('sanctions')
                        .set({ ends_at: new Date(input.endsAt), version: Number(currentVersion) + 1 })
                        .where('id', '=', params.id)
                        .execute();
                } else
                    await tx
                        .updateTable('sanctions')
                        .set({ revoked_at: new Date(), version: Number(currentVersion) + 1 })
                        .where('id', '=', params.id)
                        .execute();
            } else if (input.action === 'acceptAppeal' || input.action === 'rejectAppeal') {
                if (params.section !== 'sanctions' || !input.appealId || !input.appealVersion)
                    throw new ConflictException();
                const appeal = await tx
                    .selectFrom('appeals')
                    .select(['id', 'version', 'status'])
                    .where('id', '=', input.appealId)
                    .where('sanction_id', '=', params.id)
                    .forUpdate()
                    .executeTakeFirst();
                if (!appeal) throw new NotFoundException();
                if (String(appeal.version) !== input.appealVersion || appeal.status !== 'pending')
                    throw new ConflictException('Appeal changed');
                await tx
                    .updateTable('appeals')
                    .set({
                        status: input.action === 'acceptAppeal' ? 'accepted' : 'rejected',
                        resolved_at: new Date(),
                        decision: { response: input.reason, actorId: actor.id },
                        version: Number(appeal.version) + 1,
                    })
                    .where('id', '=', appeal.id)
                    .execute();
                if (input.action === 'acceptAppeal')
                    await tx
                        .updateTable('sanctions')
                        .set({ revoked_at: new Date(), version: Number(currentVersion) + 1 })
                        .where('id', '=', params.id)
                        .execute();
            } else if (input.action === 'grantModerator') {
                if (params.section !== 'users') throw new ConflictException();
                const active = await tx
                    .selectFrom('staff_role_assignments')
                    .select('id')
                    .where('user_id', '=', userId)
                    .where('revoked_at', 'is', null)
                    .executeTakeFirst();
                if (active) throw new ConflictException('Active role already exists');
                resultId = randomUUID();
                resultVersion = '1';
                await tx
                    .insertInto('staff_role_assignments')
                    .values({
                        id: resultId,
                        role: 'moderator',
                        assigned_at: new Date(),
                        revoked_at: null,
                        user_id: userId,
                        assigned_by: actor.id,
                    })
                    .execute();
                for (const permission of [
                    'catalog.review',
                    'catalog.publish',
                    'support.reply',
                    ...(input.allowTemporaryBan ? ['sanctions.temporary'] : []),
                ])
                    await tx
                        .insertInto('staff_grants')
                        .values({
                            id: randomUUID(),
                            permission,
                            scope: 'global',
                            valid_until: null,
                            revoked_at: null,
                            user_id: userId,
                            granted_by: actor.id,
                        })
                        .execute();
            } else {
                if (params.section !== 'access') throw new ConflictException();
                await tx
                    .updateTable('staff_role_assignments')
                    .set({ revoked_at: new Date(), version: Number(currentVersion) + 1 })
                    .where('id', '=', params.id)
                    .execute();
                await tx
                    .updateTable('staff_grants')
                    .set({ revoked_at: new Date() })
                    .where('user_id', '=', userId)
                    .where('revoked_at', 'is', null)
                    .execute();
                await tx
                    .updateTable('sessions')
                    .set({ revoked_at: new Date() })
                    .where('user_id', '=', userId)
                    .where('kind', '=', 'staff')
                    .where('revoked_at', 'is', null)
                    .execute();
            }
            const result = governanceResultSchema.parse({ id: resultId, version: resultVersion });
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'admin.governance.command',
                    target_binding: params.id,
                    key: input.idempotencyKey,
                    request_hash: hash,
                    status: 'completed',
                    response_snapshot: result,
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: actor.id,
                    scope_id: null,
                    actor_namespace: namespace,
                })
                .execute();
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: `admin.governance.${input.action}`,
                    target_type: params.section,
                    target_id: resultId,
                    actor_id: actor.id,
                    scope_id: null,
                    effective_at: new Date(),
                    recorded_at: new Date(),
                    request_id: requestId,
                    reason: input.reason,
                    before_redacted: { version: currentVersion },
                    after_redacted: { version: resultVersion },
                })
                .execute();
            return result;
        });
    }
}
