import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { EntitlementsService } from '../../modules/entitlements/entitlements.service.js';

export type WorkflowScope = 'private' | 'family';
export type WorkflowTx = Transaction<DatabaseSchema>;

export async function scopedWorkflow<T>(
    database: DatabaseService,
    entitlements: EntitlementsService,
    userId: string,
    requestedScope: WorkflowScope,
    write: boolean,
    work: (tx: WorkflowTx, scope: string) => Promise<T>,
    empty?: T,
): Promise<T> {
    if (!database.db || !(await database.ready())) throw new ServiceUnavailableException();
    return database.transaction(async (tx) => {
        const user =
            await sql`select id from meal.users where id=${userId}::uuid and status='active' and archived_at is null for update`.execute(
                tx,
            );
        if (!user.rows.length) throw new HttpException('Аккаунт недоступен', 403);
        if (write) {
            const bans =
                await sql`select id from meal.sanctions where user_id=${userId}::uuid and scope='account' and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                    tx,
                );
            if (bans.rows.length) throw new HttpException('Доступен только просмотр', 403);
        }
        const row =
            requestedScope === 'private'
                ? (
                      await sql<{
                          id: string;
                      }>`select id from meal.data_scopes where user_id=${userId}::uuid and kind='private'`.execute(tx)
                  ).rows[0]
                : (
                      await sql<{
                          id: string;
                          familyId: string;
                      }>`select scope.id,family.id as "familyId" from meal.family_memberships membership join meal.families family on family.id=membership.family_id join meal.data_scopes scope on scope.family_id=family.id where membership.user_id=${userId}::uuid and membership.left_at is null and family.status='active' and scope.kind='family'`.execute(
                          tx,
                      )
                  ).rows[0];
        let scope = row;
        if (requestedScope === 'family' && scope && 'familyId' in scope) {
            const entitlement = await entitlements.resolveFamily(userId, scope.familyId as string, tx);
            if (!entitlement.capabilities.family) throw new HttpException('Семейный доступ приостановлен', 403);
        }
        if (!scope && requestedScope === 'family') throw new HttpException('Семейный доступ не найден', 404);
        if (!scope && write) {
            scope = { id: randomUUID() };
            await sql`insert into meal.data_scopes(id,kind,user_id,family_id) values(${scope.id}::uuid,'private',${userId}::uuid,null)`.execute(
                tx,
            );
        }
        if (!scope) {
            if (empty !== undefined) return empty;
            throw new HttpException('Объект не найден', 404);
        }
        return work(tx, scope.id);
    });
}

export async function personalWorkflow<T>(
    database: DatabaseService,
    userId: string,
    write: boolean,
    work: (tx: WorkflowTx, scope: string | null) => Promise<T>,
): Promise<T> {
    if (!database.db || !(await database.ready())) throw new ServiceUnavailableException();
    return database.transaction(async (tx) => {
        const user =
            await sql`select id from meal.users where id=${userId}::uuid and status='active' and archived_at is null for update`.execute(
                tx,
            );
        if (!user.rows.length) throw new HttpException('Аккаунт недоступен', 403);
        if (write) {
            const bans =
                await sql`select id from meal.sanctions where user_id=${userId}::uuid and scope='account' and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now()) limit 1`.execute(
                    tx,
                );
            if (bans.rows.length) throw new HttpException('Доступен только просмотр', 403);
        }
        const scopes = await sql<{
            id: string;
        }>`select id from meal.data_scopes where user_id=${userId}::uuid and kind='private'`.execute(tx);
        let scope = scopes.rows[0]?.id ?? null;
        if (!scope && write) {
            scope = randomUUID();
            await sql`insert into meal.data_scopes(id,kind,user_id,family_id) values(${scope}::uuid,'private',${userId}::uuid,null)`.execute(
                tx,
            );
        }
        return work(tx, scope);
    });
}

export async function workflowReplay<T>(
    tx: WorkflowTx,
    userId: string,
    scope: string | null,
    operation: string,
    target: string,
    body: { idempotencyKey: string },
    work: () => Promise<T>,
): Promise<T> {
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const prior = await sql<{
        request_hash: string;
        response_snapshot: T;
    }>`select request_hash,response_snapshot from meal.idempotency_records where actor_namespace=${`user:${userId}`} and operation=${operation} and target_binding=${target} and key=${body.idempotencyKey}`.execute(
        tx,
    );
    if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== hash) throw new HttpException('Ключ использован с другими данными', 409);
        return prior.rows[0].response_snapshot;
    }
    const result = await work();
    await sql`insert into meal.idempotency_records(id,operation,target_binding,key,request_hash,status,response_snapshot,expires_at,user_id,scope_id,actor_namespace) values(${randomUUID()}::uuid,${operation},${target},${body.idempotencyKey},${hash},'completed',${JSON.stringify(result)}::jsonb,'infinity'::timestamptz,${userId}::uuid,${scope}::uuid,${`user:${userId}`})`.execute(
        tx,
    );
    return result;
}
