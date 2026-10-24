import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import type { AccountTx } from './account-state.js';

export const ACCOUNT_MAIL_OUTBOX = Symbol('ACCOUNT_MAIL_OUTBOX');

export const accountMailMessageSchema = z.strictObject({
    eventId: z.uuid(),
    accountTokenId: z.uuid(),
    userId: z.uuid(),
    recipient: z.email().max(254),
    kind: z.enum(['verify', 'reset', 'email-confirm', 'email-cancel']),
    changeId: z.uuid().nullable(),
    expiresAt: z.iso.datetime(),
});

export type AccountMailMessage = z.infer<typeof accountMailMessageSchema>;

/**
 * Durable boundary for security/account mail. A production implementation must enqueue the
 * validated reference in the supplied transaction and let a worker perform provider I/O later.
 * Raw magic-link tokens must never cross this boundary or be written to the generic outbox.
 */
export interface AccountMailOutbox {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    enqueue(tx: AccountTx, message: AccountMailMessage): Promise<void>;
}

export function resolveAccountMailRuntime(
    nodeEnv: 'development' | 'test' | 'production',
    outbox?: AccountMailOutbox,
): Readonly<{ developmentMailbox: boolean; isTestAccount: boolean }> {
    if (nodeEnv === 'production' && (!outbox || !outbox.status().configured))
        throw new ServiceUnavailableException('Account mail outbox is not configured');
    return {
        developmentMailbox: nodeEnv !== 'production',
        isTestAccount: nodeEnv !== 'production',
    };
}

@Injectable()
export class DisabledAccountMailOutbox implements AccountMailOutbox {
    status() {
        return { configured: false, provider: null } as const;
    }

    enqueue(tx: AccountTx, message: AccountMailMessage): Promise<void> {
        void tx;
        void message;
        return Promise.reject(new ServiceUnavailableException('Account mail outbox is not configured'));
    }
}
