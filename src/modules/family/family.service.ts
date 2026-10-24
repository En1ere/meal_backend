import {
    ConflictException,
    ForbiddenException,
    HttpException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { Principal } from '../auth/auth.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import {
    familyContextSchema,
    familyCreateSchema,
    familyAiQuotaRedistributionSchema,
    familyLeavePreviewSchema,
    familyLeaveSchema,
    familyLifecycleResultSchema,
    familyMemberRemoveSchema,
    familyInvitationAcceptSchema,
    familyInvitationCreateSchema,
    familyInvitationDecisionSchema,
    familyInvitationListSchema,
    familyInvitationPreviewSchema,
    familyInvitationResultSchema,
    ownershipNoticeDismissResultSchema,
    ownershipNoticeDismissSchema,
    ownershipNoticeSchema,
    ownershipWorkspaceSchema,
    ownershipPreviewInputSchema,
    ownershipRequestCreateSchema,
    ownershipRequestDecisionSchema,
    ownershipRequestDetailSchema,
    ownershipRequestResultSchema,
    ownershipTransferPreviewSchema,
    ownershipTransferRequestSchema,
    type FamilyContext,
    type FamilyMember,
} from './family.contracts.js';

type Tx = Transaction<DatabaseSchema>;

export const selectFamilySuccessor = <T extends { id: string; joinedAt: string | Date; stableOrder: number | string }>(
    members: T[],
) =>
    members.toSorted(
        (left, right) =>
            new Date(left.joinedAt).getTime() - new Date(right.joinedAt).getTime() ||
            Number(left.stableOrder) - Number(right.stableOrder) ||
            left.id.localeCompare(right.id),
    )[0] ?? null;

@Injectable()
export class FamilyService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
    ) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    private async assertActor(tx: Tx, actor: Principal) {
        const session = await tx
            .selectFrom('sessions')
            .innerJoin('users', 'users.id', 'sessions.user_id')
            .select('sessions.id')
            .where('sessions.id', '=', actor.sessionId)
            .where('sessions.user_id', '=', actor.id)
            .where('sessions.auth_context', '=', 'user')
            .where('sessions.revoked_at', 'is', null)
            .where('sessions.expires_at', '>', new Date())
            .where('users.status', '=', 'active')
            .where('users.archived_at', 'is', null)
            .executeTakeFirst();
        if (!session || actor.context !== 'user') throw new UnauthorizedException();
        const sanction = await tx
            .selectFrom('sanctions')
            .select('id')
            .where('user_id', '=', actor.id)
            .where('scope', '=', 'account')
            .where('revoked_at', 'is', null)
            .where('starts_at', '<=', new Date())
            .where((expression) =>
                expression.or([expression('ends_at', 'is', null), expression('ends_at', '>', new Date())]),
            )
            .executeTakeFirst();
        if (sanction) throw new ForbiddenException('Доступен только просмотр');
    }

    private async aiQuotaRedistribution(
        tx: Tx,
        familyId: string,
        beforeUserIds: string[],
        afterUserIds: string[],
        currentUserId: string,
        applyKey?: string,
    ) {
        const period = await tx
            .selectFrom('ai_quota_periods as quota')
            .innerJoin('family_coverages as coverage', 'coverage.id', 'quota.family_coverage_id')
            .select(['quota.id', 'quota.ends_at as endsAt'])
            .where('coverage.family_id', '=', familyId)
            .where('coverage.selected_at', 'is not', null)
            .where('coverage.starts_at', '<=', new Date())
            .where((expression) =>
                expression.or([
                    expression('coverage.ends_at', 'is', null),
                    expression('coverage.ends_at', '>', new Date()),
                ]),
            )
            .where('quota.ends_at', '>', new Date())
            .orderBy('quota.starts_at', 'desc')
            .$if(!!applyKey, (query) => query.forUpdate('quota'))
            .executeTakeFirst();
        if (!period)
            return familyAiQuotaRedistributionSchema.parse({
                applies: false,
                periodEndsAt: null,
                unspentActions: 0,
                memberCountBefore: beforeUserIds.length,
                memberCountAfter: afterUserIds.length,
                shareAfter: 0,
                familyReserveAfter: 0,
                currentUserBefore: 0,
                currentUserAfter: 0,
            });
        const buckets = await tx
            .selectFrom('ai_buckets')
            .select([
                'id',
                'user_id as userId',
                'family_id as familyId',
                'kind',
                'granted',
                'balance_projection as balance',
                'reserved_projection as reserved',
            ])
            .where('quota_period_id', '=', period.id)
            .where('kind', 'in', ['subscription', 'family_reserve'])
            .$if(!!applyKey, (query) => query.forUpdate())
            .execute();
        const available = (bucket: (typeof buckets)[number]) =>
            Math.max(0, Number(bucket.balance) - Number(bucket.reserved));
        const unspentActions = buckets.reduce((sum, bucket) => sum + available(bucket), 0);
        const shareAfter = afterUserIds.length ? Math.floor(unspentActions / afterUserIds.length) : 0;
        const familyReserveAfter = unspentActions - shareAfter * afterUserIds.length;
        const currentUserBefore = buckets
            .filter((bucket) => bucket.kind === 'subscription' && bucket.userId === currentUserId)
            .reduce((sum, bucket) => sum + available(bucket), 0);
        if (applyKey) {
            const after = new Set(afterUserIds);
            const subscriptionByUser = new Map(
                buckets
                    .filter((bucket) => bucket.kind === 'subscription' && bucket.userId)
                    .map((bucket) => [bucket.userId!, bucket]),
            );
            const reserveBucket = buckets.find((bucket) => bucket.kind === 'family_reserve');
            const targetUsers = new Set([...subscriptionByUser.keys(), ...afterUserIds]);
            for (const userId of targetUsers) {
                const bucket = subscriptionByUser.get(userId);
                const targetAvailable = after.has(userId) ? shareAfter : 0;
                if (!bucket) {
                    if (!targetAvailable) continue;
                    const bucketId = randomUUID();
                    await tx
                        .insertInto('ai_buckets')
                        .values({
                            id: bucketId,
                            kind: 'subscription',
                            granted: targetAvailable,
                            expires_at: new Date(period.endsAt),
                            balance_projection: targetAvailable,
                            reserved_projection: 0,
                            user_id: userId,
                            family_id: null,
                            quota_period_id: period.id,
                            order_id: null,
                        })
                        .execute();
                    await tx
                        .insertInto('ai_ledger')
                        .values({
                            id: randomUUID(),
                            kind: 'redistribution',
                            delta: targetAvailable,
                            reserved_delta: 0,
                            recorded_at: new Date(),
                            idempotency_key: `redistribution:${applyKey}:${bucketId}`,
                            bucket_id: bucketId,
                            operation_id: null,
                            compensates_id: null,
                        })
                        .execute();
                    continue;
                }
                const delta = targetAvailable - available(bucket);
                if (!delta) continue;
                await tx
                    .updateTable('ai_buckets')
                    .set({
                        granted: delta > 0 ? sql`granted+${delta}` : Number(bucket.granted),
                        balance_projection: sql`balance_projection+${delta}`,
                        version: sql`version+1`,
                    })
                    .where('id', '=', bucket.id)
                    .execute();
                await tx
                    .insertInto('ai_ledger')
                    .values({
                        id: randomUUID(),
                        kind: 'redistribution',
                        delta,
                        reserved_delta: 0,
                        recorded_at: new Date(),
                        idempotency_key: `redistribution:${applyKey}:${bucket.id}`,
                        bucket_id: bucket.id,
                        operation_id: null,
                        compensates_id: null,
                    })
                    .execute();
            }
            if (!reserveBucket && familyReserveAfter > 0) {
                const bucketId = randomUUID();
                await tx
                    .insertInto('ai_buckets')
                    .values({
                        id: bucketId,
                        kind: 'family_reserve',
                        granted: familyReserveAfter,
                        expires_at: new Date(period.endsAt),
                        balance_projection: familyReserveAfter,
                        reserved_projection: 0,
                        user_id: null,
                        family_id: familyId,
                        quota_period_id: period.id,
                        order_id: null,
                    })
                    .execute();
                await tx
                    .insertInto('ai_ledger')
                    .values({
                        id: randomUUID(),
                        kind: 'redistribution',
                        delta: familyReserveAfter,
                        reserved_delta: 0,
                        recorded_at: new Date(),
                        idempotency_key: `redistribution:${applyKey}:${bucketId}`,
                        bucket_id: bucketId,
                        operation_id: null,
                        compensates_id: null,
                    })
                    .execute();
            } else if (reserveBucket) {
                const delta = familyReserveAfter - available(reserveBucket);
                if (delta) {
                    await tx
                        .updateTable('ai_buckets')
                        .set({
                            granted: delta > 0 ? sql`granted+${delta}` : Number(reserveBucket.granted),
                            balance_projection: sql`balance_projection+${delta}`,
                            version: sql`version+1`,
                        })
                        .where('id', '=', reserveBucket.id)
                        .execute();
                    await tx
                        .insertInto('ai_ledger')
                        .values({
                            id: randomUUID(),
                            kind: 'redistribution',
                            delta,
                            reserved_delta: 0,
                            recorded_at: new Date(),
                            idempotency_key: `redistribution:${applyKey}:${reserveBucket.id}`,
                            bucket_id: reserveBucket.id,
                            operation_id: null,
                            compensates_id: null,
                        })
                        .execute();
                }
            }
        }
        return familyAiQuotaRedistributionSchema.parse({
            applies: true,
            periodEndsAt: new Date(period.endsAt).toISOString(),
            unspentActions,
            memberCountBefore: beforeUserIds.length,
            memberCountAfter: afterUserIds.length,
            shareAfter,
            familyReserveAfter,
            currentUserBefore,
            currentUserAfter: afterUserIds.includes(currentUserId) ? shareAfter : 0,
        });
    }

    private async activeMembership(tx: Tx, userId: string) {
        return tx
            .selectFrom('family_memberships as membership')
            .innerJoin('families as family', 'family.id', 'membership.family_id')
            .select([
                'membership.id',
                'membership.family_id as familyId',
                'membership.profile_id as profileId',
                'family.owner_membership_id as ownerMembershipId',
                'family.version as familyVersion',
            ])
            .where('membership.user_id', '=', userId)
            .where('membership.left_at', 'is', null)
            .where('family.status', '=', 'active')
            .forUpdate()
            .executeTakeFirst();
    }

    private async familyMembers(tx: Tx, familyId: string) {
        return tx
            .selectFrom('family_memberships as membership')
            .innerJoin('users', 'users.id', 'membership.user_id')
            .select([
                'membership.id',
                'membership.user_id as userId',
                'membership.profile_id as profileId',
                'membership.joined_at as joinedAt',
                'membership.stable_order as stableOrder',
                'users.display_name as displayName',
            ])
            .where('membership.family_id', '=', familyId)
            .where('membership.left_at', 'is', null)
            .orderBy('membership.stable_order', 'asc')
            .forUpdate()
            .execute();
    }

    private async familyScope(tx: Tx, familyId: string) {
        return (
            await tx
                .selectFrom('data_scopes')
                .select('id')
                .where('kind', '=', 'family')
                .where('family_id', '=', familyId)
                .executeTakeFirstOrThrow()
        ).id;
    }

    private async finishMembership(tx: Tx, member: { id: string; profileId: string }, at: Date) {
        await tx
            .updateTable('family_access_leases')
            .set({ revoked_at: at, version: sql`version + 1` })
            .where('membership_id', '=', member.id)
            .where('revoked_at', 'is', null)
            .execute();
        await tx
            .updateTable('family_memberships')
            .set({ left_at: at, version: sql`version + 1` })
            .where('id', '=', member.id)
            .where('left_at', 'is', null)
            .execute();
        await tx
            .updateTable('family_profiles')
            .set({ archived_at: at, version: sql`version + 1` })
            .where('id', '=', member.profileId)
            .where('archived_at', 'is', null)
            .execute();
    }

    private async moveCoverage(tx: Tx, familyId: string, leavingUserId: string, successorUserId?: string) {
        const coverage = await tx
            .selectFrom('family_coverages as coverage')
            .innerJoin('subscriptions', 'subscriptions.id', 'coverage.subscription_id')
            .select(['coverage.id', 'coverage.subscription_id as subscriptionId', 'subscriptions.owner_id as ownerId'])
            .where('coverage.family_id', '=', familyId)
            .where('coverage.selected_at', 'is not', null)
            .where('coverage.ends_at', 'is', null)
            .forUpdate()
            .executeTakeFirst();
        if (coverage && coverage.ownerId !== leavingUserId) return;
        const at = new Date();
        if (coverage)
            await tx
                .updateTable('family_coverages')
                .set({ ends_at: at, version: sql`version + 1` })
                .where('id', '=', coverage.id)
                .execute();
        if (!successorUserId) return;
        const fallback = await this.entitlements.resolvePersonal(successorUserId, tx);
        if (!fallback.capabilities.family || !fallback.subscriptionId) return;
        await tx
            .insertInto('family_coverages')
            .values({
                id: randomUUID(),
                reason: 'owner_subscription',
                starts_at: at,
                ends_at: null,
                selected_at: at,
                family_id: familyId,
                subscription_id: fallback.subscriptionId,
                combination_id: null,
            })
            .execute();
    }

    private async recordOwnershipNotice(
        tx: Tx,
        familyId: string,
        fromMembershipId: string,
        successor: { id: string; userId: string },
        mode: 'exit' | 'removal',
        at: Date,
    ) {
        const transferId = randomUUID();
        await tx
            .insertInto('ownership_transfers')
            .values({
                id: transferId,
                mode,
                status: 'applied',
                accepted_at: at,
                applied_at: at,
                reason: mode === 'exit' ? 'Владелец вышел из семьи' : 'Владелец исключён из семьи',
                family_id: familyId,
                from_membership_id: fromMembershipId,
                to_membership_id: successor.id,
            })
            .execute();
        await tx
            .insertInto('notifications')
            .values({
                id: randomUUID(),
                category: 'family',
                priority: 'important',
                payload_minimized: {
                    type: 'family-ownership-assigned',
                    title: 'Вы стали владельцем семьи',
                    body: 'Предыдущий владелец вышел. Владение уже передано вам; подтверждение не требуется.',
                    href: '/family/members',
                },
                dedup_key: `family-owner:${transferId}`,
                available_at: at,
                read_at: null,
                fullscreen_seen_at: null,
                user_id: successor.userId,
                ownership_transfer_id: transferId,
                announcement_id: null,
            })
            .execute();
        return transferId;
    }

    private async priorCommand<T>(
        tx: Tx,
        actorId: string,
        operation: string,
        target: string,
        key: string,
        requestHash: string,
    ): Promise<T | null> {
        const previous = await tx
            .selectFrom('idempotency_records')
            .select(['request_hash', 'response_snapshot'])
            .where('actor_namespace', '=', `user:${actorId}`)
            .where('operation', '=', operation)
            .where('target_binding', '=', target)
            .where('key', '=', key)
            .executeTakeFirst();
        if (!previous) return null;
        if (previous.request_hash !== requestHash) throw new ConflictException('Idempotency key already used');
        return previous.response_snapshot as T;
    }

    private async completeCommand(
        tx: Tx,
        actorId: string,
        operation: string,
        target: string,
        key: string,
        requestHash: string,
        response: unknown,
        scopeId: string | null,
    ) {
        await tx
            .insertInto('idempotency_records')
            .values({
                id: randomUUID(),
                operation,
                target_binding: target,
                key,
                request_hash: requestHash,
                status: 'completed',
                response_snapshot: JSON.parse(JSON.stringify(response)) as never,
                expires_at: sql`'infinity'::timestamptz`,
                user_id: actorId,
                scope_id: scopeId,
                actor_namespace: `user:${actorId}`,
            })
            .execute();
    }

    private invitationStatus(row: { status: string; expiresAt: Date }) {
        return row.status === 'pending' && row.expiresAt <= new Date() ? 'expired' : row.status;
    }

    private invitationView(
        row: {
            id: string;
            recipientBinding: unknown;
            status: string;
            proposedBy: string;
            expiresAt: Date;
            createdAt: Date;
            version: bigint | number | string;
        },
        actorId: string,
    ) {
        const binding = row.recipientBinding as { login?: unknown; displayName?: unknown };
        return {
            id: row.id,
            recipientLogin: typeof binding.login === 'string' ? binding.login : 'unknown',
            recipientDisplayName: typeof binding.displayName === 'string' ? binding.displayName : 'Пользователь',
            status: this.invitationStatus(row),
            proposedByMe: row.proposedBy === actorId,
            expiresAt: row.expiresAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
            version: Number(row.version),
        };
    }

    private invitationToken() {
        const token = randomBytes(32).toString('base64url');
        return { token, hash: createHash('sha256').update(token).digest('hex') };
    }

    invitations(userId: string) {
        return this.database.transaction(async (tx) => {
            const membership = await this.activeMembership(tx, userId);
            if (!membership) throw new NotFoundException();
            const owner = membership.id === membership.ownerMembershipId;
            const rows = await tx
                .selectFrom('family_invitations')
                .select([
                    'id',
                    'recipient_binding as recipientBinding',
                    'status',
                    'proposed_by as proposedBy',
                    'expires_at as expiresAt',
                    'created_at as createdAt',
                    'version',
                ])
                .where('family_id', '=', membership.familyId)
                .$if(!owner, (query) => query.where('proposed_by', '=', userId))
                .orderBy('created_at', 'desc')
                .limit(100)
                .execute();
            return familyInvitationListSchema.parse({ items: rows.map((row) => this.invitationView(row, userId)) });
        });
    }

    invite(raw: unknown, actor: Principal, requestId: string) {
        const input = familyInvitationCreateSchema.parse(raw);
        const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const prior = await this.priorCommand<unknown>(
                tx,
                actor.id,
                'family.invitation.create',
                actor.id,
                input.idempotencyKey,
                requestHash,
            );
            if (prior) return familyInvitationResultSchema.parse(prior);
            const membership = await this.activeMembership(tx, actor.id);
            if (!membership) throw new NotFoundException();
            if (Number(membership.familyVersion) !== input.expectedVersion)
                throw new HttpException('Состав семьи изменился', 412);
            const entitlement = await this.entitlements.resolveFamily(actor.id, membership.familyId, tx);
            if (!entitlement.capabilities.family) throw new ForbiddenException('Семейный доступ приостановлен');
            const recipient = await tx
                .selectFrom('users')
                .select(['id', 'login', 'display_name as displayName'])
                .where(sql<boolean>`lower(login)=lower(${input.login})`)
                .where('status', '=', 'active')
                .where('archived_at', 'is', null)
                .executeTakeFirst();
            if (!recipient || recipient.id === actor.id) throw new NotFoundException('Пользователь не найден');
            const occupied = await tx
                .selectFrom('family_memberships')
                .select('id')
                .where('user_id', '=', recipient.id)
                .where('left_at', 'is', null)
                .executeTakeFirst();
            if (occupied) throw new ConflictException('Пользователь уже состоит в семье');
            const duplicate = await tx
                .selectFrom('family_invitations')
                .select('id')
                .where('family_id', '=', membership.familyId)
                .where(sql<boolean>`recipient_binding->>'userId'=${recipient.id}`)
                .where('status', 'in', ['proposed', 'pending'])
                .where('expires_at', '>', new Date())
                .executeTakeFirst();
            if (duplicate) throw new ConflictException('Активное приглашение уже существует');
            const isOwner = membership.id === membership.ownerMembershipId;
            const issued = this.invitationToken();
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 7 * 86_400_000);
            const invitationId = randomUUID();
            await tx
                .insertInto('family_invitations')
                .values({
                    id: invitationId,
                    recipient_binding: {
                        userId: recipient.id,
                        login: recipient.login,
                        displayName: recipient.displayName,
                    },
                    token_hash: issued.hash,
                    status: isOwner ? 'pending' : 'proposed',
                    expires_at: expiresAt,
                    approved_at: isOwner ? now : null,
                    accepted_at: null,
                    family_id: membership.familyId,
                    proposed_by: actor.id,
                    approved_by: isOwner ? actor.id : null,
                    accepted_membership_id: null,
                })
                .execute();
            const row = {
                id: invitationId,
                recipientBinding: { login: recipient.login, displayName: recipient.displayName },
                status: isOwner ? 'pending' : 'proposed',
                proposedBy: actor.id,
                expiresAt,
                createdAt: now,
                version: 1,
            };
            const result = familyInvitationResultSchema.parse({
                invitation: this.invitationView(row, actor.id),
                token: isOwner ? issued.token : null,
            });
            const scope = await this.familyScope(tx, membership.familyId);
            await this.completeCommand(
                tx,
                actor.id,
                'family.invitation.create',
                actor.id,
                input.idempotencyKey,
                requestHash,
                result,
                scope,
            );
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: isOwner ? 'family.invitation.created' : 'family.invitation.proposed',
                    target_type: 'family_invitation',
                    target_id: invitationId,
                    actor_id: actor.id,
                    scope_id: scope,
                    effective_at: now,
                    recorded_at: now,
                    request_id: requestId,
                    reason: null,
                    before_redacted: null,
                    after_redacted: { recipientUserId: recipient.id, expiresAt: expiresAt.toISOString() },
                })
                .execute();
            return result;
        });
    }

    approveInvitation(invitationId: string, raw: unknown, actor: Principal, requestId: string) {
        return this.changeInvitation(invitationId, raw, actor, requestId, 'approve');
    }

    cancelInvitation(invitationId: string, raw: unknown, actor: Principal, requestId: string) {
        return this.changeInvitation(invitationId, raw, actor, requestId, 'cancel');
    }

    private changeInvitation(
        invitationId: string,
        raw: unknown,
        actor: Principal,
        requestId: string,
        action: 'approve' | 'cancel',
    ) {
        const input = familyInvitationDecisionSchema.parse(raw);
        const requestHash = createHash('sha256').update(JSON.stringify({ action, input })).digest('hex');
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const prior = await this.priorCommand<unknown>(
                tx,
                actor.id,
                `family.invitation.${action}`,
                invitationId,
                input.idempotencyKey,
                requestHash,
            );
            if (prior) return familyInvitationResultSchema.parse(prior);
            const membership = await this.activeMembership(tx, actor.id);
            if (!membership) throw new NotFoundException();
            const row = await tx
                .selectFrom('family_invitations')
                .select([
                    'id',
                    'recipient_binding as recipientBinding',
                    'status',
                    'proposed_by as proposedBy',
                    'expires_at as expiresAt',
                    'created_at as createdAt',
                    'version',
                ])
                .where('id', '=', invitationId)
                .where('family_id', '=', membership.familyId)
                .forUpdate()
                .executeTakeFirst();
            if (!row) throw new NotFoundException();
            if (Number(row.version) !== input.expectedVersion) throw new HttpException('Приглашение изменилось', 412);
            const isOwner = membership.id === membership.ownerMembershipId;
            if (action === 'approve' && !isOwner) throw new ForbiddenException();
            if (action === 'cancel' && !isOwner && row.proposedBy !== actor.id) throw new ForbiddenException();
            if (this.invitationStatus(row) === 'expired') throw new ConflictException('Приглашение истекло');
            if (action === 'approve' && row.status !== 'proposed')
                throw new ConflictException('Предложение недоступно');
            if (action === 'cancel' && !['proposed', 'pending'].includes(row.status))
                throw new ConflictException('Приглашение уже завершено');
            const issued = this.invitationToken();
            const now = new Date();
            const expiresAt = action === 'approve' ? new Date(now.getTime() + 7 * 86_400_000) : row.expiresAt;
            await tx
                .updateTable('family_invitations')
                .set({
                    status: action === 'approve' ? 'pending' : 'cancelled',
                    token_hash: action === 'approve' ? issued.hash : sql`token_hash`,
                    expires_at: expiresAt,
                    approved_at: action === 'approve' ? now : null,
                    approved_by: action === 'approve' ? actor.id : null,
                    version: Number(row.version) + 1,
                })
                .where('id', '=', invitationId)
                .execute();
            const result = familyInvitationResultSchema.parse({
                invitation: this.invitationView(
                    {
                        ...row,
                        status: action === 'approve' ? 'pending' : 'cancelled',
                        expiresAt,
                        version: Number(row.version) + 1,
                    },
                    actor.id,
                ),
                token: action === 'approve' ? issued.token : null,
            });
            const scope = await this.familyScope(tx, membership.familyId);
            await this.completeCommand(
                tx,
                actor.id,
                `family.invitation.${action}`,
                invitationId,
                input.idempotencyKey,
                requestHash,
                result,
                scope,
            );
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: action === 'approve' ? 'family.invitation.approved' : 'family.invitation.cancelled',
                    target_type: 'family_invitation',
                    target_id: invitationId,
                    actor_id: actor.id,
                    scope_id: scope,
                    effective_at: now,
                    recorded_at: now,
                    request_id: requestId,
                    reason: null,
                    before_redacted: { status: row.status },
                    after_redacted: { status: result.invitation.status },
                })
                .execute();
            return result;
        });
    }

    invitationPreview(userId: string, token: string) {
        const parsed = familyInvitationAcceptSchema.shape.token.parse(token);
        const hash = createHash('sha256').update(parsed).digest('hex');
        return this.database.transaction(async (tx) => {
            const row = await tx
                .selectFrom('family_invitations as invitation')
                .innerJoin('families as family', 'family.id', 'invitation.family_id')
                .innerJoin('users as inviter', 'inviter.id', 'invitation.proposed_by')
                .select([
                    'family.id as familyId',
                    'family.name as familyName',
                    'family.version as familyVersion',
                    'inviter.display_name as inviterName',
                    'invitation.recipient_binding as recipientBinding',
                    'invitation.status',
                    'invitation.expires_at as expiresAt',
                ])
                .where('invitation.token_hash', '=', hash)
                .executeTakeFirst();
            const binding = row?.recipientBinding as { userId?: unknown; login?: unknown } | undefined;
            if (!row || binding?.userId !== userId) throw new NotFoundException();
            const members = await this.familyMembers(tx, row.familyId);
            const beforeUserIds = members.map((member) => member.userId);
            const aiQuotaRedistribution = await this.aiQuotaRedistribution(
                tx,
                row.familyId,
                beforeUserIds,
                [...beforeUserIds, userId],
                userId,
            );
            return familyInvitationPreviewSchema.parse({
                familyName: row.familyName,
                familyVersion: Number(row.familyVersion),
                inviterName: row.inviterName,
                recipientLogin: binding.login,
                status: this.invitationStatus(row),
                expiresAt: row.expiresAt.toISOString(),
                aiQuotaRedistribution,
            });
        });
    }

    acceptInvitation(raw: unknown, actor: Principal, requestId: string) {
        const input = familyInvitationAcceptSchema.parse(raw);
        const tokenHash = createHash('sha256').update(input.token).digest('hex');
        const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const prior = await this.priorCommand<unknown>(
                tx,
                actor.id,
                'family.invitation.accept',
                tokenHash,
                input.idempotencyKey,
                requestHash,
            );
            if (prior) return familyContextSchema.parse(prior);
            const invitation = await tx
                .selectFrom('family_invitations')
                .select([
                    'id',
                    'family_id as familyId',
                    'recipient_binding as recipientBinding',
                    'status',
                    'expires_at as expiresAt',
                ])
                .where('token_hash', '=', tokenHash)
                .forUpdate()
                .executeTakeFirst();
            const binding = invitation?.recipientBinding as { userId?: unknown } | undefined;
            if (!invitation || binding?.userId !== actor.id) throw new NotFoundException();
            if (invitation.status !== 'pending' || invitation.expiresAt <= new Date())
                throw new ConflictException('Приглашение недоступно или истекло');
            if (await this.activeMembership(tx, actor.id))
                throw new ConflictException('Пользователь уже состоит в семье');
            const owner = await tx
                .selectFrom('families')
                .select(['version', 'owner_membership_id as ownerMembershipId'])
                .where('id', '=', invitation.familyId)
                .where('status', '=', 'active')
                .forUpdate()
                .executeTakeFirst();
            if (!owner) throw new ConflictException('Семья недоступна');
            if (Number(owner.version) !== input.expectedFamilyVersion)
                throw new HttpException('Состав семьи изменился после предпросмотра', 412);
            const coverage = await tx
                .selectFrom('family_coverages as coverage')
                .innerJoin('subscriptions as subscription', 'subscription.id', 'coverage.subscription_id')
                .innerJoin('subscription_periods as period', 'period.subscription_id', 'subscription.id')
                .innerJoin('billing_products as product', 'product.id', 'subscription.product_id')
                .select('coverage.id')
                .where('coverage.family_id', '=', invitation.familyId)
                .where('coverage.selected_at', 'is not', null)
                .where('coverage.starts_at', '<=', new Date())
                .where((expression) =>
                    expression.or([
                        expression('coverage.ends_at', 'is', null),
                        expression('coverage.ends_at', '>', new Date()),
                    ]),
                )
                .where('subscription.status', '=', 'active')
                .where('period.starts_at', '<=', new Date())
                .where('period.ends_at', '>', new Date())
                .where('product.code', 'in', ['plus', 'pro'])
                .executeTakeFirst();
            if (!coverage) throw new ForbiddenException('Семейный доступ приостановлен');
            const members = await this.familyMembers(tx, invitation.familyId);
            const seats = await tx
                .selectFrom('family_slot_grants')
                .select('seats')
                .where('family_id', '=', invitation.familyId)
                .where('accepted_at', 'is not', null)
                .where('revoked_at', 'is', null)
                .execute();
            const limit = 4 + seats.reduce((sum, row) => sum + Number(row.seats), 0);
            if (members.length >= limit) throw new ConflictException('В семье больше нет свободных мест');
            const user = await tx
                .selectFrom('users')
                .select('display_name')
                .where('id', '=', actor.id)
                .executeTakeFirstOrThrow();
            const oldProfile = await tx
                .selectFrom('family_profiles')
                .select('id')
                .where('family_id', '=', invitation.familyId)
                .where('linked_user_id', '=', actor.id)
                .orderBy('created_at', 'desc')
                .executeTakeFirst();
            const profileId = oldProfile?.id ?? randomUUID();
            if (oldProfile)
                await tx
                    .updateTable('family_profiles')
                    .set({ archived_at: null, name: user.display_name, version: sql`version+1` })
                    .where('id', '=', profileId)
                    .execute();
            else
                await tx
                    .insertInto('family_profiles')
                    .values({
                        id: profileId,
                        name: user.display_name,
                        age_group: null,
                        portion_size: null,
                        preferences: null,
                        archived_at: null,
                        family_id: invitation.familyId,
                        linked_user_id: actor.id,
                    })
                    .execute();
            const membershipId = randomUUID();
            const stableOrder = Math.max(0, ...members.map((member) => Number(member.stableOrder))) + 1;
            const now = new Date();
            await tx
                .insertInto('family_memberships')
                .values({
                    id: membershipId,
                    joined_at: now,
                    left_at: null,
                    stable_order: stableOrder,
                    family_id: invitation.familyId,
                    user_id: actor.id,
                    profile_id: profileId,
                })
                .execute();
            await this.aiQuotaRedistribution(
                tx,
                invitation.familyId,
                members.map((member) => member.userId),
                [...members.map((member) => member.userId), actor.id],
                actor.id,
                `invitation:${invitation.id}`,
            );
            await tx
                .updateTable('family_invitations')
                .set({
                    status: 'accepted',
                    accepted_at: now,
                    accepted_membership_id: membershipId,
                    version: sql`version+1`,
                })
                .where('id', '=', invitation.id)
                .execute();
            await tx
                .updateTable('families')
                .set({ version: Number(owner.version) + 1 })
                .where('id', '=', invitation.familyId)
                .execute();
            const result = await this.context(actor.id, tx);
            const scope = await this.familyScope(tx, invitation.familyId);
            await this.completeCommand(
                tx,
                actor.id,
                'family.invitation.accept',
                tokenHash,
                input.idempotencyKey,
                requestHash,
                result,
                scope,
            );
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: 'family.invitation.accepted',
                    target_type: 'family_invitation',
                    target_id: invitation.id,
                    actor_id: actor.id,
                    scope_id: scope,
                    effective_at: now,
                    recorded_at: now,
                    request_id: requestId,
                    reason: null,
                    before_redacted: { status: 'pending' },
                    after_redacted: { membershipId },
                })
                .execute();
            return result;
        });
    }

    async context(userId: string, database?: Tx | NonNullable<DatabaseService['db']>): Promise<FamilyContext> {
        const db = database ?? (await this.db());
        const membership = await db
            .selectFrom('family_memberships as membership')
            .innerJoin('families as family', 'family.id', 'membership.family_id')
            .select([
                'membership.id as membershipId',
                'membership.family_id as familyId',
                'family.name',
                'family.version',
                'family.owner_membership_id as ownerMembershipId',
            ])
            .where('membership.user_id', '=', userId)
            .where('membership.left_at', 'is', null)
            .where('family.status', '=', 'active')
            .executeTakeFirst();
        const personalEntitlement = await this.entitlements.resolve(userId, db);
        if (!membership)
            return familyContextSchema.parse({
                state: 'none',
                entitlement: personalEntitlement,
                family: null,
                blockedReason: null,
            });
        const [members, slotRows, entitlement] = await Promise.all([
            db
                .selectFrom('family_memberships as member')
                .innerJoin('users', 'users.id', 'member.user_id')
                .select(['member.id', 'member.user_id', 'member.joined_at', 'users.display_name'])
                .where('member.family_id', '=', membership.familyId)
                .where('member.left_at', 'is', null)
                .orderBy('member.stable_order', 'asc')
                .execute(),
            db
                .selectFrom('family_slot_grants')
                .select('seats')
                .where('family_id', '=', membership.familyId)
                .where('accepted_at', 'is not', null)
                .where('revoked_at', 'is', null)
                .execute(),
            this.entitlements.resolveFamily(userId, membership.familyId, db),
        ]);
        const hasCoverage = entitlement.capabilities.family;
        return familyContextSchema.parse({
            state: hasCoverage ? 'active' : 'blocked',
            entitlement,
            family: {
                id: membership.familyId,
                name: membership.name,
                version: Number(membership.version),
                role: membership.membershipId === membership.ownerMembershipId ? 'owner' : 'member',
                memberCount: members.length,
                seatLimit: 4 + slotRows.reduce((sum, item) => sum + item.seats, 0),
                members: members.map((member) => ({
                    id: member.id,
                    userId: member.user_id,
                    displayName: member.display_name,
                    role: member.id === membership.ownerMembershipId ? 'owner' : 'member',
                    joinedAt: new Date(member.joined_at).toISOString(),
                })),
            },
            blockedReason: hasCoverage ? null : 'coverage_required',
        });
    }

    create(raw: unknown, actor: Principal, requestId: string) {
        const input = familyCreateSchema.parse(raw);
        const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const previous = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${actor.id}`)
                .where('operation', '=', 'family.create')
                .where('target_binding', '=', actor.id)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (previous) {
                if (previous.request_hash !== requestHash) throw new ConflictException('Idempotency key already used');
                return familyContextSchema.parse(previous.response_snapshot);
            }
            const existing = await tx
                .selectFrom('family_memberships')
                .select('id')
                .where('user_id', '=', actor.id)
                .where('left_at', 'is', null)
                .forUpdate()
                .executeTakeFirst();
            if (existing) throw new ConflictException('Пользователь уже состоит в семье');
            const entitlement = await this.entitlements.resolvePersonal(actor.id, tx);
            if (!entitlement.capabilities.family || !entitlement.subscriptionId)
                throw new ForbiddenException('Для создания семьи нужен Plus или Pro');
            const user = await tx
                .selectFrom('users')
                .select('display_name')
                .where('id', '=', actor.id)
                .executeTakeFirstOrThrow();
            const familyId = randomUUID();
            const profileId = randomUUID();
            const membershipId = randomUUID();
            const scopeId = randomUUID();
            const createdAt = new Date();
            await tx
                .insertInto('families')
                .values({
                    id: familyId,
                    name: input.name,
                    status: 'archived',
                    archived_at: createdAt,
                    owner_membership_id: null,
                })
                .execute();
            await tx
                .insertInto('family_profiles')
                .values({
                    id: profileId,
                    name: user.display_name,
                    age_group: null,
                    portion_size: null,
                    preferences: null,
                    archived_at: null,
                    family_id: familyId,
                    linked_user_id: actor.id,
                })
                .execute();
            await tx
                .insertInto('family_memberships')
                .values({
                    id: membershipId,
                    joined_at: createdAt,
                    left_at: null,
                    stable_order: 1,
                    family_id: familyId,
                    user_id: actor.id,
                    profile_id: profileId,
                })
                .execute();
            await tx
                .updateTable('families')
                .set({ status: 'active', archived_at: null, owner_membership_id: membershipId, version: 2 })
                .where('id', '=', familyId)
                .execute();
            await tx
                .insertInto('data_scopes')
                .values({ id: scopeId, kind: 'family', user_id: null, family_id: familyId })
                .execute();
            await tx
                .insertInto('family_coverages')
                .values({
                    id: randomUUID(),
                    reason: 'owner_subscription',
                    starts_at: createdAt,
                    ends_at: null,
                    selected_at: createdAt,
                    family_id: familyId,
                    subscription_id: entitlement.subscriptionId,
                    combination_id: null,
                })
                .execute();
            const result = await this.context(actor.id, tx);
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'family.create',
                    target_binding: actor.id,
                    key: input.idempotencyKey,
                    request_hash: requestHash,
                    status: 'completed',
                    response_snapshot: result,
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: actor.id,
                    scope_id: scopeId,
                    actor_namespace: `user:${actor.id}`,
                })
                .execute();
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: 'family.create',
                    target_type: 'family',
                    target_id: familyId,
                    actor_id: actor.id,
                    scope_id: scopeId,
                    effective_at: createdAt,
                    recorded_at: new Date(),
                    request_id: requestId,
                    reason: 'Создание семьи владельцем',
                    before_redacted: null,
                    after_redacted: { memberCount: 1, seatLimit: 4 },
                })
                .execute();
            return result;
        });
    }

    leavePreview(userId: string) {
        return this.database.transaction(async (tx) => {
            const membership = await this.activeMembership(tx, userId);
            if (!membership) throw new NotFoundException();
            const members = await this.familyMembers(tx, membership.familyId);
            const candidates = members
                .filter((member) => member.id !== membership.id)
                .map((member): FamilyMember => ({
                    id: member.id,
                    userId: member.userId,
                    displayName: member.displayName,
                    role: member.id === membership.ownerMembershipId ? 'owner' : 'member',
                    joinedAt: new Date(member.joinedAt).toISOString(),
                }));
            const ranked = members
                .filter((member) => member.id !== membership.id)
                .map((member) => ({
                    id: member.id,
                    joinedAt: new Date(member.joinedAt).toISOString(),
                    stableOrder: Number(member.stableOrder),
                }));
            const aiQuotaRedistribution = await this.aiQuotaRedistribution(
                tx,
                membership.familyId,
                members.map((member) => member.userId),
                members.filter((member) => member.id !== membership.id).map((member) => member.userId),
                userId,
            );
            return familyLeavePreviewSchema.parse({
                familyId: membership.familyId,
                familyVersion: Number(membership.familyVersion),
                role: membership.id === membership.ownerMembershipId ? 'owner' : 'member',
                willArchive: members.length === 1,
                recommendedMembershipId: selectFamilySuccessor(ranked)?.id ?? null,
                candidates,
                aiQuotaRedistribution,
            });
        });
    }

    leave(raw: unknown, actor: Principal, requestId: string) {
        const input = familyLeaveSchema.parse(raw);
        const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const prior = await this.priorCommand<unknown>(
                tx,
                actor.id,
                'family.leave',
                actor.id,
                input.idempotencyKey,
                requestHash,
            );
            if (prior) return familyLifecycleResultSchema.parse(prior);
            const membership = await this.activeMembership(tx, actor.id);
            if (!membership) throw new NotFoundException();
            if (Number(membership.familyVersion) !== input.expectedVersion)
                throw new HttpException('Состав семьи изменился', 412);
            const members = await this.familyMembers(tx, membership.familyId);
            const remaining = members.filter((member) => member.id !== membership.id);
            const isOwner = membership.id === membership.ownerMembershipId;
            const currentOwner = members.find((member) => member.id === membership.ownerMembershipId);
            let successor: (typeof remaining)[number] | null = null;
            if (isOwner && remaining.length) {
                if (input.selection === 'manual')
                    successor =
                        remaining.find((member) => member.id === input.successorMembershipId) ??
                        (() => {
                            throw new HttpException('Преемник больше не доступен', 412);
                        })();
                else successor = selectFamilySuccessor(remaining);
            }
            const at = new Date();
            const scopeId = await this.familyScope(tx, membership.familyId);
            const aiQuotaRedistribution = await this.aiQuotaRedistribution(
                tx,
                membership.familyId,
                members.map((member) => member.userId),
                remaining.map((member) => member.userId),
                actor.id,
                `leave:${membership.id}`,
            );
            if (isOwner && successor) {
                await this.recordOwnershipNotice(tx, membership.familyId, membership.id, successor, 'exit', at);
                await tx
                    .updateTable('family_slot_grants')
                    .set({ holder_id: successor.userId, version: sql`version + 1` })
                    .where('family_id', '=', membership.familyId)
                    .where('holder_id', '=', actor.id)
                    .where('revoked_at', 'is', null)
                    .execute();
                await tx
                    .updateTable('families')
                    .set({ owner_membership_id: successor.id, version: Number(membership.familyVersion) + 1 })
                    .where('id', '=', membership.familyId)
                    .execute();
            } else if (isOwner) {
                await tx
                    .updateTable('families')
                    .set({
                        status: 'archived',
                        archived_at: at,
                        owner_membership_id: null,
                        version: Number(membership.familyVersion) + 1,
                    })
                    .where('id', '=', membership.familyId)
                    .execute();
            }
            await this.moveCoverage(
                tx,
                membership.familyId,
                actor.id,
                successor?.userId ?? (isOwner ? undefined : currentOwner?.userId),
            );
            await this.finishMembership(tx, membership, at);
            const result = familyLifecycleResultSchema.parse({
                familyId: membership.familyId,
                archived: isOwner && !successor,
                leftMembershipId: membership.id,
                successorMembershipId: successor?.id ?? null,
            });
            await this.completeCommand(
                tx,
                actor.id,
                'family.leave',
                actor.id,
                input.idempotencyKey,
                requestHash,
                result,
                scopeId,
            );
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: 'family.leave',
                    target_type: 'family_membership',
                    target_id: membership.id,
                    actor_id: actor.id,
                    scope_id: scopeId,
                    effective_at: at,
                    recorded_at: new Date(),
                    request_id: requestId,
                    reason: isOwner ? 'Выход владельца с передачей или архивированием' : 'Выход участника',
                    before_redacted: { role: isOwner ? 'owner' : 'member' },
                    after_redacted: {
                        archived: result.archived,
                        successorMembershipId: result.successorMembershipId,
                        aiQuotaRedistribution,
                    },
                })
                .execute();
            return result;
        });
    }

    removeMember(membershipId: string, raw: unknown, actor: Principal, requestId: string) {
        const input = familyMemberRemoveSchema.parse(raw);
        const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const prior = await this.priorCommand<unknown>(
                tx,
                actor.id,
                'family.member.remove',
                membershipId,
                input.idempotencyKey,
                requestHash,
            );
            if (prior) return familyContextSchema.parse(prior);
            const owner = await this.activeMembership(tx, actor.id);
            if (!owner || owner.id !== owner.ownerMembershipId) throw new ForbiddenException();
            if (Number(owner.familyVersion) !== input.expectedVersion)
                throw new HttpException('Состав семьи изменился', 412);
            if (membershipId === owner.id) throw new ConflictException('Для выхода владельца используйте передачу');
            const target = await tx
                .selectFrom('family_memberships')
                .select(['id', 'user_id as userId', 'profile_id as profileId'])
                .where('id', '=', membershipId)
                .where('family_id', '=', owner.familyId)
                .where('left_at', 'is', null)
                .forUpdate()
                .executeTakeFirst();
            if (!target) throw new NotFoundException();
            const at = new Date();
            const scopeId = await this.familyScope(tx, owner.familyId);
            const members = await this.familyMembers(tx, owner.familyId);
            const aiQuotaRedistribution = await this.aiQuotaRedistribution(
                tx,
                owner.familyId,
                members.map((member) => member.userId),
                members.filter((member) => member.id !== target.id).map((member) => member.userId),
                target.userId,
                `remove:${target.id}`,
            );
            await this.moveCoverage(tx, owner.familyId, target.userId, actor.id);
            await this.finishMembership(tx, target, at);
            await tx
                .updateTable('families')
                .set({ version: Number(owner.familyVersion) + 1 })
                .where('id', '=', owner.familyId)
                .execute();
            await tx
                .insertInto('notifications')
                .values({
                    id: randomUUID(),
                    category: 'family',
                    priority: 'important',
                    payload_minimized: {
                        type: 'family-membership-removed',
                        title: 'Доступ к семье завершён',
                        body: 'Владелец исключил вас из семьи. Ваши личные данные не изменились.',
                        href: '/family',
                    },
                    dedup_key: `family-removed:${membershipId}:${Number(owner.familyVersion) + 1}`,
                    available_at: at,
                    read_at: null,
                    fullscreen_seen_at: at,
                    user_id: target.userId,
                    ownership_transfer_id: null,
                    announcement_id: null,
                })
                .execute();
            const result = await this.context(actor.id, tx);
            await this.completeCommand(
                tx,
                actor.id,
                'family.member.remove',
                membershipId,
                input.idempotencyKey,
                requestHash,
                result,
                scopeId,
            );
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: 'family.member.remove',
                    target_type: 'family_membership',
                    target_id: membershipId,
                    actor_id: actor.id,
                    scope_id: scopeId,
                    effective_at: at,
                    recorded_at: new Date(),
                    request_id: requestId,
                    reason: 'Исключение участника владельцем',
                    before_redacted: { active: true },
                    after_redacted: { active: false, aiQuotaRedistribution },
                })
                .execute();
            return result;
        });
    }

    private memberProjection(
        member: { id: string; userId: string; displayName: string; joinedAt: Date | string },
        ownerMembershipId: string,
    ) {
        return {
            id: member.id,
            userId: member.userId,
            displayName: member.displayName,
            role: member.id === ownerMembershipId ? ('owner' as const) : ('member' as const),
            joinedAt: new Date(member.joinedAt).toISOString(),
        };
    }

    private async ownershipPreviewData(
        tx: Tx,
        actorId: string,
        targetMembershipId: string,
        expectedFamilyVersion?: number,
    ) {
        const membership = await this.activeMembership(tx, actorId);
        if (!membership || membership.id !== membership.ownerMembershipId) throw new ForbiddenException();
        if (expectedFamilyVersion !== undefined && Number(membership.familyVersion) !== expectedFamilyVersion)
            throw new HttpException('Семья изменилась после предпросмотра', 412);
        const members = await this.familyMembers(tx, membership.familyId);
        const from = members.find((member) => member.id === membership.id);
        const to = members.find((member) => member.id === targetMembershipId);
        if (!from || !to || to.id === from.id) throw new ConflictException('Получатель больше не доступен');
        const eligible = await sql`select u.id from meal.users u where u.id=${to.userId}::uuid and u.status='active'
          and u.archived_at is null and u.email_verified_at is not null and not exists(
            select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account' and s.revoked_at is null
              and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))`.execute(tx);
        if (!eligible.rows.length) throw new ConflictException('Получатель больше не доступен');
        const slots = await tx
            .selectFrom('family_slot_grants')
            .select('seats')
            .where('family_id', '=', membership.familyId)
            .where('accepted_at', 'is not', null)
            .where('revoked_at', 'is', null)
            .execute();
        const paidSeats = slots.reduce((sum, row) => sum + Number(row.seats), 0);
        const before = (await this.entitlements.resolveFamily(actorId, membership.familyId, tx)).capabilities.family
            ? ('active' as const)
            : ('blocked' as const);
        const coverage = await tx
            .selectFrom('family_coverages as coverage')
            .innerJoin('subscriptions', 'subscriptions.id', 'coverage.subscription_id')
            .select('subscriptions.owner_id as ownerId')
            .where('coverage.family_id', '=', membership.familyId)
            .where('coverage.selected_at', 'is not', null)
            .where('coverage.ends_at', 'is', null)
            .executeTakeFirst();
        const recalculatesCoverage = !coverage || coverage.ownerId === actorId;
        const targetPersonal = recalculatesCoverage ? await this.entitlements.resolvePersonal(to.userId, tx) : null;
        const after = recalculatesCoverage
            ? targetPersonal?.capabilities.family
                ? ('active' as const)
                : ('blocked' as const)
            : before;
        const base = {
            familyId: membership.familyId,
            familyVersion: Number(membership.familyVersion),
            from: this.memberProjection(from, membership.ownerMembershipId),
            to: this.memberProjection(to, membership.ownerMembershipId),
            seatLimit: 4 + paidSeats,
            paidSeats,
            memberCount: members.length,
            coverage: {
                before,
                after,
                willChange: coverage?.ownerId === actorId || (!coverage && !!targetPersonal?.capabilities.family),
                blockedReason: null,
            },
            effects: {
                formerOwnerRemains: true as const,
                paidSeatsMoveWithFamily: true as const,
                personalSubscriptionsChange: false as const,
            },
            canSubmit: true,
            blockers: [] as string[],
        };
        const previewKey = createHash('sha256').update(JSON.stringify(base)).digest('hex');
        return ownershipTransferPreviewSchema.parse({ ...base, previewKey });
    }

    private async transferProjection(tx: Tx, transferId: string) {
        const row = await sql<{
            id: string;
            status: string;
            version: number;
            familyId: string;
            reason: string | null;
            createdAt: Date;
            fromId: string;
            fromUserId: string;
            fromName: string;
            fromJoinedAt: Date;
            toId: string;
            toUserId: string;
            toName: string;
            toJoinedAt: Date;
            ownerMembershipId: string;
            currentFamilyVersion: number;
        }>`select t.id,t.status,t.version::int,t.family_id as "familyId",t.reason,t.created_at as "createdAt",
             fm.id as "fromId",fm.user_id as "fromUserId",fu.display_name as "fromName",fm.joined_at as "fromJoinedAt",
             tm.id as "toId",tm.user_id as "toUserId",tu.display_name as "toName",tm.joined_at as "toJoinedAt",
             f.owner_membership_id as "ownerMembershipId",f.version::int as "currentFamilyVersion"
           from meal.ownership_transfers t join meal.families f on f.id=t.family_id
           join meal.family_memberships fm on fm.id=t.from_membership_id join meal.users fu on fu.id=fm.user_id
           join meal.family_memberships tm on tm.id=t.to_membership_id join meal.users tu on tu.id=tm.user_id
           where t.id=${transferId}::uuid and t.mode='voluntary'`.execute(tx);
        const value = row.rows[0];
        if (!value || !['pending', 'accepted', 'declined', 'cancelled'].includes(value.status))
            throw new NotFoundException();
        let preview: unknown;
        try {
            const metadata = JSON.parse(value.reason ?? '') as { preview?: unknown };
            preview = metadata.preview;
        } catch {
            throw new ConflictException('Данные запроса повреждены');
        }
        const parsedPreview = ownershipTransferPreviewSchema.parse(preview);
        const request = ownershipTransferRequestSchema.parse({
            id: value.id,
            status: value.status,
            version: value.version,
            familyId: value.familyId,
            familyVersion: value.currentFamilyVersion,
            from: this.memberProjection(
                {
                    id: value.fromId,
                    userId: value.fromUserId,
                    displayName: value.fromName,
                    joinedAt: value.fromJoinedAt,
                },
                value.ownerMembershipId,
            ),
            to: this.memberProjection(
                { id: value.toId, userId: value.toUserId, displayName: value.toName, joinedAt: value.toJoinedAt },
                value.ownerMembershipId,
            ),
            createdAt: new Date(value.createdAt).toISOString(),
            review: {
                seatLimit: parsedPreview.seatLimit,
                paidSeats: parsedPreview.paidSeats,
                memberCount: parsedPreview.memberCount,
                coverage: parsedPreview.coverage,
            },
        });
        return { request, preview: parsedPreview };
    }

    ownershipWorkspace(actor: Principal) {
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const membership = await this.activeMembership(tx, actor.id);
            if (!membership) throw new NotFoundException();
            const members = await this.familyMembers(tx, membership.familyId);
            const owner = members.find((member) => member.id === membership.ownerMembershipId);
            if (!owner) throw new ConflictException('Владелец семьи недоступен');
            const eligibleRows = await sql<{
                id: string;
            }>`select u.id from meal.users u where u.id=any(${members.map((member) => member.userId)}::uuid[])
              and u.status='active' and u.archived_at is null and u.email_verified_at is not null and not exists(
                select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account' and s.revoked_at is null
                  and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))`.execute(tx);
            const eligibleUsers = new Set(eligibleRows.rows.map((row) => row.id));
            const slots = await tx
                .selectFrom('family_slot_grants')
                .select('seats')
                .where('family_id', '=', membership.familyId)
                .where('accepted_at', 'is not', null)
                .where('revoked_at', 'is', null)
                .execute();
            const paidSeats = slots.reduce((sum, row) => sum + Number(row.seats), 0);
            const pending = await tx
                .selectFrom('ownership_transfers')
                .select('id')
                .where('family_id', '=', membership.familyId)
                .where('mode', '=', 'voluntary')
                .where('status', '=', 'pending')
                .orderBy('created_at', 'desc')
                .executeTakeFirst();
            const pendingRequest = pending ? (await this.transferProjection(tx, pending.id)).request : null;
            const ownsFamily = membership.id === membership.ownerMembershipId;
            const receivesPendingRequest = pendingRequest?.to.userId === actor.id;
            if (!ownsFamily && !receivesPendingRequest) throw new ForbiddenException();
            return ownershipWorkspaceSchema.parse({
                familyId: membership.familyId,
                familyVersion: Number(membership.familyVersion),
                owner: this.memberProjection(owner, owner.id),
                candidates: ownsFamily
                    ? members
                          .filter((member) => member.id !== membership.id && eligibleUsers.has(member.userId))
                          .map((member) => this.memberProjection(member, owner.id))
                    : [],
                seatLimit: 4 + paidSeats,
                paidSeats,
                pendingRequest,
            });
        });
    }

    ownershipPreview(raw: unknown, actor: Principal) {
        const input = ownershipPreviewInputSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            return this.ownershipPreviewData(tx, actor.id, input.targetMembershipId, input.expectedFamilyVersion);
        });
    }

    createOwnershipRequest(raw: unknown, actor: Principal) {
        const input = ownershipRequestCreateSchema.parse(raw);
        const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const prior = await this.priorCommand<unknown>(
                tx,
                actor.id,
                'family.ownership.request',
                input.targetMembershipId,
                input.idempotencyKey,
                hash,
            );
            if (prior) return ownershipRequestDetailSchema.parse(prior);
            const preview = await this.ownershipPreviewData(
                tx,
                actor.id,
                input.targetMembershipId,
                input.expectedFamilyVersion,
            );
            if (preview.previewKey !== input.previewKey) throw new HttpException('Требуется новый предпросмотр', 412);
            const existing = await tx
                .selectFrom('ownership_transfers')
                .select(['id', 'from_membership_id as fromMembershipId', 'to_membership_id as toMembershipId'])
                .where('family_id', '=', preview.familyId)
                .where('mode', '=', 'voluntary')
                .where('status', '=', 'pending')
                .forUpdate()
                .executeTakeFirst();
            if (existing) {
                const currentMembers = await this.familyMembers(tx, preview.familyId);
                const stillValid =
                    existing.fromMembershipId === preview.from.id &&
                    currentMembers.some((member) => member.id === existing.toMembershipId);
                if (stillValid) throw new ConflictException('Уже есть ожидающий запрос');
                await tx
                    .updateTable('ownership_transfers')
                    .set({ status: 'cancelled', version: sql`version+1` })
                    .where('id', '=', existing.id)
                    .execute();
            }
            const id = randomUUID();
            await tx
                .insertInto('ownership_transfers')
                .values({
                    id,
                    mode: 'voluntary',
                    status: 'pending',
                    accepted_at: null,
                    applied_at: null,
                    reason: JSON.stringify({ familyVersion: preview.familyVersion, preview }),
                    family_id: preview.familyId,
                    from_membership_id: preview.from.id,
                    to_membership_id: preview.to.id,
                })
                .execute();
            await tx
                .insertInto('notifications')
                .values({
                    id: randomUUID(),
                    category: 'family',
                    priority: 'important',
                    payload_minimized: {
                        type: 'family-ownership-request',
                        title: 'Запрос на передачу владения',
                        href: `/family/ownership/requests/${id}`,
                    },
                    dedup_key: `family-ownership-request:${id}`,
                    available_at: new Date(),
                    read_at: null,
                    fullscreen_seen_at: new Date(),
                    user_id: preview.to.userId,
                    ownership_transfer_id: id,
                    announcement_id: null,
                })
                .execute();
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: 'family.ownership.requested',
                    target_type: 'ownership_transfer',
                    target_id: id,
                    effective_at: new Date(),
                    recorded_at: new Date(),
                    reason: 'Добровольная передача владения',
                    before_redacted: null,
                    after_redacted: { familyId: preview.familyId, from: preview.from.id, to: preview.to.id },
                    request_id: input.idempotencyKey,
                    actor_id: actor.id,
                    scope_id: null,
                })
                .execute();
            const projected = await this.transferProjection(tx, id);
            const result = ownershipRequestDetailSchema.parse({ request: projected.request, token: id, preview });
            await this.completeCommand(
                tx,
                actor.id,
                'family.ownership.request',
                input.targetMembershipId,
                input.idempotencyKey,
                hash,
                result,
                null,
            );
            return result;
        });
    }

    ownershipRequest(actor: Principal, token: string) {
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const projected = await this.transferProjection(tx, token);
            if (![projected.request.from.userId, projected.request.to.userId].includes(actor.id))
                throw new NotFoundException();
            const membership = await this.activeMembership(tx, actor.id);
            if (!membership || membership.familyId !== projected.request.familyId) throw new NotFoundException();
            return ownershipRequestDetailSchema.parse({
                request: projected.request,
                token,
                preview: projected.preview,
            });
        });
    }

    decideOwnershipRequest(action: 'accept' | 'decline' | 'cancel', token: string, raw: unknown, actor: Principal) {
        const input = ownershipRequestDecisionSchema.parse(raw);
        const hash = createHash('sha256').update(JSON.stringify({ action, token, input })).digest('hex');
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const prior = await this.priorCommand<unknown>(
                tx,
                actor.id,
                `family.ownership.${action}`,
                token,
                input.idempotencyKey,
                hash,
            );
            if (prior) return ownershipRequestResultSchema.parse(prior);
            const projected = await this.transferProjection(tx, token);
            const request = projected.request;
            if (request.status !== 'pending') throw new ConflictException('Запрос уже завершён');
            if (request.version !== input.expectedVersion) throw new HttpException('Запрос изменился', 412);
            const isOwner = request.from.userId === actor.id;
            const isRecipient = request.to.userId === actor.id;
            if ((action === 'cancel' && !isOwner) || (action !== 'cancel' && !isRecipient))
                throw new NotFoundException();
            const actorMembership = await this.activeMembership(tx, actor.id);
            if (!actorMembership || actorMembership.familyId !== request.familyId)
                throw new ConflictException('Участник больше не состоит в семье');
            if (Number(actorMembership.familyVersion) !== input.expectedFamilyVersion)
                throw new HttpException('Семья изменилась после предпросмотра', 412);
            const members = await this.familyMembers(tx, request.familyId);
            if (!members.some((member) => member.id === request.to.id && member.userId === request.to.userId))
                throw new ConflictException('Получатель больше не состоит в семье');
            const now = new Date();
            if (action === 'accept') {
                const ownerMembership = await this.activeMembership(tx, request.from.userId);
                if (
                    !ownerMembership ||
                    ownerMembership.familyId !== request.familyId ||
                    ownerMembership.id !== ownerMembership.ownerMembershipId
                )
                    throw new ConflictException('Владелец семьи изменился');
                const current = await this.ownershipPreviewData(
                    tx,
                    request.from.userId,
                    request.to.id,
                    input.expectedFamilyVersion,
                );
                if (current.previewKey !== projected.preview.previewKey)
                    throw new HttpException('Последствия изменились, требуется новый запрос', 412);
                await this.moveCoverage(tx, request.familyId, request.from.userId, request.to.userId);
                await tx
                    .updateTable('family_slot_grants')
                    .set({ holder_id: request.to.userId, version: sql`version+1` })
                    .where('family_id', '=', request.familyId)
                    .where('accepted_at', 'is not', null)
                    .where('revoked_at', 'is', null)
                    .execute();
                await tx
                    .updateTable('families')
                    .set({ owner_membership_id: request.to.id, version: sql`version+1` })
                    .where('id', '=', request.familyId)
                    .execute();
                await tx
                    .updateTable('ownership_transfers')
                    .set({ status: 'accepted', accepted_at: now, applied_at: now, version: sql`version+1` })
                    .where('id', '=', token)
                    .execute();
            } else
                await tx
                    .updateTable('ownership_transfers')
                    .set({ status: action === 'decline' ? 'declined' : 'cancelled', version: sql`version+1` })
                    .where('id', '=', token)
                    .execute();
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: `family.ownership.${action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled'}`,
                    target_type: 'ownership_transfer',
                    target_id: token,
                    effective_at: now,
                    recorded_at: now,
                    reason: 'Добровольная передача владения',
                    before_redacted: { status: 'pending' },
                    after_redacted: {
                        status: action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled',
                    },
                    request_id: input.idempotencyKey,
                    actor_id: actor.id,
                    scope_id: null,
                })
                .execute();
            const finalProjection = await this.transferProjection(tx, token);
            const result = ownershipRequestResultSchema.parse({
                request: finalProjection.request,
                token,
                family: await this.context(actor.id, tx),
            });
            await this.completeCommand(
                tx,
                actor.id,
                `family.ownership.${action}`,
                token,
                input.idempotencyKey,
                hash,
                result,
                null,
            );
            return result;
        });
    }

    async ownershipNotice(userId: string) {
        const db = await this.db();
        const row = await db
            .selectFrom('notifications')
            .select(['id', 'ownership_transfer_id', 'payload_minimized', 'version'])
            .where('user_id', '=', userId)
            .where('category', '=', 'family')
            .where('priority', '=', 'important')
            .where('ownership_transfer_id', 'is not', null)
            .where('fullscreen_seen_at', 'is', null)
            .where('available_at', '<=', new Date())
            .orderBy('available_at', 'asc')
            .executeTakeFirst();
        if (!row)
            return ownershipNoticeSchema.parse({
                notice: null,
            });
        return ownershipNoticeSchema.parse({
            notice: {
                notificationId: row.id,
                transferId: row.ownership_transfer_id,
                title: 'Вы стали владельцем семьи',
                body: 'Владение уже передано вам. Подтверждение не требуется; теперь вам доступно управление участниками.',
                version: Number(row.version),
            },
        });
    }

    dismissOwnershipNotice(raw: unknown, actor: Principal) {
        const input = ownershipNoticeDismissSchema.parse(raw);
        const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const prior = await this.priorCommand<unknown>(
                tx,
                actor.id,
                'family.ownership-notice.dismiss',
                actor.id,
                input.idempotencyKey,
                requestHash,
            );
            if (prior) return ownershipNoticeDismissResultSchema.parse(prior);
            const notification = await tx
                .selectFrom('notifications')
                .select(['id', 'version', 'fullscreen_seen_at'])
                .where('id', '=', input.notificationId)
                .where('user_id', '=', actor.id)
                .where('ownership_transfer_id', 'is not', null)
                .forUpdate()
                .executeTakeFirst();
            if (!notification) throw new NotFoundException();
            if (Number(notification.version) !== input.expectedVersion)
                throw new HttpException('Уведомление изменилось', 412);
            const dismissed = !notification.fullscreen_seen_at;
            if (dismissed)
                await tx
                    .updateTable('notifications')
                    .set({
                        fullscreen_seen_at: new Date(),
                        read_at: new Date(),
                        version: Number(notification.version) + 1,
                    })
                    .where('id', '=', notification.id)
                    .execute();
            const result = ownershipNoticeDismissResultSchema.parse({ dismissed });
            await this.completeCommand(
                tx,
                actor.id,
                'family.ownership-notice.dismiss',
                actor.id,
                input.idempotencyKey,
                requestHash,
                result,
                null,
            );
            return result;
        });
    }
}
