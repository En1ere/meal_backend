import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { decryptSecret } from '../auth/crypto.js';
import type { MailWorkerConfig } from './mail-worker.config.js';
import { SmtpAccountMailProvider, type AccountMailKind, type SmtpOutcome } from './smtp-account-mail.js';

type Claimed = {
    id: string;
    account_token_id: string;
    recipient: string;
    kind: AccountMailKind;
    attempts: number;
    lease_token: string;
    message_id: string;
};
type TokenRow = {
    id: string;
    token_ciphertext: string;
    cipher_key_version: number;
    expires_at: Date;
    used_at: Date | null;
    revoked_at: Date | null;
};

export class AccountMailProcessor {
    constructor(
        private readonly db: Kysely<DatabaseSchema>,
        private readonly config: MailWorkerConfig,
        private readonly provider: SmtpAccountMailProvider,
    ) {}

    async reconcileExpiredLeases() {
        await this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                await sql`set local lock_timeout='3s'`.execute(tx);
                await sql`with expired as (
              select id,attempts,message_id from meal.account_mail_deliveries
              where status='processing' and lease_until<=now() for update skip locked
            ), attempts as (
              insert into meal.account_mail_attempts(id,delivery_id,attempt_no,outcome,message_id,error_code,started_at,finished_at)
              select gen_random_uuid(),id,attempts,'unknown',message_id,'LEASE_EXPIRED',now(),now() from expired
              on conflict(delivery_id,attempt_no) do nothing
            ) update meal.account_mail_deliveries d set status='unknown',lease_owner=null,lease_token=null,lease_until=null,
              last_error_code='LEASE_EXPIRED',completed_at=now(),updated_at=now(),version=version+1
              from expired e where d.id=e.id`.execute(tx);
            });
    }

    async claim(): Promise<Claimed[]> {
        return this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                const result = await sql<Claimed>`with due as (
              select id from meal.account_mail_deliveries where status in ('queued','retry_scheduled')
                and available_at<=now() and attempts<10 order by available_at,id limit ${this.config.MAIL_WORKER_BATCH_SIZE}
                for update skip locked
            ) update meal.account_mail_deliveries d set status='processing',attempts=attempts+1,
              lease_owner=${this.config.MAIL_WORKER_OWNER_ID},lease_token=gen_random_uuid(),
              lease_until=now()+${this.config.MAIL_WORKER_LEASE_SECONDS}*interval '1 second',updated_at=now(),version=version+1
              from due where d.id=due.id returning d.id,d.account_token_id,d.recipient,d.kind,d.attempts,d.lease_token,d.message_id`.execute(
                    tx,
                );
                return result.rows;
            });
    }

    async process(delivery: Claimed) {
        const started = new Date();
        const token = (
            await sql<TokenRow>`select id,token_ciphertext,cipher_key_version,expires_at,used_at,revoked_at
          from meal.account_tokens where id=${delivery.account_token_id}::uuid`.execute(this.db)
        ).rows[0];
        let outcome: SmtpOutcome | { status: 'skipped'; errorCode: string };
        if (
            !token ||
            token.used_at ||
            token.revoked_at ||
            token.expires_at <= new Date() ||
            token.cipher_key_version !== 2
        ) {
            outcome = { status: 'skipped', errorCode: 'TOKEN_INACTIVE' };
        } else {
            try {
                outcome = await this.provider.send({
                    recipient: delivery.recipient,
                    kind: delivery.kind,
                    token: decryptSecret(token.token_ciphertext, this.config.tokenKey, token.id),
                    messageId: delivery.message_id,
                });
            } catch {
                outcome = { status: 'unknown', errorCode: 'WORKER_UNKNOWN' };
            }
        }
        if (outcome.status === 'retry_scheduled' && delivery.attempts >= 10)
            outcome = { status: 'failed', errorCode: 'RETRY_EXHAUSTED' };
        await this.finish(delivery, outcome, started);
    }

    private async finish(
        delivery: Claimed,
        outcome: SmtpOutcome | { status: 'skipped'; errorCode: string },
        started: Date,
    ) {
        await this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                const locked = await sql<{
                    id: string;
                }>`select id from meal.account_mail_deliveries where id=${delivery.id}::uuid
              and status='processing' and lease_token=${delivery.lease_token}::uuid and attempts=${delivery.attempts} for update`.execute(
                    tx,
                );
                if (!locked.rows.length) return;
                const terminal = outcome.status !== 'retry_scheduled';
                const providerReference = outcome.status === 'accepted' ? outcome.providerReference : null;
                const errorCode = outcome.status === 'accepted' ? null : outcome.errorCode;
                const backoff = Math.min(3600, 30 * 2 ** Math.max(0, delivery.attempts - 1));
                await sql`insert into meal.account_mail_attempts(id,delivery_id,attempt_no,outcome,message_id,error_code,started_at,finished_at)
              values(${randomUUID()}::uuid,${delivery.id}::uuid,${delivery.attempts},${outcome.status},${delivery.message_id},${errorCode},${started},now())`.execute(
                    tx,
                );
                await sql`update meal.account_mail_deliveries set status=${outcome.status},lease_owner=null,lease_token=null,lease_until=null,
              available_at=case when ${outcome.status}='retry_scheduled' then now()+${backoff}*interval '1 second' else available_at end,
              provider_reference=${providerReference},last_error_code=${errorCode},
              accepted_at=case when ${outcome.status}='accepted' then now() else null end,
              completed_at=case when ${terminal} then now() else null end,updated_at=now(),version=version+1
              where id=${delivery.id}::uuid and status='processing' and lease_token=${delivery.lease_token}::uuid and attempts=${delivery.attempts}`.execute(
                    tx,
                );
            });
    }

    async runOnce() {
        await this.reconcileExpiredLeases();
        const claimed = await this.claim();
        // Every row in the batch receives the same lease deadline. Process the
        // bounded batch concurrently so later rows cannot expire while waiting
        // behind slow SMTP handshakes from earlier rows.
        await Promise.all(claimed.map((delivery) => this.process(delivery)));
        return claimed.length;
    }
}
