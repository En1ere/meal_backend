import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { AuthService, type Principal } from '../auth/auth.service.js';
import { newToken, tokenHash } from '../auth/crypto.js';
import { consumeFactor } from '../auth/factor.js';

type Tx = Transaction<DatabaseSchema>;
export class AdminLockedException extends ForbiddenException {}
export class AdminConfirmationRequiredException extends ForbiddenException {}
export const criticalExpiry = (now: Date, sessionExpiry: Date) =>
    new Date(Math.min(now.getTime() + 30 * 60 * 1000, sessionExpiry.getTime()));

@Injectable()
export class AdminAccessService {
    constructor(
        private readonly database: DatabaseService,
        private readonly auth: AuthService,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
    ) {}

    private async remembered(token: string | undefined) {
        const user = await this.auth.principal(token, 'staff');
        if (user.context !== 'admin') throw new ForbiddenException();
        // Only sessions issued by the dedicated portal have this marker. Legacy staff cookies cannot be copied in.
        const marker =
            await sql`select id from meal.admin_session_unlocks where session_id=${user.sessionId} limit 1`.execute(
                this.database.db!,
            );
        if (!marker.rows.length) throw new UnauthorizedException();
        return user;
    }

    private async proof(tx: Tx | NonNullable<DatabaseService['db']>, user: Principal, token: unknown) {
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
        const result = await sql`select id from meal.admin_session_unlocks
            where session_id=${user.sessionId} and token_hash=${tokenHash(token)} and expires_at>now() limit 1`.execute(
            tx,
        );
        return result.rows.length > 0;
    }

    async principal(cookie: string | undefined, proof: unknown) {
        const user = await this.remembered(cookie);
        if (!(await this.proof(this.database.db!, user, proof))) throw new AdminLockedException();
        return user;
    }

    async status(cookie: string | undefined, proof: unknown) {
        const user = await this.remembered(cookie);
        const unlocked = await this.proof(this.database.db!, user, proof);
        const row = await sql<{ admin_critical_until: Date | null }>`select admin_critical_until from meal.sessions
            where id=${user.sessionId}`.execute(this.database.db!);
        const until = row.rows[0]?.admin_critical_until;
        return {
            user,
            status: unlocked ? ('unlocked' as const) : ('locked' as const),
            criticalUntil: unlocked && until && until > new Date() ? until.toISOString() : null,
        };
    }

    // Intended for every future critical domain command INSIDE its transaction, after actor revalidation.
    async assertCritical(tx: Tx, actor: Principal) {
        const result = await sql`select id from meal.sessions where id=${actor.sessionId}
            and user_id=${actor.id} and auth_context='admin' and revoked_at is null
            and expires_at>now() and admin_critical_until>now()`.execute(tx);
        if (!result.rows.length) throw new AdminConfirmationRequiredException();
    }

    async assertAdminRole(tx: Tx, actor: Principal) {
        const role = await tx
            .selectFrom('staff_role_assignments')
            .select('id')
            .where('user_id', '=', actor.id)
            .where('role', '=', 'admin')
            .where('revoked_at', 'is', null)
            .executeTakeFirst();
        if (!role) throw new ForbiddenException();
    }

    async assertCapability(
        db: Tx | NonNullable<DatabaseService['db']>,
        actor: Principal,
        permission: 'content_releases.read' | 'content_releases.edit' | 'content_releases.validate',
    ) {
        const result =
            await sql`select 1 from meal.staff_role_assignments r where r.user_id=${actor.id}::uuid and r.role='admin' and r.revoked_at is null
            union all select 1 from meal.staff_grants g where g.user_id=${actor.id}::uuid and g.permission=${permission} and g.revoked_at is null and (g.valid_until is null or g.valid_until>now()) limit 1`.execute(
                db,
            );
        if (!result.rows.length) throw new ForbiddenException();
    }

    async verify(
        cookie: string | undefined,
        proof: unknown,
        input: { code: string; method: 'totp' | 'recovery' },
        purpose: 'unlock' | 'critical',
        ip: string,
        requestId: string,
    ) {
        const user = await this.remembered(cookie);
        await this.auth.rateLimit(`admin-${purpose}:${user.sessionId}`, ip);
        const result = await this.database.transaction(async (tx) => {
            // Lock the account before the session/factor, consistent with account factor replacement.
            const account = await tx
                .selectFrom('users')
                .select(['status', 'archived_at', 'email_verified_at', 'is_test_account'])
                .where('id', '=', user.id)
                .forUpdate()
                .executeTakeFirst();
            const session = await sql<{
                expires_at: Date;
                admin_mfa_failures: number;
                admin_critical_until: Date | null;
            }>`
                select expires_at,admin_mfa_failures,admin_critical_until from meal.sessions
                where id=${user.sessionId} and user_id=${user.id} and auth_context='admin'
                  and revoked_at is null and expires_at>now() and mfa_verified_at is not null for update`.execute(tx);
            const row = session.rows[0];
            const role = await tx
                .selectFrom('staff_role_assignments')
                .select('id')
                .where('user_id', '=', user.id)
                .where('role', '=', 'admin')
                .where('revoked_at', 'is', null)
                .executeTakeFirst();
            if (
                !row ||
                !account ||
                account.status !== 'active' ||
                account.archived_at ||
                !account.email_verified_at ||
                (this.config.NODE_ENV === 'production' && account.is_test_account) ||
                !role
            )
                throw new UnauthorizedException();
            if (purpose === 'critical' && !(await this.proof(tx, user, proof))) throw new AdminLockedException();
            const factor = await tx
                .selectFrom('mfa_factors')
                .selectAll()
                .where('user_id', '=', user.id)
                .where('kind', '=', 'totp')
                .where('revoked_at', 'is', null)
                .where('verified_at', 'is not', null)
                .forUpdate()
                .executeTakeFirst();
            if (!factor) throw new UnauthorizedException();
            const accepted =
                row.admin_mfa_failures < 5 &&
                (await consumeFactor(tx, factor, input.code, input.method, this.config.MFA_ENCRYPTION_KEY!));
            if (!accepted) {
                await sql`update meal.sessions set admin_mfa_failures=least(admin_mfa_failures+1,5),
                    revoked_at=case when admin_mfa_failures>=4 then now() else revoked_at end where id=${user.sessionId}`.execute(
                    tx,
                );
                await this.auth.audit(tx, user.id, `admin.${purpose}.rejected`, user.sessionId, requestId);
                return null;
            }
            const now = new Date();
            await sql`update meal.sessions set admin_mfa_failures=0 where id=${user.sessionId}`.execute(tx);
            await this.auth.audit(tx, user.id, `admin.${purpose}.accepted`, user.sessionId, requestId);
            if (purpose === 'critical') {
                const until = criticalExpiry(now, row.expires_at);
                await sql`update meal.sessions set admin_critical_until=${until} where id=${user.sessionId}`.execute(
                    tx,
                );
                return { criticalUntil: until.toISOString() };
            }
            const unlockToken = newToken();
            await sql`insert into meal.admin_session_unlocks(id,session_id,token_hash,expires_at)
                values(${randomUUID()},${user.sessionId},${tokenHash(unlockToken)},${row.expires_at})`.execute(tx);
            return {
                user,
                unlockToken,
                criticalUntil:
                    row.admin_critical_until && row.admin_critical_until > now
                        ? row.admin_critical_until.toISOString()
                        : null,
            };
        });
        // Failed verification commits its counter and audit before returning an error.
        if (!result) throw new UnauthorizedException();
        return result;
    }
}
