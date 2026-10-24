import { consumeFactor, regenerateRecoveryCodes } from './factor.js';
import { settleEmailChanges, hasDueEmailChange } from '../account/account-state.js';
import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { generateSecret, generateURI } from 'otplib';
import { APP_CONFIG, type AppConfig } from '../../app/config.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { encryptSecret, keyedHash, newToken, tokenHash, verifyPassword } from './crypto.js';

export type AuthContext = 'user' | 'admin' | 'moderator';
type Tx = Transaction<DatabaseSchema>;
export interface Principal {
    id: string;
    displayName: string;
    context: AuthContext;
    expiresAt: string;
    sessionId: string;
}
export interface SessionResult {
    token: string;
    principal: Principal;
    unlockToken?: string;
}

@Injectable()
export class AuthService {
    constructor(
        private readonly database: DatabaseService,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
    ) {}
    private async connection() {
        if (!this.database.db || !this.config.SECURITY_KEY || !this.config.MFA_ENCRYPTION_KEY)
            throw new ServiceUnavailableException();
        if (!(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    async audit(tx: Tx, userId: string, action: string, targetId: string, requestId: string) {
        await tx
            .insertInto('audit_events')
            .values({
                id: randomUUID(),
                action,
                target_type: 'auth',
                target_id: targetId,
                actor_id: userId,
                scope_id: null,
                effective_at: new Date(),
                recorded_at: new Date(),
                request_id: requestId,
                reason: null,
                before_redacted: null,
                after_redacted: null,
            })
            .execute();
    }
    async rateLimit(email: string, ip: string) {
        await this.connection();
        const allowed = await this.database.transaction(async (tx) => {
            let accepted = true;
            // Stable hashed keys; counts survive process restarts. No raw email/IP is persisted here.
            for (const subject of [`email:${email}`, `ip:${ip}`].sort()) {
                const key = keyedHash(this.config.SECURITY_KEY!, subject);
                const result = await sql<{ attempts: number }>`
                    insert into meal.auth_rate_limits(key_hash,window_started_at,attempts)
                    values (${key},now(),1)
                    on conflict(key_hash) do update set
                      attempts=case when meal.auth_rate_limits.window_started_at < now()-interval '1 minute'
                         then 1 else least(meal.auth_rate_limits.attempts+1,1000000) end,
                      window_started_at=case when meal.auth_rate_limits.window_started_at < now()-interval '1 minute'
                         then now() else meal.auth_rate_limits.window_started_at end
                    returning attempts
                `.execute(tx);
                if ((result.rows[0]?.attempts ?? Infinity) > this.config.AUTH_RATE_LIMIT) accepted = false;
            }
            return accepted;
        });
        if (!allowed) throw new HttpException('Rate limited', 429);
    }
    private async roleAllowed(tx: Tx, userId: string, context: AuthContext) {
        if (context === 'user') return true;
        return !!(await tx
            .selectFrom('staff_role_assignments')
            .select('id')
            .where('user_id', '=', userId)
            .where('role', '=', context)
            .where('revoked_at', 'is', null)
            .executeTakeFirst());
    }
    async issue(
        tx: Tx,
        user: { id: string; display_name: string },
        context: AuthContext,
        requestId: string,
        adminPortal = false,
    ): Promise<SessionResult> {
        if (await hasDueEmailChange(tx, user.id)) throw new UnauthorizedException();
        const token = newToken(),
            id = randomUUID(),
            now = new Date();
        const days = context === 'admin' ? (adminPortal ? 7 : 1) : context === 'moderator' ? 14 : 40;
        const expires = new Date(now.getTime() + days * 86400000);
        await tx
            .insertInto('sessions')
            .values({
                id,
                token_hash: tokenHash(token),
                kind: context === 'user' ? 'user' : 'staff',
                auth_context: context,
                user_id: user.id,
                authenticated_at: now,
                expires_at: expires,
                revoked_at: null,
                mfa_verified_at: context === 'user' ? null : now,
            })
            .execute();
        await this.audit(tx, user.id, 'auth.session.created', id, requestId);
        const unlockToken = adminPortal ? newToken() : undefined;
        if (unlockToken)
            await sql`insert into meal.admin_session_unlocks(id,session_id,token_hash,expires_at)
            values (${randomUUID()},${id},${tokenHash(unlockToken)},${expires})`.execute(tx);
        return {
            token,
            ...(unlockToken ? { unlockToken } : {}),
            principal: {
                id: user.id,
                displayName: user.display_name,
                context,
                expiresAt: expires.toISOString(),
                sessionId: id,
            },
        };
    }
    async login(
        email: string,
        password: string,
        context: AuthContext,
        ip: string,
        requestId: string,
        adminPortal = false,
    ) {
        const db = await this.connection();
        await this.rateLimit(email, ip);
        if (!adminPortal) await this.database.transaction((tx) => settleEmailChanges(tx, email));
        const candidate = await db
            .selectFrom('users')
            .innerJoin('password_credentials', 'password_credentials.user_id', 'users.id')
            .select(['users.id', 'password_credentials.password_hash'])
            .where(adminPortal ? sql<string>`lower(users.login)` : sql<string>`users.email_normalized`, '=', email)
            .executeTakeFirst();
        const valid = await verifyPassword(password, candidate?.password_hash);
        if (!candidate || !valid) throw new UnauthorizedException();
        if (adminPortal) await this.database.transaction((tx) => settleEmailChanges(tx, candidate.id));
        return this.database.transaction(async (tx) => {
            const user = await tx
                .selectFrom('users')
                .select([
                    'id',
                    'display_name',
                    'status',
                    'email_verified_at',
                    'email_normalized',
                    'login',
                    'is_test_account',
                ])
                .where('id', '=', candidate.id)
                .forUpdate()
                .executeTakeFirstOrThrow();
            const credentials = await tx
                .selectFrom('password_credentials')
                .select('password_hash')
                .where('user_id', '=', user.id)
                .executeTakeFirst();
            if (
                (this.config.NODE_ENV === 'production' && user.is_test_account) ||
                user.status !== 'active' ||
                (adminPortal ? user.login.toLowerCase() : user.email_normalized) !== email ||
                !user.email_verified_at ||
                credentials?.password_hash !== candidate.password_hash ||
                !(await this.roleAllowed(tx, user.id, context))
            )
                throw new UnauthorizedException();
            if (context === 'user')
                return { status: 'authenticated' as const, session: await this.issue(tx, user, context, requestId) };
            const activeFactor = await tx
                .selectFrom('mfa_factors')
                .select(['id'])
                .where('user_id', '=', user.id)
                .where('kind', '=', 'totp')
                .where('revoked_at', 'is', null)
                .where('verified_at', 'is not', null)
                .executeTakeFirst();
            const challengeToken = newToken(),
                challengeId = randomUUID(),
                now = new Date();
            let enrollment: { secret: string; uri: string } | null = null;
            let factorId = activeFactor?.id;
            if (!factorId) {
                await tx
                    .updateTable('mfa_factors')
                    .set({ revoked_at: now })
                    .where('user_id', '=', user.id)
                    .where('verified_at', 'is', null)
                    .where('revoked_at', 'is', null)
                    .execute();
                factorId = randomUUID();
                const secret = generateSecret();
                await tx
                    .insertInto('mfa_factors')
                    .values({
                        id: factorId,
                        user_id: user.id,
                        kind: 'totp',
                        secret_ciphertext: encryptSecret(secret, this.config.MFA_ENCRYPTION_KEY!, factorId),
                        verified_at: null,
                        revoked_at: null,
                        last_accepted_step: null,
                    })
                    .execute();
                enrollment = {
                    secret,
                    uri: generateURI({
                        secret,
                        issuer: 'Meal Planner',
                        label: user.email_normalized,
                        digits: 6,
                        period: 30,
                    }),
                };
            }
            // One outstanding staff login challenge per user. An old challenge cannot complete enrollment later.
            await tx
                .updateTable('auth_challenges')
                .set({ revoked_at: now })
                .where('user_id', '=', user.id)
                .where('purpose', '=', adminPortal ? 'admin_login' : 'staff_login')
                .where('used_at', 'is', null)
                .where('revoked_at', 'is', null)
                .execute();
            await tx
                .insertInto('auth_challenges')
                .values({
                    id: challengeId,
                    user_id: user.id,
                    session_id: null,
                    purpose: adminPortal ? 'admin_login' : 'staff_login',
                    token_hash: tokenHash(challengeToken),
                    expires_at: new Date(now.getTime() + 600000),
                    used_at: null,
                    operation_digest: null,
                    attempts: 0,
                    auth_context: context,
                    factor_id: factorId,
                    revoked_at: null,
                })
                .execute();
            await this.audit(tx, user.id, 'auth.mfa.challenge.created', challengeId, requestId);
            return {
                status: 'mfa_required' as const,
                challenge: challengeToken,
                expiresAt: new Date(now.getTime() + 600000).toISOString(),
                enrollment,
            };
        });
    }
    async completeMfa(
        challengeToken: string,
        code: string,
        method: 'totp' | 'recovery',
        requestId: string,
        expectedContext?: 'admin' | 'moderator',
    ) {
        await this.connection();
        const result = await this.database.transaction(async (tx) => {
            const challenge = await tx
                .selectFrom('auth_challenges')
                .selectAll()
                .where('token_hash', '=', tokenHash(challengeToken))
                .forUpdate()
                .executeTakeFirst();
            const now = new Date();
            if (
                !challenge ||
                challenge.purpose !== (expectedContext === 'admin' ? 'admin_login' : 'staff_login') ||
                !challenge.user_id ||
                !challenge.factor_id ||
                challenge.used_at ||
                challenge.revoked_at ||
                challenge.expires_at <= now ||
                (challenge.attempts ?? 0) >= 5 ||
                !['admin', 'moderator'].includes(challenge.auth_context ?? '') ||
                (expectedContext !== undefined && challenge.auth_context !== expectedContext)
            )
                return null;
            const context = challenge.auth_context as 'admin' | 'moderator';
            const user = await tx
                .selectFrom('users')
                .select(['id', 'display_name', 'status', 'email_verified_at', 'is_test_account'])
                .where('id', '=', challenge.user_id)
                .forUpdate()
                .executeTakeFirstOrThrow();
            if (
                (this.config.NODE_ENV === 'production' && user.is_test_account) ||
                user.status !== 'active' ||
                !user.email_verified_at ||
                !(await this.roleAllowed(tx, user.id, context))
            )
                return null;
            const factor = await tx
                .selectFrom('mfa_factors')
                .selectAll()
                .where('id', '=', challenge.factor_id)
                .where('user_id', '=', user.id)
                .where('revoked_at', 'is', null)
                .forUpdate()
                .executeTakeFirst();
            if (!factor) return null;
            const accepted = await consumeFactor(tx, factor, code, method, this.config.MFA_ENCRYPTION_KEY!, true);
            await tx
                .updateTable('auth_challenges')
                .set({ attempts: (challenge.attempts ?? 0) + 1, ...(accepted ? { used_at: now } : {}) })
                .where('id', '=', challenge.id)
                .execute();
            await this.audit(
                tx,
                user.id,
                accepted ? 'auth.mfa.accepted' : 'auth.mfa.rejected',
                challenge.id,
                requestId,
            );
            if (!accepted) return null; // Commit failed attempt before controller throws.
            const recoveryCodes = !factor.verified_at ? await regenerateRecoveryCodes(tx, factor.id) : [];
            return {
                session: await this.issue(tx, user, context, requestId, expectedContext === 'admin'),
                recoveryCodes,
            };
        });
        if (!result) throw new UnauthorizedException();
        return result;
    }
    async principal(token: string | undefined, expected: 'user' | 'staff'): Promise<Principal> {
        const db = await this.connection();
        if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedException();
        const owner = await db
            .selectFrom('sessions')
            .select('user_id')
            .where('token_hash', '=', tokenHash(token))
            .where('kind', '=', expected)
            .executeTakeFirst();
        if (owner) await this.database.transaction((tx) => settleEmailChanges(tx, owner.user_id));
        const row = await db
            .selectFrom('sessions')
            .innerJoin('users', 'users.id', 'sessions.user_id')
            .select([
                'sessions.id as sessionId',
                'sessions.auth_context',
                'sessions.expires_at',
                'sessions.mfa_verified_at',
                'users.id',
                'users.display_name',
                'users.is_test_account',
            ])
            .where('sessions.token_hash', '=', tokenHash(token))
            .where('sessions.kind', '=', expected)
            .where('sessions.revoked_at', 'is', null)
            .where('sessions.expires_at', '>', new Date())
            .where('users.status', '=', 'active')
            .where('users.email_verified_at', 'is not', null)
            .executeTakeFirst();
        if (
            !row ||
            (this.config.NODE_ENV === 'production' && row.is_test_account) ||
            !row.auth_context ||
            (expected === 'user' && row.auth_context !== 'user')
        )
            throw new UnauthorizedException();
        if (expected === 'staff') {
            if (!row.mfa_verified_at || !['admin', 'moderator'].includes(row.auth_context))
                throw new UnauthorizedException();
            const role = await db
                .selectFrom('staff_role_assignments')
                .select('id')
                .where('user_id', '=', row.id)
                .where('role', '=', row.auth_context)
                .where('revoked_at', 'is', null)
                .executeTakeFirst();
            const factor = await db
                .selectFrom('mfa_factors')
                .select('id')
                .where('user_id', '=', row.id)
                .where('verified_at', 'is not', null)
                .where('revoked_at', 'is', null)
                .where('kind', '=', 'totp')
                .executeTakeFirst();
            if (!role || !factor) throw new UnauthorizedException();
        }
        return {
            id: row.id,
            displayName: row.display_name,
            context: row.auth_context,
            expiresAt: row.expires_at.toISOString(),
            sessionId: row.sessionId,
        };
    }
    async logout(token: string | undefined, kind: 'user' | 'staff', requestId: string): Promise<void> {
        await this.connection();
        if (!token) return;
        await this.database.transaction(async (tx) => {
            const row = await tx
                .updateTable('sessions')
                .set({ revoked_at: new Date() })
                .where('token_hash', '=', tokenHash(token))
                .where('kind', '=', kind)
                .where('revoked_at', 'is', null)
                .returning(['id', 'user_id'])
                .executeTakeFirst();
            if (row) {
                await tx
                    .updateTable('auth_challenges')
                    .set({ revoked_at: new Date() })
                    .where('session_id', '=', row.id)
                    .where('revoked_at', 'is', null)
                    .execute();
                await this.audit(tx, row.user_id, 'auth.session.revoked', row.id, requestId);
            }
        });
    }

    async listSessions(token: string | undefined, kind: 'user' | 'staff') {
        const current = await this.principal(token, kind);
        const db = await this.connection();
        const rows = await db
            .selectFrom('sessions')
            .select(['id', 'auth_context', 'authenticated_at', 'expires_at'])
            .where('user_id', '=', current.id)
            .where('kind', '=', kind)
            .where('auth_context', '=', current.context)
            .where('revoked_at', 'is', null)
            .where('expires_at', '>', new Date())
            .orderBy('authenticated_at', 'desc')
            .execute();
        return {
            sessions: rows.map((row) => ({
                id: row.id,
                context: row.auth_context,
                authenticatedAt: row.authenticated_at.toISOString(),
                expiresAt: row.expires_at.toISOString(),
                current: row.id === current.sessionId,
            })),
        };
    }

    async revokeOtherSessions(token: string | undefined, kind: 'user' | 'staff', requestId: string) {
        await this.connection();
        if (!token) throw new UnauthorizedException();
        return this.database.transaction(async (tx) => {
            const session = await tx
                .selectFrom('sessions')
                .selectAll()
                .where('token_hash', '=', tokenHash(token))
                .where('kind', '=', kind)
                .where('revoked_at', 'is', null)
                .where('expires_at', '>', new Date())
                .forUpdate()
                .executeTakeFirst();
            if (
                !session?.auth_context ||
                (kind === 'user' && session.auth_context !== 'user') ||
                (kind === 'staff' && (session.auth_context === 'user' || !session.mfa_verified_at))
            )
                throw new UnauthorizedException();
            const user = await tx
                .selectFrom('users')
                .select(['status', 'email_verified_at', 'is_test_account'])
                .where('id', '=', session.user_id)
                .forUpdate()
                .executeTakeFirst();
            if (
                !user ||
                user.status !== 'active' ||
                !user.email_verified_at ||
                !(await this.roleAllowed(tx, session.user_id, session.auth_context))
            )
                throw new UnauthorizedException();
            if (kind === 'staff') {
                const factor = await tx
                    .selectFrom('mfa_factors')
                    .select('id')
                    .where('user_id', '=', session.user_id)
                    .where('kind', '=', 'totp')
                    .where('verified_at', 'is not', null)
                    .where('revoked_at', 'is', null)
                    .executeTakeFirst();
                if (!factor) throw new UnauthorizedException();
            }
            const now = new Date();
            const revoked = await tx
                .updateTable('sessions')
                .set({ revoked_at: now })
                .where('user_id', '=', session.user_id)
                .where('kind', '=', kind)
                .where('auth_context', '=', session.auth_context)
                .where('id', '!=', session.id)
                .where('revoked_at', 'is', null)
                .returning('id')
                .execute();
            if (revoked.length)
                await tx
                    .updateTable('auth_challenges')
                    .set({ revoked_at: now })
                    .where(
                        'session_id',
                        'in',
                        revoked.map((row) => row.id),
                    )
                    .where('revoked_at', 'is', null)
                    .execute();
            await this.audit(tx, session.user_id, 'auth.sessions.others_revoked', session.id, requestId);
            return { revokedCount: revoked.length };
        });
    }
}
