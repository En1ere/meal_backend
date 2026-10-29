import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import { AuthService } from '../auth/auth.service.js';
import { newToken, tokenHash, verifyPassword } from '../auth/crypto.js';
import { consumeFactor } from '../auth/factor.js';
import type { CriticalPurpose } from './critical-reauth.contracts.js';

@Injectable()
export class CriticalReauthService {
    constructor(
        private readonly database: DatabaseService,
        private readonly auth: AuthService,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
    ) {}

    async issue(
        userId: string,
        sessionId: string,
        password: string,
        factor: { method: 'totp' | 'recovery'; code: string } | null,
        ip: string,
        requestId: string,
        purpose: CriticalPurpose,
    ) {
        await this.auth.rateLimit(`critical:${userId}`, ip);
        const result = await this.database.transaction(async (tx) => {
            const credential = await tx
                .selectFrom('password_credentials')
                .select('password_hash')
                .where('user_id', '=', userId)
                .executeTakeFirst();
            if (!(await verifyPassword(password, credential?.password_hash))) return null;
            const activeFactor = await tx
                .selectFrom('mfa_factors')
                .selectAll()
                .where('user_id', '=', userId)
                .where('kind', '=', 'totp')
                .where('verified_at', 'is not', null)
                .where('revoked_at', 'is', null)
                .forUpdate()
                .executeTakeFirst();
            if (activeFactor && !this.config.MFA_ENCRYPTION_KEY) throw new ServiceUnavailableException();
            if (
                activeFactor &&
                (!factor ||
                    !(await consumeFactor(
                        tx,
                        activeFactor,
                        factor.code,
                        factor.method,
                        this.config.MFA_ENCRYPTION_KEY!,
                    )))
            )
                return null;
            if (!activeFactor && factor) return null;
            const token = newToken();
            const expiresAt = new Date(Date.now() + 10 * 60_000);
            await sql`insert into meal.user_critical_grants(id,user_id,session_id,token_hash,purpose,expires_at)
                values(${randomUUID()}::uuid,${userId}::uuid,${sessionId}::uuid,${tokenHash(token)},${purpose},${expiresAt})`.execute(
                tx,
            );
            await this.auth.audit(tx, userId, 'account.critical_reauth.issued', userId, requestId);
            return { reauthToken: token, purpose, expiresAt: expiresAt.toISOString() };
        });
        if (!result) throw new UnauthorizedException();
        return result;
    }

    async consume(
        tx: Transaction<DatabaseSchema>,
        userId: string,
        sessionId: string,
        token: string,
        purpose: CriticalPurpose,
    ) {
        const result = await sql<{ id: string }>`update meal.user_critical_grants set used_at=now(),version=version+1
            where token_hash=${tokenHash(token)} and user_id=${userId}::uuid and session_id=${sessionId}::uuid
              and purpose=${purpose} and used_at is null and expires_at>now() returning id`.execute(tx);
        if (!result.rows[0]) throw new UnauthorizedException('Требуется повторное подтверждение личности');
    }
}
