import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';

type Connection = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;
type RecoveryDatabase = Pick<DatabaseService, 'db' | 'transaction'>;

export type AdminMfaRecoveryMode = 'dry_run' | 'execute';

export interface AdminMfaRecoveryInput {
    login: string;
    reason: string;
    mode: AdminMfaRecoveryMode;
}

export interface AdminMfaRecoveryResult {
    mode: AdminMfaRecoveryMode;
    status: 'planned' | 'completed';
    requestId: string;
    target: { id: string; login: string };
    activeBefore: { factors: number; challenges: number; sessions: number };
    revoked: { factors: number; challenges: number; sessions: number };
}

export class AdminMfaRecoveryError extends Error {
    constructor(readonly code: 'INVALID_INPUT' | 'TARGET_UNAVAILABLE' | 'DATABASE_UNAVAILABLE' | 'READBACK_FAILED') {
        super(code);
        this.name = 'AdminMfaRecoveryError';
    }
}

const loginPattern = /^[A-Za-z0-9_]{3,30}$/u;
const reasonPattern = /^[^\u0000-\u001f\u007f]{10,240}$/u;

export function parseAdminMfaRecoveryArgs(args: readonly string[], recoveryEnabled: string | undefined) {
    let login: string | undefined;
    let confirmLogin: string | undefined;
    let reason: string | undefined;
    let execute = false;
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index++) {
        const flag = args[index]!;
        if (flag === '--execute') {
            if (seen.has(flag)) throw new AdminMfaRecoveryError('INVALID_INPUT');
            seen.add(flag);
            execute = true;
            continue;
        }
        if (!['--login', '--confirm-login', '--reason'].includes(flag) || seen.has(flag))
            throw new AdminMfaRecoveryError('INVALID_INPUT');
        seen.add(flag);
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new AdminMfaRecoveryError('INVALID_INPUT');
        if (flag === '--login') login = value;
        else if (flag === '--confirm-login') confirmLogin = value;
        else reason = value;
    }
    const normalizedLogin = login?.toLowerCase();
    const normalizedConfirmation = confirmLogin?.toLowerCase();
    const normalizedReason = reason?.trim();
    if (
        !normalizedLogin ||
        !loginPattern.test(normalizedLogin) ||
        !normalizedReason ||
        !reasonPattern.test(normalizedReason)
    )
        throw new AdminMfaRecoveryError('INVALID_INPUT');
    if (execute && (recoveryEnabled !== 'true' || normalizedConfirmation !== normalizedLogin))
        throw new AdminMfaRecoveryError('INVALID_INPUT');
    return {
        login: normalizedLogin,
        reason: normalizedReason,
        mode: execute ? ('execute' as const) : ('dry_run' as const),
    };
}

interface TargetSnapshot {
    id: string;
    login: string;
    status: string;
    archived_at: Date | null;
    email_verified_at: Date | null;
    current_admin: boolean;
    active_factors: number;
    active_challenges: number;
    active_sessions: number;
}

async function targetSnapshot(connection: Connection, login: string, lock: boolean) {
    const query = lock
        ? sql<TargetSnapshot>`select u.id,u.login,u.status,u.archived_at,u.email_verified_at,
              exists(select 1 from meal.staff_role_assignments r where r.user_id=u.id and r.role='admin' and r.revoked_at is null) current_admin,
              (select count(*)::integer from meal.mfa_factors f where f.user_id=u.id and f.revoked_at is null) active_factors,
              (select count(*)::integer from meal.auth_challenges c where c.user_id=u.id and c.used_at is null and c.revoked_at is null) active_challenges,
              (select count(*)::integer from meal.sessions s where s.user_id=u.id and s.revoked_at is null) active_sessions
           from meal.users u where lower(u.login)=lower(${login}) for update`
        : sql<TargetSnapshot>`select u.id,u.login,u.status,u.archived_at,u.email_verified_at,
              exists(select 1 from meal.staff_role_assignments r where r.user_id=u.id and r.role='admin' and r.revoked_at is null) current_admin,
              (select count(*)::integer from meal.mfa_factors f where f.user_id=u.id and f.revoked_at is null) active_factors,
              (select count(*)::integer from meal.auth_challenges c where c.user_id=u.id and c.used_at is null and c.revoked_at is null) active_challenges,
              (select count(*)::integer from meal.sessions s where s.user_id=u.id and s.revoked_at is null) active_sessions
           from meal.users u where lower(u.login)=lower(${login})`;
    const row = (await query.execute(connection)).rows[0];
    if (
        !row ||
        row.login.toLowerCase() !== login ||
        row.status !== 'active' ||
        row.archived_at !== null ||
        row.email_verified_at === null ||
        !row.current_admin
    )
        throw new AdminMfaRecoveryError('TARGET_UNAVAILABLE');
    return row;
}

function counts(row: TargetSnapshot) {
    return {
        factors: Number(row.active_factors),
        challenges: Number(row.active_challenges),
        sessions: Number(row.active_sessions),
    };
}

export async function recoverAdminMfa(
    database: RecoveryDatabase,
    input: AdminMfaRecoveryInput,
    requestId = randomUUID(),
): Promise<AdminMfaRecoveryResult> {
    if (!database.db) throw new AdminMfaRecoveryError('DATABASE_UNAVAILABLE');
    if (input.mode === 'dry_run') {
        const target = await targetSnapshot(database.db, input.login, false);
        return {
            mode: 'dry_run',
            status: 'planned',
            requestId,
            target: { id: target.id, login: target.login },
            activeBefore: counts(target),
            revoked: { factors: 0, challenges: 0, sessions: 0 },
        };
    }
    return database.transaction(async (tx) => {
        const target = await targetSnapshot(tx, input.login, true);
        const now = new Date();
        const factors = await sql<{ id: string }>`update meal.mfa_factors set revoked_at=${now},version=version+1
             where user_id=${target.id}::uuid and revoked_at is null returning id`.execute(tx);
        const challenges = await sql<{ id: string }>`update meal.auth_challenges set revoked_at=${now},version=version+1
             where user_id=${target.id}::uuid and used_at is null and revoked_at is null returning id`.execute(tx);
        const sessions = await sql<{ id: string }>`update meal.sessions set revoked_at=${now},version=version+1
             where user_id=${target.id}::uuid and revoked_at is null returning id`.execute(tx);
        const revoked = {
            factors: factors.rows.length,
            challenges: challenges.rows.length,
            sessions: sessions.rows.length,
        };
        await sql`insert into meal.audit_events(
              id,action,target_type,target_id,effective_at,recorded_at,reason,before_redacted,after_redacted,request_id,actor_id,scope_id
            ) values(
              ${randomUUID()}::uuid,'operator.admin_mfa_recovered','user',${target.id}::uuid,${now},${now},${input.reason},
              ${JSON.stringify({ active: counts(target) })}::jsonb,
              ${JSON.stringify({ revoked })}::jsonb,${requestId}::uuid,null,null
            )`.execute(tx);
        const readback = await targetSnapshot(tx, input.login, false);
        const remaining = counts(readback);
        if (remaining.factors !== 0 || remaining.challenges !== 0 || remaining.sessions !== 0)
            throw new AdminMfaRecoveryError('READBACK_FAILED');
        return {
            mode: 'execute',
            status: 'completed',
            requestId,
            target: { id: target.id, login: target.login },
            activeBefore: counts(target),
            revoked,
        };
    });
}
