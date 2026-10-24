import {
    ConflictException,
    HttpException,
    Injectable,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { AdminAccessService } from '../admin-auth/admin-access.service.js';
import type { Principal } from '../auth/auth.service.js';
import {
    recipePolicySchema,
    recipeAllowance,
    type RecipeAction,
    type RecipePolicy,
    type recipePolicyChangeSchema,
} from './recipe-policy.contracts.js';
type Tx = Transaction<DatabaseSchema>;
const policyId = '71000000-0000-4000-8000-000000000001';
@Injectable()
export class RecipePolicyService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: AdminAccessService,
    ) {}
    private async available() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
    }
    async read(tx?: Tx): Promise<RecipePolicy> {
        if (!tx) await this.available();
        const result = await sql<RecipePolicy>`select version::integer as version,
            submission_daily_limit as "submissionDailyLimit", comment_hourly_limit as "commentHourlyLimit",
            report_daily_limit as "reportDailyLimit" from meal.recipe_policy where id=${policyId}`.execute(
            tx ?? this.database.db!,
        );
        if (!result.rows[0]) throw new ServiceUnavailableException();
        return recipePolicySchema.parse(result.rows[0]);
    }
    // Caller holds the actor lock; event insertion is in the same transaction as the accepted command.
    async assertAllowance(tx: Tx, userId: string, kind: RecipeAction): Promise<void> {
        const { limit, windowSeconds } = recipeAllowance(await this.read(tx), kind);
        const result = await sql<{ count: number }>`select count(*)::integer as count from meal.recipe_action_events
            where user_id=${userId} and kind=${kind} and occurred_at > now() - ${windowSeconds} * interval '1 second'`.execute(
            tx,
        );
        if ((result.rows[0]?.count ?? 0) >= limit)
            throw new HttpException('Лимит действий исчерпан. Попробуйте позже.', 429);
        await sql`insert into meal.recipe_action_events (id,user_id,kind) values (${randomUUID()},${userId},${kind})`.execute(
            tx,
        );
    }
    async update(actor: Principal, input: z.infer<typeof recipePolicyChangeSchema>, requestId: string) {
        await this.available();
        return this.database.transaction(async (tx) => {
            const allowed = await sql`select u.id from meal.users u join meal.sessions s on s.user_id=u.id
                where u.id=${actor.id} and u.status='active' and u.archived_at is null and u.email_verified_at is not null
                and s.id=${actor.sessionId} and s.auth_context='admin' and s.kind='staff' and s.revoked_at is null
                and s.expires_at>now() and s.mfa_verified_at is not null
                and exists(select 1 from meal.staff_role_assignments r where r.user_id=u.id and r.role='admin' and r.revoked_at is null)
                for update of u`.execute(tx);
            if (actor.context !== 'admin' || !allowed.rows.length) throw new UnauthorizedException();
            await this.access.assertCritical(tx, actor);
            await sql`select id from meal.recipe_policy where id=${policyId} for update`.execute(tx);
            const before = await this.read(tx);
            if (before.version !== input.expectedVersion) throw new ConflictException();
            await sql`update meal.recipe_policy set submission_daily_limit=${input.submissionDailyLimit},
                comment_hourly_limit=${input.commentHourlyLimit}, report_daily_limit=${input.reportDailyLimit},
                version=version+1, updated_at=now() where id=${policyId} and version=${input.expectedVersion}`.execute(
                tx,
            );
            const after = await this.read(tx);
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: 'admin.recipe_policy.updated',
                    target_type: 'recipe_policy',
                    target_id: policyId,
                    actor_id: actor.id,
                    scope_id: null,
                    effective_at: new Date(),
                    recorded_at: new Date(),
                    request_id: requestId,
                    reason: null,
                    before_redacted: before,
                    after_redacted: after,
                })
                .execute();
            return after;
        });
    }
}
