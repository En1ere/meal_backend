import {
    ForbiddenException,
    HttpException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import {
    webPushConfigSchema,
    webPushSubscribeSchema,
    webPushSubscriptionSchema,
    webPushUnsubscribeSchema,
} from './notifications.contracts.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class WebPushSubscriptionsService {
    constructor(
        private readonly database: DatabaseService,
        @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    ) {}

    config() {
        return webPushConfigSchema.parse({
            available: this.appConfig.WEB_PUSH_ENABLED,
            vapidPublicKey: this.appConfig.WEB_PUSH_ENABLED ? this.appConfig.WEB_PUSH_VAPID_PUBLIC_KEY : null,
        });
    }

    private encrypt(id: string, value: unknown) {
        const key = Buffer.from(this.appConfig.WEB_PUSH_SUBSCRIPTION_KEY!, 'base64');
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(Buffer.from(`web-push-subscription:${id}`, 'utf8'));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
    }

    async subscribe(userId: string, sessionId: string, raw: unknown) {
        if (!this.appConfig.WEB_PUSH_ENABLED) throw new ServiceUnavailableException('Web Push is not configured');
        const input = webPushSubscribeSchema.parse(raw);
        const endpointHash = hash(input.endpoint);
        return this.database.transaction(async (tx) => {
            const authorized =
                await sql`select u.id from meal.users u join meal.sessions s on s.user_id=u.id where u.id=${userId}::uuid and u.status='active' and s.id=${sessionId}::uuid and s.revoked_at is null and s.expires_at>now() for update of u,s`.execute(
                    tx,
                );
            if (!authorized.rows.length) throw new ForbiddenException();
            const requestHash = hash(JSON.stringify(input));
            const replay = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', 'notifications.web-push.subscribe')
                .where('target_binding', '=', endpointHash)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (replay) {
                if (replay.request_hash !== requestHash) throw new HttpException('Idempotency key conflict', 409);
                return webPushSubscriptionSchema.parse(replay.response_snapshot);
            }
            const active = await sql<{
                id: string;
                user_id: string;
            }>`select id,user_id from meal.push_subscriptions where endpoint_hash=${endpointHash} and revoked_at is null for update`.execute(
                tx,
            );
            if (active.rows[0] && active.rows[0].user_id !== userId) throw new ForbiddenException();
            const id = active.rows[0]?.id ?? randomUUID();
            const endpoint = this.encrypt(id, input.endpoint);
            const keys = this.encrypt(id, input.keys);
            const row = await sql<{
                id: string;
                version: string;
            }>`insert into meal.push_subscriptions(id,endpoint_encrypted,keys_encrypted,endpoint_hash,expiration_time,user_id,session_id)
                values(${id}::uuid,${endpoint},${keys},${endpointHash},${input.expirationTime ? new Date(input.expirationTime) : null}::timestamptz,${userId}::uuid,${sessionId}::uuid)
                on conflict(endpoint_hash) where revoked_at is null do update set endpoint_encrypted=excluded.endpoint_encrypted,keys_encrypted=excluded.keys_encrypted,
                    expiration_time=excluded.expiration_time,session_id=excluded.session_id,updated_at=now(),version=meal.push_subscriptions.version+1
                returning id,version`.execute(tx);
            const result = webPushSubscriptionSchema.parse({
                id: row.rows[0]!.id,
                version: Number(row.rows[0]!.version),
            });
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'notifications.web-push.subscribe',
                    target_binding: endpointHash,
                    key: input.idempotencyKey,
                    request_hash: requestHash,
                    status: 'completed',
                    response_snapshot: result,
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: userId,
                    scope_id: null,
                    actor_namespace: `user:${userId}`,
                })
                .execute();
            return result;
        });
    }

    async unsubscribe(userId: string, sessionId: string, id: string, raw: unknown) {
        const input = webPushUnsubscribeSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            const requestHash = hash(JSON.stringify(input));
            const replay = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `user:${userId}`)
                .where('operation', '=', 'notifications.web-push.unsubscribe')
                .where('target_binding', '=', id)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (replay) {
                if (replay.request_hash !== requestHash) throw new HttpException('Idempotency key conflict', 409);
                return replay.response_snapshot;
            }
            const row = await sql<{
                version: string;
                revoked_at: Date | null;
            }>`select version,revoked_at from meal.push_subscriptions where id=${id}::uuid and user_id=${userId}::uuid and session_id=${sessionId}::uuid for update`.execute(
                tx,
            );
            if (!row.rows[0]) throw new NotFoundException();
            if (Number(row.rows[0].version) !== input.expectedVersion)
                throw new HttpException('Subscription changed', 412);
            if (!row.rows[0].revoked_at)
                await sql`update meal.push_subscriptions set revoked_at=now(),updated_at=now(),version=version+1 where id=${id}::uuid`.execute(
                    tx,
                );
            const result = { revoked: true } as const;
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'notifications.web-push.unsubscribe',
                    target_binding: id,
                    key: input.idempotencyKey,
                    request_hash: requestHash,
                    status: 'completed',
                    response_snapshot: result,
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: userId,
                    scope_id: null,
                    actor_namespace: `user:${userId}`,
                })
                .execute();
            return result;
        });
    }
}
