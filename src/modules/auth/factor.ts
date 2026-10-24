import { randomBytes, randomUUID } from 'node:crypto';
import { verify } from 'otplib';
import type { Selectable } from 'kysely';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { AccountTx } from '../account/account-state.js';
import { decryptSecret, tokenHash } from './crypto.js';
export type Factor = Selectable<DatabaseSchema['mfa_factors']>;
// Caller holds the user and factor locks. Global replay state is shared across all authentication contexts.
export async function consumeFactor(
    tx: AccountTx,
    factor: Factor,
    code: string,
    method: 'totp' | 'recovery',
    key: string,
    allowEnrollment = false,
): Promise<boolean> {
    if (factor.revoked_at || (!factor.verified_at && !allowEnrollment)) return false;
    const now = new Date();
    if (method === 'totp' && /^\d{6}$/.test(code)) {
        const checked = await verify({
            strategy: 'totp',
            secret: decryptSecret(factor.secret_ciphertext, key, factor.id),
            token: code,
            digits: 6,
            period: 30,
            epoch: Math.floor(now.getTime() / 1000),
            epochTolerance: 30,
        });
        if (!checked.valid || !('timeStep' in checked) || checked.timeStep <= Number(factor.last_accepted_step ?? -1))
            return false;
        await tx
            .updateTable('mfa_factors')
            .set({ last_accepted_step: String(checked.timeStep), verified_at: factor.verified_at ?? now })
            .where('id', '=', factor.id)
            .execute();
        return true;
    }
    if (method !== 'recovery' || !factor.verified_at) return false;
    return !!(await tx
        .updateTable('mfa_recovery_codes')
        .set({ used_at: now })
        .where('factor_id', '=', factor.id)
        .where('code_hash', '=', tokenHash(code))
        .where('used_at', 'is', null)
        .where('generation', '=', (qb) =>
            qb
                .selectFrom('mfa_recovery_codes')
                .select(({ fn }) => fn.max('generation').as('generation'))
                .where('factor_id', '=', factor.id),
        )
        .returning('id')
        .executeTakeFirst());
}
export async function regenerateRecoveryCodes(tx: AccountTx, factorId: string) {
    const previous = await tx
        .selectFrom('mfa_recovery_codes')
        .select(({ fn }) => fn.max('generation').as('generation'))
        .where('factor_id', '=', factorId)
        .executeTakeFirst();
    const generation = BigInt(previous?.generation ?? 0) + 1n;
    const recoveryCodes: string[] = [];
    for (let i = 0; i < 10; i++) {
        const code = randomBytes(16).toString('hex');
        recoveryCodes.push(code);
        await tx
            .insertInto('mfa_recovery_codes')
            .values({ id: randomUUID(), factor_id: factorId, code_hash: tokenHash(code), generation, used_at: null })
            .execute();
    }
    return recoveryCodes;
}
