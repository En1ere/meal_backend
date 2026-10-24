import { sql, type Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
export type AccountTx = Transaction<DatabaseSchema>;
export async function hasDueEmailChange(tx: AccountTx, userId: string) {
    const result =
        await sql`select id from meal.account_email_changes where user_id=${userId}::uuid and cancelled_at is null and applied_at is null and effective_at<=now()`.execute(
            tx,
        );
    return result.rows.length > 0;
}
export async function revokeAccountAccess(tx: AccountTx, userId: string, staffOnly = false) {
    let sessions = tx
        .updateTable('sessions')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null);
    if (staffOnly) sessions = sessions.where('kind', '=', 'staff');
    await sessions.execute();
    await tx
        .updateTable('auth_challenges')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .execute();
    if (!staffOnly)
        await sql`update meal.account_devices set revoked_at=now() where user_id=${userId}::uuid and revoked_at is null`.execute(
            tx,
        );
}
// Called lazily by auth/security entry points. A scheduled worker must call the same operation after deployment.
export async function settleEmailChanges(tx: AccountTx, match: string) {
    const pending = await sql<{ id: string; user_id: string; new_email: string; old_email: string }>`
      select id,user_id,new_email,old_email from meal.account_email_changes
      where cancelled_at is null and applied_at is null and (user_id::text=${match} or old_email=${match} or new_email=${match})
      and (effective_at<=now() or (confirmed_at is null and created_at<=now()-interval '24 hours'))
      order by user_id for update
    `.execute(tx);
    for (const row of pending.rows) {
        const user = await tx
            .selectFrom('users')
            .select(['id', 'email_normalized', 'status'])
            .where('id', '=', row.user_id)
            .forUpdate()
            .executeTakeFirst();
        const state = await sql<{
            confirmed_at: Date | null;
        }>`select confirmed_at from meal.account_email_changes where id=${row.id}::uuid`.execute(tx);
        if (!state.rows[0]?.confirmed_at || user?.status !== 'active' || user.email_normalized !== row.old_email) {
            await sql`update meal.account_email_changes set cancelled_at=now() where id=${row.id}::uuid`.execute(tx);
            continue;
        }
        await tx
            .updateTable('users')
            .set({ email_normalized: row.new_email, email_verified_at: new Date() })
            .where('id', '=', row.user_id)
            .execute();
        await sql`update meal.account_email_changes set applied_at=now() where id=${row.id}::uuid`.execute(tx);
        await sql`update meal.account_tokens set revoked_at=now() where user_id=${row.user_id}::uuid and used_at is null and revoked_at is null`.execute(
            tx,
        );
        await revokeAccountAccess(tx, row.user_id);
        await tx
            .insertInto('audit_events')
            .values({
                id: randomUUID(),
                actor_id: row.user_id,
                action: 'account.email_change.applied',
                target_type: 'auth',
                target_id: row.id,
                scope_id: null,
                effective_at: new Date(),
                recorded_at: new Date(),
                request_id: randomUUID(),
                reason: null,
                before_redacted: null,
                after_redacted: null,
            })
            .execute();
    }
}
