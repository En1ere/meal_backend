import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';

type Connection = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;
type BootstrapDatabase = Pick<DatabaseService, 'db' | 'transaction'>;
export type AdminBootstrapMode = 'dry_run' | 'execute';

export interface AdminBootstrapInput {
    login: string;
    reason: string;
    mode: AdminBootstrapMode;
    environment: 'development' | 'test';
}

export interface AdminBootstrapResult {
    mode: AdminBootstrapMode;
    status: 'planned' | 'completed' | 'already_completed';
    requestId: string;
    target: { id: string; login: string };
}

export class AdminBootstrapError extends Error {
    constructor(
        readonly code:
            | 'INVALID_INPUT'
            | 'TARGET_UNAVAILABLE'
            | 'ADMIN_ALREADY_EXISTS'
            | 'DATABASE_UNAVAILABLE'
            | 'READBACK_FAILED',
    ) {
        super(code);
        this.name = 'AdminBootstrapError';
    }
}

const loginPattern = /^[A-Za-z0-9_]{3,30}$/u;
const reasonPattern = /^[^\u0000-\u001f\u007f]{10,240}$/u;

export function parseAdminBootstrapArgs(
    args: readonly string[],
    bootstrapEnabled: string | undefined,
    nodeEnvironment: string | undefined,
): AdminBootstrapInput {
    let login: string | undefined;
    let confirmLogin: string | undefined;
    let reason: string | undefined;
    let execute = false;
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index++) {
        const flag = args[index]!;
        if (flag === '--execute') {
            if (seen.has(flag)) throw new AdminBootstrapError('INVALID_INPUT');
            seen.add(flag);
            execute = true;
            continue;
        }
        if (!['--login', '--confirm-login', '--reason'].includes(flag) || seen.has(flag))
            throw new AdminBootstrapError('INVALID_INPUT');
        seen.add(flag);
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new AdminBootstrapError('INVALID_INPUT');
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
        !reasonPattern.test(normalizedReason) ||
        !['development', 'test'].includes(nodeEnvironment ?? '')
    )
        throw new AdminBootstrapError('INVALID_INPUT');
    if (execute && (bootstrapEnabled !== 'true' || normalizedConfirmation !== normalizedLogin))
        throw new AdminBootstrapError('INVALID_INPUT');
    return {
        login: normalizedLogin,
        reason: normalizedReason,
        mode: execute ? 'execute' : 'dry_run',
        environment: nodeEnvironment as 'development' | 'test',
    };
}

interface BootstrapSnapshot {
    id: string;
    login: string;
    status: string;
    archived_at: Date | null;
    email_verified_at: Date | null;
    current_admin: boolean;
    active_admins: number;
}

async function snapshot(connection: Connection, login: string, lock: boolean) {
    const suffix = lock ? sql` for update` : sql``;
    const result = await sql<BootstrapSnapshot>`select u.id,u.login,u.status,u.archived_at,u.email_verified_at,
        exists(select 1 from meal.staff_role_assignments r where r.user_id=u.id and r.role='admin' and r.revoked_at is null) current_admin,
        (select count(*)::integer from meal.staff_role_assignments r join meal.users a on a.id=r.user_id
          where r.role='admin' and r.revoked_at is null and a.status='active' and a.archived_at is null) active_admins
        from meal.users u where lower(u.login)=lower(${login})${suffix}`.execute(connection);
    const row = result.rows[0];
    if (
        !row ||
        row.login.toLowerCase() !== login ||
        row.status !== 'active' ||
        row.archived_at !== null ||
        row.email_verified_at === null
    )
        throw new AdminBootstrapError('TARGET_UNAVAILABLE');
    if (Number(row.active_admins) > 0 && !row.current_admin) throw new AdminBootstrapError('ADMIN_ALREADY_EXISTS');
    return row;
}

export async function bootstrapFirstAdmin(
    database: BootstrapDatabase,
    input: AdminBootstrapInput,
    requestId = randomUUID(),
): Promise<AdminBootstrapResult> {
    if (!database.db) throw new AdminBootstrapError('DATABASE_UNAVAILABLE');
    if (input.mode === 'dry_run') {
        const target = await snapshot(database.db, input.login, false);
        return {
            mode: input.mode,
            status: target.current_admin ? 'already_completed' : 'planned',
            requestId,
            target: { id: target.id, login: target.login },
        };
    }
    return database.transaction(async (tx) => {
        await sql`select pg_advisory_xact_lock(73821642)`.execute(tx);
        const target = await snapshot(tx, input.login, true);
        if (target.current_admin)
            return {
                mode: input.mode,
                status: 'already_completed',
                requestId,
                target: { id: target.id, login: target.login },
            };
        const now = new Date();
        await tx
            .insertInto('staff_role_assignments')
            .values({
                id: randomUUID(),
                role: 'admin',
                assigned_at: now,
                revoked_at: null,
                user_id: target.id,
                assigned_by: target.id,
            })
            .execute();
        await sql`insert into meal.audit_events(
            id,action,target_type,target_id,effective_at,recorded_at,reason,before_redacted,after_redacted,request_id,actor_id,scope_id
          ) values(
            ${randomUUID()}::uuid,'operator.first_admin_bootstrapped','user',${target.id}::uuid,${now},${now},${input.reason},
            ${JSON.stringify({ activeAdminCount: 0 })}::jsonb,
            ${JSON.stringify({ role: 'admin', environment: input.environment })}::jsonb,
            ${requestId}::uuid,null,null
          )`.execute(tx);
        const readback = await snapshot(tx, input.login, false);
        if (!readback.current_admin || Number(readback.active_admins) !== 1)
            throw new AdminBootstrapError('READBACK_FAILED');
        return {
            mode: input.mode,
            status: 'completed',
            requestId,
            target: { id: target.id, login: target.login },
        };
    });
}
