import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { AdminAccessService } from '../admin-auth/admin-access.service.js';
import type { Principal } from '../auth/auth.service.js';
import {
    adminFreeAiGrantResultSchema,
    adminFreeAiGrantSchema,
    adminFreeAiViewSchema,
} from './admin-free-ai.contracts.js';

@Injectable()
export class AdminFreeAiService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: AdminAccessService,
    ) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    async view(userId: string) {
        const db = await this.db();
        const user = await db
            .selectFrom('users')
            .select(['id', 'login', 'display_name', 'status', 'version'])
            .where('id', '=', userId)
            .executeTakeFirst();
        if (!user) throw new NotFoundException();
        const [buckets, operations] = await Promise.all([
            sql<{
                id: string;
                kind: string;
                granted: number;
                balance: number;
                reserved: number;
                expiresAt: Date | null;
            }>`select id,kind,granted::integer,balance_projection::integer balance,reserved_projection::integer reserved,expires_at as "expiresAt" from meal.ai_buckets where user_id=${userId}::uuid order by created_at desc,id desc limit 100`.execute(
                db,
            ),
            sql<{
                id: string;
                taskId: string;
                status: string;
                cost: number;
                createdAt: Date;
            }>`select o.id,i.task_id as "taskId",o.status,i.cost::integer cost,o.created_at as "createdAt" from meal.ai_operations o join meal.ai_intervals i on i.id=o.interval_id join meal.ai_tasks t on t.id=i.task_id join meal.ai_conversations c on c.id=t.conversation_id where c.user_id=${userId}::uuid order by o.created_at desc,o.id desc limit 30`.execute(
                db,
            ),
        ]);
        const projected = buckets.rows.map((row) => ({
            ...row,
            kind: ['subscription', 'transferred', 'family_reserve', 'purchased', 'trial'].includes(row.kind)
                ? row.kind
                : 'trial',
            available: Math.max(0, row.balance - row.reserved),
            requiresConfirmation: row.kind === 'family_reserve',
            expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
        }));
        const total = projected.reduce((sum, row) => sum + row.balance, 0);
        const reserved = projected.reduce((sum, row) => sum + row.reserved, 0);
        return adminFreeAiViewSchema.parse({
            user: {
                id: user.id,
                login: user.login,
                displayName: user.display_name,
                status: user.status,
                version: String(user.version),
            },
            buckets: projected,
            total,
            reserved,
            available: Math.max(0, total - reserved),
            recentOperations: operations.rows.map((row) => ({
                ...row,
                createdAt: new Date(row.createdAt).toISOString(),
            })),
        });
    }

    async grant(userId: string, raw: unknown, actor: Principal, requestId: string) {
        const input = adminFreeAiGrantSchema.parse(raw);
        const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const result = await this.database.transaction(async (tx) => {
            await this.access.assertCritical(tx, actor);
            const user = await tx
                .selectFrom('users')
                .select(['id', 'version', 'status', 'archived_at'])
                .where('id', '=', userId)
                .forUpdate()
                .executeTakeFirst();
            if (!user) throw new NotFoundException();
            if (String(user.version) !== input.expectedUserVersion) throw new ConflictException('User changed');
            if (user.status !== 'active' || user.archived_at) throw new ConflictException('Account is inactive');
            const namespace = `admin:${actor.id}`;
            const previous = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', namespace)
                .where('operation', '=', 'admin.free-ai.grant')
                .where('target_binding', '=', userId)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (previous) {
                if (previous.request_hash !== requestHash) throw new ConflictException('Idempotency key already used');
                return adminFreeAiGrantResultSchema.parse(previous.response_snapshot);
            }
            const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
            if (expiresAt && expiresAt <= new Date()) throw new ConflictException('Expiry must be in the future');
            const bucketId = randomUUID();
            await tx
                .insertInto('ai_buckets')
                .values({
                    id: bucketId,
                    kind: 'trial',
                    granted: input.actions,
                    balance_projection: input.actions,
                    reserved_projection: 0,
                    expires_at: expiresAt,
                    user_id: userId,
                    family_id: null,
                    quota_period_id: null,
                    order_id: null,
                })
                .execute();
            await tx
                .insertInto('ai_ledger')
                .values({
                    id: randomUUID(),
                    kind: 'grant',
                    delta: input.actions,
                    reserved_delta: 0,
                    recorded_at: new Date(),
                    idempotency_key: input.idempotencyKey,
                    bucket_id: bucketId,
                    operation_id: null,
                    compensates_id: null,
                })
                .execute();
            const response = adminFreeAiGrantResultSchema.parse({
                bucketId,
                granted: input.actions,
                balance: input.actions,
                expiresAt: expiresAt?.toISOString() ?? null,
            });
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'admin.free-ai.grant',
                    target_binding: userId,
                    key: input.idempotencyKey,
                    request_hash: requestHash,
                    status: 'completed',
                    response_snapshot: response,
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
                    action: 'admin.free-ai.granted',
                    target_type: 'user',
                    target_id: userId,
                    actor_id: actor.id,
                    scope_id: null,
                    effective_at: new Date(),
                    recorded_at: new Date(),
                    request_id: requestId,
                    reason: input.reason,
                    before_redacted: null,
                    after_redacted: { bucketId, actions: input.actions, expiresAt: response.expiresAt },
                })
                .execute();
            return response;
        });
        return result;
    }
}
