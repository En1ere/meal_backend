import { createDecipheriv, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { WebPushDeliveryProvider } from '../delivery-infrastructure/delivery-provider.js';
type Config = { subscriptionKey: Buffer; WEB_PUSH_WORKER_BATCH_SIZE: number; WEB_PUSH_WORKER_LEASE_SECONDS: number };
type Claimed = {
    id: string;
    notification_id: string;
    subscription_id: string;
    attempt_count: number;
    lease_token: string;
    ttl_seconds: number;
    urgency: 'very-low' | 'low' | 'normal' | 'high';
    topic: string;
    endpoint_encrypted: string;
    keys_encrypted: string;
    priority: string;
    category: string;
    quiet_hours: unknown;
    timezone: string | null;
    urgent_opt_in: boolean | null;
    default_quiet_start: string;
    default_quiet_end: string;
};
type Candidate = Omit<Claimed, 'attempt_count' | 'lease_token'> & {
    attempt_count: number;
    user_allowed: boolean;
    session_allowed: boolean;
    marketing_allowed: boolean;
};

function localMinutes(at: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(at);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return Number(value.hour) * 60 + Number(value.minute);
}

function timeMinutes(value: unknown, fallback: string) {
    const text = typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
    const [hour = '0', minute = '0'] = text.split(':');
    return Number(hour) * 60 + Number(minute);
}

export function nextQuietHoursEnd(
    at: Date,
    timezone: string,
    quiet: unknown,
    defaultStart: string,
    defaultEnd: string,
) {
    const source =
        quiet && typeof quiet === 'object' && !Array.isArray(quiet) ? (quiet as Record<string, unknown>) : {};
    const start = timeMinutes(source.start, defaultStart);
    const end = timeMinutes(source.end, defaultEnd);
    const isQuiet = (value: Date) => {
        const minute = localMinutes(value, timezone);
        return start < end ? minute >= start && minute < end : minute >= start || minute < end;
    };
    if (!isQuiet(at)) return null;
    const candidate = new Date(at);
    candidate.setUTCSeconds(0, 0);
    for (let offset = 1; offset <= 36 * 60; offset += 1) {
        candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
        if (!isQuiet(candidate)) return new Date(candidate);
    }
    return new Date(at.getTime() + 36 * 60 * 60 * 1000);
}
export class WebPushProcessor {
    constructor(
        private db: Kysely<DatabaseSchema>,
        private config: Config,
        private provider: WebPushDeliveryProvider,
    ) {}
    private decrypt(id: string, value: string) {
        const raw = Buffer.from(value, 'base64url'),
            nonce = raw.subarray(0, 12),
            tag = raw.subarray(12, 28),
            cipher = raw.subarray(28);
        const d = createDecipheriv('aes-256-gcm', this.config.subscriptionKey, nonce);
        d.setAAD(Buffer.from(`web-push-subscription:${id}`));
        d.setAuthTag(tag);
        return JSON.parse(Buffer.concat([d.update(cipher), d.final()]).toString('utf8')) as unknown;
    }
    async enqueue() {
        await this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute((tx) =>
                sql`insert into meal.web_push_jobs(id,notification_id,subscription_id,topic,ttl_seconds,urgency)
 select gen_random_uuid(),n.id,s.id,substr(md5(n.dedup_key),1,32),case n.priority when 'critical' then p.critical_ttl when 'important' then p.important_ttl when 'marketing' then p.marketing_ttl else p.informational_ttl end,
 case n.priority when 'critical' then 'high' when 'important' then 'normal' when 'marketing' then 'very-low' else 'low' end
 from meal.notifications n
 join meal.users u on u.id=n.user_id and u.status='active' and u.archived_at is null
 join meal.push_subscriptions s on s.user_id=n.user_id and s.revoked_at is null and (s.expiration_time is null or s.expiration_time>now())
 join meal.sessions session on session.id=s.session_id and session.user_id=u.id and session.revoked_at is null and session.expires_at>now()
 cross join meal.web_push_policies p
 where n.available_at<=now()
 and not exists(select 1 from meal.sanctions sanction where sanction.user_id=u.id and sanction.scope='account' and sanction.revoked_at is null and sanction.starts_at<=now() and (sanction.ends_at is null or sanction.ends_at>now()))
 and not exists(select 1 from meal.notification_preferences pref where pref.user_id=n.user_id and pref.category=n.category and pref.channel='web_push' and not pref.enabled)
 and (n.priority<>'marketing' or coalesce((select consent.action from meal.legal_consent_events consent where consent.user_id=u.id and consent.kind='marketing' order by consent.revision desc limit 1),'revoked')='accepted')
 on conflict(notification_id,subscription_id) do nothing`.execute(tx),
            );
    }
    async claim() {
        return this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                const candidates = await sql<Candidate>`
 select j.id,j.notification_id,j.subscription_id,j.attempt_count,j.ttl_seconds,j.urgency,j.topic,
        s.endpoint_encrypted,s.keys_encrypted,n.priority,n.category,pref.quiet_hours,pref.timezone,pref.urgent_opt_in,
        to_char(p.quiet_start,'HH24:MI') as default_quiet_start,to_char(p.quiet_end,'HH24:MI') as default_quiet_end,
        (u.status='active' and u.archived_at is null and not exists(select 1 from meal.sanctions sanction where sanction.user_id=u.id and sanction.scope='account' and sanction.revoked_at is null and sanction.starts_at<=now() and (sanction.ends_at is null or sanction.ends_at>now()))) user_allowed,
        (s.revoked_at is null and (s.expiration_time is null or s.expiration_time>now()) and session.id is not null and session.revoked_at is null and session.expires_at>now()) session_allowed,
        (n.priority<>'marketing' or coalesce((select consent.action from meal.legal_consent_events consent where consent.user_id=u.id and consent.kind='marketing' order by consent.revision desc limit 1),'revoked')='accepted') marketing_allowed
 from meal.web_push_jobs j
 join meal.push_subscriptions s on s.id=j.subscription_id
 join meal.notifications n on n.id=j.notification_id
 join meal.users u on u.id=n.user_id
 left join meal.sessions session on session.id=s.session_id and session.user_id=u.id
 cross join meal.web_push_policies p
 left join meal.notification_preferences pref on pref.user_id=n.user_id and pref.category=n.category and pref.channel='web_push'
 where j.state in ('queued','deferred') and j.next_attempt_at<=now() and j.attempt_count<8 and coalesce(pref.enabled,true)
 order by j.next_attempt_at,j.id limit ${this.config.WEB_PUSH_WORKER_BATCH_SIZE} for update of j skip locked`.execute(
                    tx,
                );
                const claimed: Claimed[] = [];
                for (const candidate of candidates.rows) {
                    if (!candidate.user_allowed || !candidate.session_allowed || !candidate.marketing_allowed) {
                        const attempt = candidate.attempt_count + 1;
                        const code = !candidate.marketing_allowed
                            ? 'marketing_consent_missing'
                            : 'authorization_revoked';
                        await sql`insert into meal.web_push_attempts(id,job_id,attempt,outcome,error_code) values(${randomUUID()}::uuid,${candidate.id}::uuid,${attempt},'failed',${code})`.execute(
                            tx,
                        );
                        await sql`update meal.web_push_jobs set state='failed',attempt_count=${attempt},lease_token=null,lease_until=null,updated_at=now(),version=version+1 where id=${candidate.id}::uuid`.execute(
                            tx,
                        );
                        continue;
                    }
                    const updated = await sql<{
                        attempt_count: number;
                        lease_token: string;
                    }>`update meal.web_push_jobs set state='processing',attempt_count=attempt_count+1,lease_token=gen_random_uuid(),lease_until=now()+${this.config.WEB_PUSH_WORKER_LEASE_SECONDS}*interval '1 second',updated_at=now(),version=version+1 where id=${candidate.id}::uuid returning attempt_count,lease_token`.execute(
                        tx,
                    );
                    claimed.push({ ...candidate, ...updated.rows[0]! });
                }
                return claimed;
            });
    }
    private async authorizedImmediatelyBeforeSend(job: Claimed) {
        const result = await sql<{
            user_allowed: boolean;
            session_allowed: boolean;
            marketing_allowed: boolean;
        }>`select
 (u.status='active' and u.archived_at is null and not exists(select 1 from meal.sanctions sanction where sanction.user_id=u.id and sanction.scope='account' and sanction.revoked_at is null and sanction.starts_at<=now() and (sanction.ends_at is null or sanction.ends_at>now()))) user_allowed,
 (session.id is not null and session.revoked_at is null and session.expires_at>now() and s.revoked_at is null and (s.expiration_time is null or s.expiration_time>now())) session_allowed,
 (n.priority<>'marketing' or coalesce((select consent.action from meal.legal_consent_events consent where consent.user_id=u.id and consent.kind='marketing' order by consent.revision desc limit 1),'revoked')='accepted') marketing_allowed
 from meal.web_push_jobs j join meal.notifications n on n.id=j.notification_id join meal.users u on u.id=n.user_id
 join meal.push_subscriptions s on s.id=j.subscription_id left join meal.sessions session on session.id=s.session_id and session.user_id=u.id
 where j.id=${job.id}::uuid and j.state='processing' and j.lease_token=${job.lease_token}::uuid`.execute(this.db);
        const row = result.rows[0];
        return {
            allowed: !!row?.user_allowed && !!row.session_allowed && !!row.marketing_allowed,
            code: !row?.marketing_allowed ? 'marketing_consent_missing' : 'authorization_revoked',
        };
    }
    private async settle(
        job: Claimed,
        outcome: 'accepted' | 'unknown' | 'gone' | 'failed',
        errorCode: string | null,
        retryable = false,
        retryAfterSeconds: number | null = null,
    ) {
        await this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                const retry = retryable && outcome === 'failed' && job.attempt_count < 8;
                const delay = retry ? (retryAfterSeconds ?? Math.min(3600, 30 * 2 ** (job.attempt_count - 1))) : null;
                const retryAt = delay ? new Date(Date.now() + delay * 1000) : null;
                await sql`insert into meal.web_push_attempts(id,job_id,attempt,outcome,error_code,retry_at) values(${randomUUID()}::uuid,${job.id}::uuid,${job.attempt_count},${retry ? 'deferred' : outcome},${errorCode},${retryAt})`.execute(
                    tx,
                );
                await sql`update meal.web_push_jobs set state=${retry ? 'deferred' : outcome},next_attempt_at=case when ${retryAt}::timestamptz is not null then ${retryAt}::timestamptz else next_attempt_at end,lease_token=null,lease_until=null,updated_at=now(),version=version+1 where id=${job.id}::uuid and state='processing' and lease_token=${job.lease_token}::uuid`.execute(
                    tx,
                );
                if (outcome === 'gone')
                    await sql`update meal.push_subscriptions set revoked_at=coalesce(revoked_at,now()),updated_at=now(),version=version+1 where id=${job.subscription_id}::uuid`.execute(
                        tx,
                    );
            });
    }
    async process(job: Claimed) {
        const quietEnd =
            job.priority === 'critical' &&
            (job.category === 'security' || job.category === 'subscription' || job.urgent_opt_in)
                ? null
                : nextQuietHoursEnd(
                      new Date(),
                      job.timezone ?? 'Europe/Moscow',
                      job.quiet_hours,
                      job.default_quiet_start,
                      job.default_quiet_end,
                  );
        if (quietEnd) {
            await this.db
                .transaction()
                .setIsolationLevel('serializable')
                .execute((tx) =>
                    sql`update meal.web_push_jobs set state='deferred',attempt_count=greatest(0,attempt_count-1),next_attempt_at=${quietEnd},lease_token=null,lease_until=null,updated_at=now(),version=version+1 where id=${job.id}::uuid and state='processing' and lease_token=${job.lease_token}::uuid`.execute(
                        tx,
                    ),
                );
            return;
        }
        const authorization = await this.authorizedImmediatelyBeforeSend(job);
        if (!authorization.allowed) {
            await this.settle(job, 'failed', authorization.code);
            return;
        }
        let outcome: 'accepted' | 'unknown' | 'gone' | 'failed' = 'unknown';
        let errorCode: string | null = 'network_unknown';
        let retryable = false;
        let retryAfterSeconds: number | null = null;
        try {
            const endpoint = this.decrypt(job.subscription_id, job.endpoint_encrypted) as string;
            const keys = this.decrypt(job.subscription_id, job.keys_encrypted) as { p256dh: string; auth: string };
            const result = await this.provider.send({
                deliveryId: job.id,
                idempotencyKey: `web-push:${job.id}:${job.attempt_count}`,
                subscription: { subscriptionId: job.subscription_id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
                content: {
                    title: 'Новое уведомление',
                    body: 'Откройте приложение, чтобы посмотреть подробности.',
                    href: '/notifications',
                },
                ttlSeconds: job.ttl_seconds,
                urgency: job.urgency,
                topic: job.topic,
            });
            outcome =
                result.state === 'accepted'
                    ? 'accepted'
                    : result.state === 'gone'
                      ? 'gone'
                      : result.state === 'failed'
                        ? 'failed'
                        : 'unknown';
            errorCode = result.failure?.code ?? (outcome === 'accepted' ? null : `push_${outcome}`);
            retryable =
                !!result.failure?.retryable &&
                (result.failure.code === 'http_429' || result.failure.code === 'http_5xx');
            retryAfterSeconds = result.failure?.retryAfterSeconds ?? null;
        } catch {
            outcome = 'unknown';
            errorCode = 'network_unknown';
        }
        await this.settle(job, outcome, errorCode, retryable, retryAfterSeconds);
    }
    async runOnce() {
        await this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                await sql`insert into meal.web_push_attempts(id,job_id,attempt,outcome,error_code)
 select gen_random_uuid(),id,attempt_count,'unknown','lease_expired' from meal.web_push_jobs where state='processing' and lease_until<=now()
 on conflict(job_id,attempt) do nothing`.execute(tx);
                await sql`update meal.web_push_jobs set state='unknown',lease_token=null,lease_until=null,updated_at=now(),version=version+1 where state='processing' and lease_until<=now()`.execute(
                    tx,
                );
            });
        await this.enqueue();
        const jobs = await this.claim();
        await Promise.all(jobs.map((j) => this.process(j)));
        return jobs.length;
    }
}
