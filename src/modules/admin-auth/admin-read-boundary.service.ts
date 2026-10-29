import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { Principal } from '../auth/auth.service.js';

type Tx = Transaction<DatabaseSchema>;
const requestIdSchema = z.string().uuid();

@Injectable()
export class AdminReadBoundary {
    constructor(private readonly database: DatabaseService) {}

    run<T>(
        actor: Principal,
        requestId: string,
        audit: Readonly<{ action: 'admin.observability.read'; targetType: 'observability' }>,
        work: (tx: Tx) => Promise<T>,
    ): Promise<T> {
        return this.database.transaction(async (tx) => {
            const allowed = await tx
                .selectFrom('sessions')
                .innerJoin('users', 'users.id', 'sessions.user_id')
                .select('sessions.id')
                .where('sessions.id', '=', actor.sessionId)
                .where('users.id', '=', actor.id)
                .where('sessions.kind', '=', 'staff')
                .where('sessions.auth_context', '=', 'admin')
                .where('sessions.revoked_at', 'is', null)
                .where('sessions.expires_at', '>', new Date())
                .where('sessions.mfa_verified_at', 'is not', null)
                .where('users.status', '=', 'active')
                .where('users.archived_at', 'is', null)
                .where('users.email_verified_at', 'is not', null)
                .where((eb) =>
                    eb.exists(
                        eb
                            .selectFrom('staff_role_assignments')
                            .select('id')
                            .whereRef('user_id', '=', 'users.id')
                            .where('role', '=', 'admin')
                            .where('revoked_at', 'is', null),
                    ),
                )
                .where((eb) =>
                    eb.exists(
                        eb
                            .selectFrom('mfa_factors')
                            .select('id')
                            .whereRef('user_id', '=', 'users.id')
                            .where('kind', '=', 'totp')
                            .where('verified_at', 'is not', null)
                            .where('revoked_at', 'is', null),
                    ),
                )
                .executeTakeFirst();
            if (!allowed || actor.context !== 'admin') throw new UnauthorizedException();
            const result = await work(tx);
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: audit.action,
                    target_type: audit.targetType,
                    target_id: actor.id,
                    effective_at: new Date(),
                    recorded_at: new Date(),
                    reason: null,
                    before_redacted: null,
                    after_redacted: null,
                    request_id: requestIdSchema.safeParse(requestId).success ? requestId : randomUUID(),
                    actor_id: actor.id,
                    scope_id: null,
                })
                .execute();
            return result;
        });
    }
}
