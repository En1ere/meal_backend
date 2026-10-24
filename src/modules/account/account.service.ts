import {
    BadRequestException,
    ConflictException,
    HttpException,
    Inject,
    Injectable,
    Optional,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { generateSecret, generateURI } from 'otplib';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../app/config.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { AuthService } from '../auth/auth.service.js';
import {
    decryptSecret,
    encryptSecret,
    hashPassword,
    keyedHash,
    newToken,
    tokenHash,
    verifyPassword,
} from '../auth/crypto.js';
import { consumeFactor, regenerateRecoveryCodes } from '../auth/factor.js';
import { accountInputs } from './account.contracts.js';
import { revokeAccountAccess, settleEmailChanges, hasDueEmailChange, type AccountTx } from './account-state.js';
import { RegistrationRiskPolicy } from './registration-risk.policy.js';
import { LegalConsentService } from '../legal-consents/legal-consent.service.js';
import {
    ACCOUNT_MAIL_OUTBOX,
    accountMailMessageSchema,
    resolveAccountMailRuntime,
    type AccountMailOutbox,
} from './account-mail.outbox.js';

type TokenKind = 'verify' | 'reset' | 'email-confirm' | 'email-cancel';
type MailToken = {
    id: string;
    user_id: string;
    kind: TokenKind;
    token_ciphertext: string;
    email_target: string;
    change_id: string | null;
    created_at: Date;
    expires_at: Date;
    used_at: Date | null;
    revoked_at: Date | null;
};
type Proof = { method: 'totp' | 'recovery'; code: string };
@Injectable()
export class AccountService {
    constructor(
        private readonly database: DatabaseService,
        private readonly auth: AuthService,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
        @Optional() private readonly registrationRisk?: RegistrationRiskPolicy,
        @Optional() private readonly legalConsents?: LegalConsentService,
        @Inject(ACCOUNT_MAIL_OUTBOX) @Optional() private readonly accountMailOutbox?: AccountMailOutbox,
    ) {}
    private async ready() {
        if (
            !this.database.db ||
            !this.config.SECURITY_KEY ||
            !this.config.MFA_ENCRYPTION_KEY ||
            !(await this.database.ready())
        )
            throw new ServiceUnavailableException();
        return this.database.db;
    }
    private developmentMailboxOnly() {
        if (this.config.NODE_ENV === 'production')
            throw new ServiceUnavailableException('Development mailbox is unavailable');
    }
    private requireMailOutbox() {
        return resolveAccountMailRuntime(this.config.NODE_ENV, this.accountMailOutbox);
    }
    private async user(tx: AccountTx, userId: string, verified = true) {
        const user = await tx.selectFrom('users').selectAll().where('id', '=', userId).forUpdate().executeTakeFirst();
        if (
            !user ||
            user.status !== 'active' ||
            user.archived_at ||
            (verified && !user.email_verified_at) ||
            (this.config.NODE_ENV === 'production' && user.is_test_account)
        )
            throw new UnauthorizedException();
        if (await hasDueEmailChange(tx, userId)) throw new UnauthorizedException();
        return user;
    }
    private async actor(tx: AccountTx, token: string | undefined) {
        if (!token) throw new UnauthorizedException();
        const session = await tx
            .selectFrom('sessions')
            .selectAll()
            .where('token_hash', '=', tokenHash(token))
            .where('kind', '=', 'user')
            .where('auth_context', '=', 'user')
            .where('revoked_at', 'is', null)
            .where('expires_at', '>', new Date())
            .forUpdate()
            .executeTakeFirst();
        if (!session) throw new UnauthorizedException();
        const user = await this.user(tx, session.user_id);
        const due =
            await sql`select id from meal.account_email_changes where user_id=${user.id}::uuid and cancelled_at is null and applied_at is null and effective_at<=now()`.execute(
                tx,
            );
        if (due.rows.length) throw new UnauthorizedException();
        return { user, session };
    }
    private async password(tx: AccountTx, userId: string, value: string) {
        const credential = await tx
            .selectFrom('password_credentials')
            .select('password_hash')
            .where('user_id', '=', userId)
            .executeTakeFirst();
        if (!(await verifyPassword(value, credential?.password_hash))) throw new UnauthorizedException();
    }
    private async factor(tx: AccountTx, userId: string) {
        return tx
            .selectFrom('mfa_factors')
            .selectAll()
            .where('user_id', '=', userId)
            .where('kind', '=', 'totp')
            .where('verified_at', 'is not', null)
            .where('revoked_at', 'is', null)
            .forUpdate()
            .executeTakeFirst();
    }
    private async mailLimit(email: string, ip: string) {
        await this.ready();
        const allowed = await this.database.transaction(async (tx) => {
            let accepted = true;
            for (const [subject, seconds, max] of [
                [`mail:email:${email}`, 900, 5],
                [`mail:ip:${ip}`, 900, 5],
                [`mail:cooldown:${email}`, 60, 1],
            ] as const) {
                const key = keyedHash(this.config.SECURITY_KEY!, subject);
                const r = await sql<{
                    attempts: number;
                }>`insert into meal.auth_rate_limits(key_hash,window_started_at,attempts) values(${key},now(),1)
                  on conflict(key_hash) do update set attempts=case when meal.auth_rate_limits.window_started_at<=now()-${seconds}*interval '1 second' then 1 else least(meal.auth_rate_limits.attempts+1,1000000) end,
                  window_started_at=case when meal.auth_rate_limits.window_started_at<=now()-${seconds}*interval '1 second' then now() else meal.auth_rate_limits.window_started_at end returning attempts`.execute(
                    tx,
                );
                if ((r.rows[0]?.attempts ?? Infinity) > max) accepted = false;
            }
            return accepted;
        });
        if (!allowed) throw new HttpException('Rate limited', 429);
    }
    private async mail(
        tx: AccountTx,
        userId: string,
        email: string,
        kind: TokenKind,
        minutes: number,
        changeId: string | null = null,
    ) {
        await sql`update meal.account_tokens set revoked_at=now() where user_id=${userId}::uuid and kind=${kind} and used_at is null and revoked_at is null`.execute(
            tx,
        );
        const id = randomUUID(),
            token = newToken(),
            expires = new Date(Date.now() + minutes * 60000);
        await sql`insert into meal.account_tokens(id,user_id,kind,token_hash,token_ciphertext,email_target,change_id,expires_at)
          values(${id}::uuid,${userId}::uuid,${kind},${tokenHash(token)},${encryptSecret(token, this.config.MFA_ENCRYPTION_KEY!, id)},${email},${changeId}::uuid,${expires})`.execute(
            tx,
        );
        if (this.config.NODE_ENV === 'production') {
            this.requireMailOutbox();
            await this.accountMailOutbox!.enqueue(
                tx,
                accountMailMessageSchema.parse({
                    eventId: randomUUID(),
                    accountTokenId: id,
                    userId,
                    recipient: email,
                    kind,
                    changeId,
                    expiresAt: expires.toISOString(),
                }),
            );
        }
    }
    private async token(tx: AccountTx, value: string, kind: TokenKind) {
        const result =
            await sql<MailToken>`select * from meal.account_tokens where token_hash=${tokenHash(value)} and kind=${kind} for update`.execute(
                tx,
            );
        const token = result.rows[0];
        if (!token || token.used_at || token.revoked_at || token.expires_at <= new Date())
            throw new BadRequestException();
        return token;
    }
    private async useToken(tx: AccountTx, id: string) {
        await sql`update meal.account_tokens set used_at=now() where id=${id}::uuid`.execute(tx);
    }
    async register(input: z.infer<typeof accountInputs.register>, ip: string, requestId: string) {
        this.developmentMailboxOnly();
        await this.mailLimit(input.email, ip);
        const risk = this.registrationRisk
            ? await this.registrationRisk.evaluate({ email: input.email, ip })
            : ({ allowed: true, reason: 'disabled' } as const);
        if (!risk.allowed) {
            if (risk.reason === 'provider_unavailable')
                throw new ServiceUnavailableException('Registration risk provider unavailable');
            throw new BadRequestException('Registration was rejected by the risk policy');
        }
        const passwordHash = await hashPassword(input.password);
        try {
            await this.database.transaction(async (tx) => {
                await settleEmailChanges(tx, input.email);
                const duplicate = await tx
                    .selectFrom('users')
                    .select('id')
                    .where('email_normalized', '=', input.email)
                    .executeTakeFirst();
                if (duplicate) return;
                const reserved =
                    await sql`select id from meal.account_email_changes where new_email=${input.email} and applied_at is null and cancelled_at is null`.execute(
                        tx,
                    );
                if (reserved.rows.length) return;
                const username = await sql`select id from meal.users where lower(login)=${input.username}`.execute(tx);
                if (username.rows.length) throw new ConflictException();
                const id = randomUUID();
                await tx
                    .insertInto('users')
                    .values({
                        id,
                        login: input.username,
                        display_name: input.displayName,
                        email_normalized: input.email,
                        status: 'active',
                        archived_at: null,
                        email_verified_at: null,
                        is_test_account: true,
                    })
                    .execute();
                await tx
                    .insertInto('password_credentials')
                    .values({ id: randomUUID(), user_id: id, password_hash: passwordHash, changed_at: new Date() })
                    .execute();
                await this.mail(tx, id, input.email, 'verify', 1440);
                await this.auth.audit(tx, id, 'account.development_registered', id, requestId);
            });
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === '23505') throw new ConflictException();
            throw error;
        }
        return { accepted: true as const };
    }
    async registerV2(input: z.infer<typeof accountInputs.registerV2>, ip: string, requestId: string) {
        if (!this.legalConsents) throw new ServiceUnavailableException('Legal consent service unavailable');
        const mailRuntime = this.requireMailOutbox();
        await this.mailLimit(input.email, ip);
        const risk = this.registrationRisk
            ? await this.registrationRisk.evaluate({ email: input.email, ip })
            : ({ allowed: true, reason: 'disabled' } as const);
        if (!risk.allowed) {
            if (risk.reason === 'provider_unavailable')
                throw new ServiceUnavailableException('Registration risk provider unavailable');
            throw new BadRequestException('Registration was rejected by the risk policy');
        }
        const passwordHash = await hashPassword(input.password);
        try {
            await this.database.transaction(async (tx) => {
                await this.legalConsents!.validateDocument('offer', input.legal.offerAcceptance.document, tx);
                await this.legalConsents!.validateDocument(
                    'privacy_notice',
                    input.legal.privacyAcknowledgement.document,
                    tx,
                );
                await settleEmailChanges(tx, input.email);
                const duplicate = await tx
                    .selectFrom('users')
                    .select('id')
                    .where('email_normalized', '=', input.email)
                    .executeTakeFirst();
                if (duplicate) return;
                const reserved =
                    await sql`select id from meal.account_email_changes where new_email=${input.email} and applied_at is null and cancelled_at is null`.execute(
                        tx,
                    );
                if (reserved.rows.length) return;
                const username = await sql`select id from meal.users where lower(login)=${input.username}`.execute(tx);
                if (username.rows.length) throw new ConflictException();
                const id = randomUUID();
                await tx
                    .insertInto('users')
                    .values({
                        id,
                        login: input.username,
                        display_name: input.displayName,
                        email_normalized: input.email,
                        status: 'active',
                        archived_at: null,
                        email_verified_at: null,
                        is_test_account: mailRuntime.isTestAccount,
                    })
                    .execute();
                await tx
                    .insertInto('password_credentials')
                    .values({ id: randomUUID(), user_id: id, password_hash: passwordHash, changed_at: new Date() })
                    .execute();
                await this.legalConsents!.recordRegistrationEvidence(tx, id, input.legal, requestId);
                await this.mail(tx, id, input.email, 'verify', 1440);
                await this.auth.audit(
                    tx,
                    id,
                    this.config.NODE_ENV === 'production'
                        ? 'account.registered_v2'
                        : 'account.development_registered_v2',
                    id,
                    requestId,
                );
            });
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === '23505') throw new ConflictException();
            throw error;
        }
        return { accepted: true as const };
    }
    async sendMail(email: string, ip: string, kind: 'verify' | 'reset') {
        this.requireMailOutbox();
        await this.mailLimit(email, ip);
        await this.database.transaction(async (tx) => {
            await settleEmailChanges(tx, email);
            const candidate = await tx
                .selectFrom('users')
                .select('id')
                .where('email_normalized', '=', email)
                .where('status', '=', 'active')
                .where('archived_at', 'is', null)
                .executeTakeFirst();
            if (!candidate) return;
            const user = await this.user(tx, candidate.id, false);
            if (kind === 'verify' ? !!user.email_verified_at : !user.email_verified_at) return;
            await this.mail(tx, user.id, email, kind, kind === 'verify' ? 1440 : 30);
        });
        return { accepted: true as const };
    }
    async verifyEmail(value: string, requestId: string) {
        await this.ready();
        await this.database.transaction(async (tx) => {
            const token = await this.token(tx, value, 'verify');
            const user = await this.user(tx, token.user_id, false);
            if (user.email_normalized !== token.email_target || user.email_verified_at) throw new BadRequestException();
            await tx.updateTable('users').set({ email_verified_at: new Date() }).where('id', '=', user.id).execute();
            await this.useToken(tx, token.id);
            await this.auth.audit(tx, user.id, 'account.email.verified', user.id, requestId);
        });
        return { verified: true as const };
    }
    async resetCheck(value: string) {
        await this.ready();
        await this.database.transaction(async (tx) => {
            const t = await this.token(tx, value, 'reset');
            const u = await this.user(tx, t.user_id);
            if (u.email_normalized !== t.email_target) throw new BadRequestException();
        });
        return { valid: true as const };
    }
    private async changeSecret(tx: AccountTx, userId: string, passwordHash: string, requestId: string) {
        await tx
            .updateTable('password_credentials')
            .set({ password_hash: passwordHash, changed_at: new Date() })
            .where('user_id', '=', userId)
            .execute();
        await revokeAccountAccess(tx, userId);
        await sql`update meal.account_tokens set revoked_at=now() where user_id=${userId}::uuid and used_at is null and revoked_at is null`.execute(
            tx,
        );
        await sql`update meal.account_email_changes set cancelled_at=now() where user_id=${userId}::uuid and applied_at is null and cancelled_at is null`.execute(
            tx,
        );
        await this.auth.audit(tx, userId, 'account.password.changed', userId, requestId);
    }
    async reset(value: string, password: string, ip: string, requestId: string) {
        await this.ready();
        await this.auth.rateLimit(`reset:${tokenHash(value)}`, ip);
        await this.resetCheck(value);
        const hash = await hashPassword(password);
        await this.database.transaction(async (tx) => {
            const token = await this.token(tx, value, 'reset');
            const user = await this.user(tx, token.user_id);
            if (user.email_normalized !== token.email_target) throw new BadRequestException();
            await this.useToken(tx, token.id);
            await this.changeSecret(tx, user.id, hash, requestId);
        });
        return { changed: true as const };
    }
    async passwordChange(
        sessionToken: string | undefined,
        currentPassword: string,
        password: string,
        ip: string,
        requestId: string,
    ) {
        await this.auth.principal(sessionToken, 'user');
        await this.ready();
        await this.auth.rateLimit(`session:${tokenHash(sessionToken ?? '')}`, ip);
        const hash = await hashPassword(password);
        await this.database.transaction(async (tx) => {
            const { user } = await this.actor(tx, sessionToken);
            await this.password(tx, user.id, currentPassword);
            await this.changeSecret(tx, user.id, hash, requestId);
        });
        return { changed: true as const };
    }
    async emailChange(
        sessionToken: string | undefined,
        email: string,
        password: string,
        ip: string,
        requestId: string,
    ) {
        this.requireMailOutbox();
        await this.auth.principal(sessionToken, 'user');
        await this.mailLimit(email, ip);
        try {
            await this.database.transaction(async (tx) => {
                await settleEmailChanges(tx, email);
                const { user } = await this.actor(tx, sessionToken);
                await this.password(tx, user.id, password);
                if (user.email_normalized === email) throw new BadRequestException();
                const taken = await tx
                    .selectFrom('users')
                    .select('id')
                    .where('email_normalized', '=', email)
                    .executeTakeFirst();
                if (taken) throw new ConflictException();
                await sql`update meal.account_email_changes set cancelled_at=now() where user_id=${user.id}::uuid and cancelled_at is null and applied_at is null`.execute(
                    tx,
                );
                const id = randomUUID();
                await sql`insert into meal.account_email_changes(id,user_id,old_email,new_email) values(${id}::uuid,${user.id}::uuid,${user.email_normalized},${email})`.execute(
                    tx,
                );
                await this.mail(tx, user.id, email, 'email-confirm', 1440, id);
                await this.mail(tx, user.id, user.email_normalized, 'email-cancel', 2880, id);
                await this.auth.audit(tx, user.id, 'account.email_change.requested', id, requestId);
            });
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === '23505') throw new ConflictException();
            throw error;
        }
        return { accepted: true as const };
    }
    async emailToken(value: string, cancel: boolean, requestId: string) {
        await this.ready();
        return this.database.transaction(async (tx) => {
            const token = await this.token(tx, value, cancel ? 'email-cancel' : 'email-confirm');
            await this.user(tx, token.user_id);
            const change = (
                await sql<{
                    id: string;
                    confirmed_at: Date | null;
                    effective_at: Date | null;
                }>`select id,confirmed_at,effective_at from meal.account_email_changes where id=${token.change_id}::uuid and user_id=${token.user_id}::uuid and cancelled_at is null and applied_at is null for update`.execute(
                    tx,
                )
            ).rows[0];
            if (
                !change ||
                (change.effective_at && change.effective_at <= new Date()) ||
                (!cancel && change.confirmed_at)
            )
                throw new BadRequestException();
            await this.useToken(tx, token.id);
            await this.auth.audit(
                tx,
                token.user_id,
                cancel ? 'account.email_change.cancelled' : 'account.email_change.confirmed',
                change.id,
                requestId,
            );
            if (cancel) {
                await sql`update meal.account_email_changes set cancelled_at=now() where id=${change.id}::uuid`.execute(
                    tx,
                );
                await sql`update meal.account_tokens set revoked_at=now() where change_id=${change.id}::uuid and used_at is null`.execute(
                    tx,
                );
                return { cancelled: true as const };
            }
            const result = await sql<{
                effective_at: Date;
            }>`update meal.account_email_changes set confirmed_at=now(),effective_at=now()+interval '24 hours' where id=${change.id}::uuid returning effective_at`.execute(
                tx,
            );
            return { confirmed: true as const, effectiveAt: result.rows[0]!.effective_at.toISOString() };
        });
    }
    async totpLogin(email: string, code: string, ip: string, requestId: string) {
        await this.ready();
        await this.auth.rateLimit(email, ip);
        await this.database.transaction((tx) => settleEmailChanges(tx, email));
        const result = await this.database.transaction(async (tx) => {
            const candidate = await tx
                .selectFrom('users')
                .select('id')
                .where('email_normalized', '=', email)
                .executeTakeFirst();
            if (!candidate) return null;
            const user = await this.user(tx, candidate.id);
            if (user.email_normalized !== email) return null;
            const factor = await this.factor(tx, user.id);
            if (!factor || !(await consumeFactor(tx, factor, code, 'totp', this.config.MFA_ENCRYPTION_KEY!)))
                return null;
            return this.auth.issue(tx, user, 'user', requestId);
        });
        if (!result) throw new UnauthorizedException();
        return result;
    }
    async pinSetup(
        sessionToken: string | undefined,
        deviceToken: string | undefined,
        password: string,
        pin: string,
        ip: string,
        requestId: string,
    ) {
        await this.auth.principal(sessionToken, 'user');
        await this.ready();
        await this.auth.rateLimit(`session:${tokenHash(sessionToken ?? '')}`, ip);
        const hash = await hashPassword(pin),
            token = newToken(),
            expiresAt = new Date(Date.now() + this.config.PIN_TRUST_DAYS * 86400000);
        await this.database.transaction(async (tx) => {
            const { user } = await this.actor(tx, sessionToken);
            await this.password(tx, user.id, password);
            if (deviceToken)
                await sql`update meal.account_devices set revoked_at=now() where device_hash=${tokenHash(deviceToken)} and revoked_at is null`.execute(
                    tx,
                );
            const id = randomUUID();
            await sql`insert into meal.account_devices(id,user_id,device_hash,pin_hash,expires_at) values(${id}::uuid,${user.id}::uuid,${tokenHash(token)},${hash},${expiresAt})`.execute(
                tx,
            );
            await this.auth.audit(tx, user.id, 'account.pin.enabled', id, requestId);
        });
        return { token, expiresAt };
    }
    async pinLogin(deviceToken: string | undefined, pin: string, ip: string, requestId: string) {
        await this.ready();
        await this.auth.rateLimit(`device:${tokenHash(deviceToken ?? '')}`, ip);
        const owner = (
            await sql<{
                user_id: string;
            }>`select user_id from meal.account_devices where device_hash=${tokenHash(deviceToken ?? '')} and revoked_at is null and expires_at>now()`.execute(
                this.database.db!,
            )
        ).rows[0];
        if (owner) await this.database.transaction((tx) => settleEmailChanges(tx, owner.user_id));
        const result = await this.database.transaction(async (tx) => {
            const device = (
                await sql<{
                    id: string;
                    user_id: string;
                    pin_hash: string;
                    attempts: number;
                    expires_at: Date;
                }>`select id,user_id,pin_hash,attempts,expires_at from meal.account_devices where device_hash=${tokenHash(deviceToken ?? '')} and revoked_at is null for update`.execute(
                    tx,
                )
            ).rows[0];
            if (!device) {
                await verifyPassword(pin);
                return null;
            }
            if (device.expires_at <= new Date()) {
                await sql`update meal.account_devices set revoked_at=now() where id=${device.id}::uuid`.execute(tx);
                await this.auth.audit(tx, device.user_id, 'account.pin.expired', device.id, requestId);
                return null;
            }
            const user = await this.user(tx, device.user_id);
            if (device.attempts >= 5) return null;
            if (!(await verifyPassword(pin, device.pin_hash))) {
                await sql`update meal.account_devices set attempts=attempts+1,revoked_at=case when attempts>=4 then now() else null end where id=${device.id}::uuid`.execute(
                    tx,
                );
                return null;
            }
            await sql`update meal.account_devices set attempts=0 where id=${device.id}::uuid`.execute(tx);
            return this.auth.issue(tx, user, 'user', requestId);
        });
        if (!result) throw new UnauthorizedException();
        return result;
    }
    async pinRevoke(sessionToken: string | undefined, deviceToken: string | undefined, requestId: string) {
        await this.auth.principal(sessionToken, 'user');
        await this.database.transaction(async (tx) => {
            const { user } = await this.actor(tx, sessionToken);
            await sql`update meal.account_devices set revoked_at=now() where device_hash=${tokenHash(deviceToken ?? '')} and user_id=${user.id}::uuid and revoked_at is null`.execute(
                tx,
            );
            await this.auth.audit(tx, user.id, 'account.pin.revoked', user.id, requestId);
        });
        return { revoked: true as const };
    }
    async security(sessionToken: string | undefined, deviceToken: string | undefined) {
        const principal = await this.auth.principal(sessionToken, 'user');
        return this.database.transaction(async (tx) => {
            const { user } = await this.actor(tx, sessionToken);
            if (user.id !== principal.id) throw new UnauthorizedException();
            const factor = await this.factor(tx, user.id);
            const device =
                await sql`select id from meal.account_devices where user_id=${user.id}::uuid and device_hash=${tokenHash(deviceToken ?? '')} and revoked_at is null and expires_at>now()`.execute(
                    tx,
                );
            const change = (
                await sql<{
                    new_email: string;
                    effective_at: Date | null;
                    confirmed_at: Date | null;
                }>`select new_email,effective_at,confirmed_at from meal.account_email_changes where user_id=${user.id}::uuid and cancelled_at is null and applied_at is null`.execute(
                    tx,
                )
            ).rows[0];
            return {
                authenticatorEnabled: !!factor,
                pinEnabled: device.rows.length > 0,
                pendingEmail: change
                    ? {
                          email: change.new_email,
                          effectiveAt: change.effective_at?.toISOString() ?? null,
                          confirmed: !!change.confirmed_at,
                      }
                    : null,
            };
        });
    }
    async authenticatorSetup(
        sessionToken: string | undefined,
        password: string,
        proof: Proof | undefined,
        ip: string,
        requestId: string,
    ) {
        await this.auth.principal(sessionToken, 'user');
        await this.ready();
        await this.auth.rateLimit(`session:${tokenHash(sessionToken ?? '')}`, ip);
        return this.database.transaction(async (tx) => {
            const { user, session } = await this.actor(tx, sessionToken);
            await this.password(tx, user.id, password);
            const factor = await this.factor(tx, user.id);
            if (
                factor &&
                (!proof ||
                    !(await consumeFactor(tx, factor, proof.code, proof.method, this.config.MFA_ENCRYPTION_KEY!)))
            )
                throw new UnauthorizedException();
            await tx
                .updateTable('auth_challenges')
                .set({ revoked_at: new Date() })
                .where('user_id', '=', user.id)
                .where('purpose', '=', 'factor_setup')
                .where('revoked_at', 'is', null)
                .execute();
            await tx
                .updateTable('mfa_factors')
                .set({ revoked_at: new Date() })
                .where('user_id', '=', user.id)
                .where('verified_at', 'is', null)
                .where('revoked_at', 'is', null)
                .execute();
            const id = randomUUID(),
                secret = generateSecret(),
                challenge = newToken(),
                expiresAt = new Date(Date.now() + 600000);
            await tx
                .insertInto('mfa_factors')
                .values({
                    id,
                    user_id: user.id,
                    kind: 'totp',
                    secret_ciphertext: encryptSecret(secret, this.config.MFA_ENCRYPTION_KEY!, id),
                    verified_at: null,
                    revoked_at: null,
                    last_accepted_step: null,
                })
                .execute();
            await tx
                .insertInto('auth_challenges')
                .values({
                    id: randomUUID(),
                    user_id: user.id,
                    session_id: session.id,
                    purpose: 'factor_setup',
                    token_hash: tokenHash(challenge),
                    expires_at: expiresAt,
                    used_at: null,
                    revoked_at: null,
                    attempts: 0,
                    auth_context: null,
                    factor_id: id,
                    operation_digest: factor?.id ?? null,
                })
                .execute();
            await this.auth.audit(tx, user.id, 'account.factor.setup', id, requestId);
            return {
                challenge,
                expiresAt: expiresAt.toISOString(),
                enrollment: {
                    secret,
                    uri: generateURI({
                        secret,
                        issuer: 'Meal Planner',
                        label: user.email_normalized,
                        digits: 6,
                        period: 30,
                    }),
                },
            };
        });
    }
    async authenticatorConfirm(
        sessionToken: string | undefined,
        challengeToken: string,
        code: string,
        requestId: string,
    ) {
        await this.auth.principal(sessionToken, 'user');
        const result = await this.database.transaction(async (tx) => {
            const { user, session } = await this.actor(tx, sessionToken);
            const challenge = await tx
                .selectFrom('auth_challenges')
                .selectAll()
                .where('token_hash', '=', tokenHash(challengeToken))
                .where('purpose', '=', 'factor_setup')
                .where('user_id', '=', user.id)
                .where('session_id', '=', session.id)
                .forUpdate()
                .executeTakeFirst();
            if (
                !challenge ||
                challenge.revoked_at ||
                challenge.used_at ||
                challenge.expires_at <= new Date() ||
                (challenge.attempts ?? 0) >= 5 ||
                !challenge.factor_id
            )
                return null;
            const old = await this.factor(tx, user.id);
            if ((old?.id ?? null) !== challenge.operation_digest) return null;
            const factor = await tx
                .selectFrom('mfa_factors')
                .selectAll()
                .where('id', '=', challenge.factor_id)
                .where('user_id', '=', user.id)
                .where('revoked_at', 'is', null)
                .forUpdate()
                .executeTakeFirst();
            if (!factor || factor.verified_at) return null;
            // Revoke old factor before verification to satisfy the partial unique index; failure restores it in this transaction.
            if (old)
                await tx.updateTable('mfa_factors').set({ revoked_at: new Date() }).where('id', '=', old.id).execute();
            const accepted = await consumeFactor(tx, factor, code, 'totp', this.config.MFA_ENCRYPTION_KEY!, true);
            await tx
                .updateTable('auth_challenges')
                .set({ attempts: (challenge.attempts ?? 0) + 1, ...(accepted ? { used_at: new Date() } : {}) })
                .where('id', '=', challenge.id)
                .execute();
            if (!accepted) {
                if (old)
                    await tx.updateTable('mfa_factors').set({ revoked_at: null }).where('id', '=', old.id).execute();
                return null;
            }
            await revokeAccountAccess(tx, user.id, true);
            const recoveryCodes = await regenerateRecoveryCodes(tx, factor.id);
            await this.auth.audit(tx, user.id, 'account.factor.confirmed', factor.id, requestId);
            return { enabled: true as const, recoveryCodes };
        });
        if (!result) throw new UnauthorizedException();
        return result;
    }
    async recoveryCodes(
        sessionToken: string | undefined,
        password: string,
        proof: Proof,
        ip: string,
        requestId: string,
    ) {
        await this.auth.principal(sessionToken, 'user');
        await this.ready();
        await this.auth.rateLimit(`session:${tokenHash(sessionToken ?? '')}`, ip);
        return this.database.transaction(async (tx) => {
            const { user } = await this.actor(tx, sessionToken);
            await this.password(tx, user.id, password);
            const factor = await this.factor(tx, user.id);
            if (
                !factor ||
                !(await consumeFactor(tx, factor, proof.code, proof.method, this.config.MFA_ENCRYPTION_KEY!))
            )
                throw new UnauthorizedException();
            const recoveryCodes = await regenerateRecoveryCodes(tx, factor.id);
            await this.auth.audit(tx, user.id, 'account.factor.recovery_regenerated', factor.id, requestId);
            return { recoveryCodes };
        });
    }
    async mailbox(email: string) {
        this.developmentMailboxOnly();
        const db = await this.ready();
        const rows =
            await sql<MailToken>`select * from meal.account_tokens where email_target=${email} order by created_at desc limit 20`.execute(
                db,
            );
        return {
            messages: rows.rows.map((row) => ({
                id: row.id,
                kind: row.kind,
                token: decryptSecret(row.token_ciphertext, this.config.MFA_ENCRYPTION_KEY!, row.id),
                createdAt: row.created_at.toISOString(),
                expiresAt: row.expires_at.toISOString(),
            })),
        };
    }

    async processEmailChanges() {
        const db = await this.ready();
        const rows = await sql<{ user_id: string }>`select user_id from meal.account_email_changes
          where cancelled_at is null and applied_at is null
          and (effective_at<=now() or (confirmed_at is null and created_at<=now()-interval '24 hours'))
          order by created_at limit 100`.execute(db);
        for (const row of rows.rows) await this.database.transaction((tx) => settleEmailChanges(tx, row.user_id));
        return { processed: rows.rows.length };
    }
}
