import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readConfig } from '../src/app/config.js';
import { webPushDeliveryRequestSchema } from '../src/modules/delivery-infrastructure/delivery-provider.js';
import {
    webPushPolicyExecuteSchema,
    webPushPolicyInputSchema,
} from '../src/modules/admin-runtime-settings/admin-runtime-settings.contracts.js';
import { webPushSubscribeSchema } from '../src/modules/notifications/notifications.contracts.js';
import { nextQuietHoursEnd } from '../src/modules/web-push/web-push.processor.js';
import { classifyWebPushFailure } from '../src/modules/delivery-infrastructure/web-push.provider.js';

const publicKey = `B${'a'.repeat(86)}`;
const privateKey = 'b'.repeat(43);
const encryptionKey = `${'A'.repeat(43)}=`;

void test('Web Push production config is opt-in, complete and file-only for private keys', () => {
    const base = {
        NODE_ENV: 'test',
        WEB_PUSH_ENABLED: 'true',
        WEB_PUSH_VAPID_PUBLIC_KEY: publicKey,
        WEB_PUSH_VAPID_PRIVATE_KEY: privateKey,
        WEB_PUSH_SUBSCRIPTION_KEY: encryptionKey,
    };
    assert.equal(readConfig(base).WEB_PUSH_VAPID_SUBJECT, 'mailto:saix789@gmail.com');
    assert.throws(
        () => readConfig({ NODE_ENV: 'test', WEB_PUSH_ENABLED: 'true' }),
        /requires public, private and subscription keys/,
    );
    assert.throws(() => readConfig({ ...base, NODE_ENV: 'production' }), /root-owned/);
});

void test('subscription and delivery contracts remain bounded and never accept HTTP endpoints', () => {
    const subscription = {
        endpoint: 'https://push.example.test/subscription',
        keys: { p256dh: 'a'.repeat(65), auth: 'b'.repeat(22) },
        expirationTime: null,
        idempotencyKey: '00000000-0000-4000-8000-000000000001',
    };
    assert.ok(webPushSubscribeSchema.safeParse(subscription).success);
    assert.ok(!webPushSubscribeSchema.safeParse({ ...subscription, endpoint: 'http://push.example.test' }).success);
    assert.ok(
        webPushDeliveryRequestSchema.safeParse({
            deliveryId: '00000000-0000-4000-8000-000000000002',
            idempotencyKey: 'push:1',
            subscription: {
                subscriptionId: '00000000-0000-4000-8000-000000000003',
                endpoint: subscription.endpoint,
                p256dh: subscription.keys.p256dh,
                auth: subscription.keys.auth,
            },
            content: { title: 'Title', body: 'Body', href: '/notifications' },
            ttlSeconds: 300,
            urgency: 'high',
            topic: 'abcdef',
        }).success,
    );
});

void test('admin policy requires bounded TTL, distinct quiet hours and explicit preview execution', () => {
    const policy = {
        quietHours: { start: '22:00', end: '08:00' },
        ttlSeconds: { critical: 300, important: 14400, informational: 86400, marketing: 21600 },
        expectedVersion: 1,
    };
    assert.ok(webPushPolicyInputSchema.safeParse(policy).success);
    assert.ok(!webPushPolicyInputSchema.safeParse({ ...policy, quietHours: { start: '22:00', end: '22:00' } }).success);
    assert.ok(!webPushPolicyExecuteSchema.safeParse(policy).success);
});

void test('quiet hours defer ordinary delivery to the exact local end', () => {
    assert.equal(
        nextQuietHoursEnd(
            new Date('2026-11-02T23:15:30.000Z'),
            'UTC',
            { start: '22:00', end: '08:00' },
            '22:00',
            '08:00',
        )?.toISOString(),
        '2026-11-03T08:00:00.000Z',
    );
    assert.equal(
        nextQuietHoursEnd(
            new Date('2026-11-02T12:00:00.000Z'),
            'UTC',
            { start: '22:00', end: '08:00' },
            '22:00',
            '08:00',
        ),
        null,
    );
});

void test('Web Push retries only 429/5xx and accepts only bounded Retry-After metadata', () => {
    const now = new Date('2026-11-02T12:00:00.000Z');
    assert.deepEqual(classifyWebPushFailure({ statusCode: 429, headers: { 'retry-after': '120' } }, now), {
        state: 'failed',
        failure: { code: 'http_429', retryable: true, retryAfterSeconds: 120 },
    });
    assert.deepEqual(classifyWebPushFailure({ statusCode: 503, headers: { 'retry-after': '7200' } }, now), {
        state: 'failed',
        failure: { code: 'http_5xx', retryable: true, retryAfterSeconds: null },
    });
    assert.equal(classifyWebPushFailure({ statusCode: 400 }, now).failure.retryable, false);
    assert.equal(classifyWebPushFailure({ statusCode: 410 }, now).state, 'gone');
    assert.deepEqual(classifyWebPushFailure(new Error('network details must not escape'), now), {
        state: 'unknown',
        failure: { code: 'network_unknown', retryable: false, retryAfterSeconds: null },
    });
});

void test('enqueue, claim and send recheck live account, session, sanction and marketing consent', async () => {
    const processor = await readFile('src/modules/web-push/web-push.processor.ts', 'utf8');
    assert.match(processor, /u\.status='active' and u\.archived_at is null/);
    assert.match(processor, /sanction\.scope='account'/);
    assert.match(processor, /session\.revoked_at is null and session\.expires_at>now\(\)/);
    assert.match(processor, /consent\.kind='marketing'.*consent\.revision desc/s);
    assert.match(processor, /authorizedImmediatelyBeforeSend/);
    assert.match(processor, /marketing_consent_missing/);
    assert.match(processor, /retryable && outcome === 'failed'/);
});

void test('migration and deployment keep durable jobs, append-only attempts and isolated worker', async () => {
    const migration = await readFile('database/migrations/034_web_push_delivery.sql', 'utf8');
    const compose = await readFile('deploy/compose.web-push.yml', 'utf8');
    const common = await readFile('deploy/common.sh', 'utf8');
    const deploy = await readFile('deploy/deploy.sh', 'utf8');
    const stack = await readFile('deploy/stack.sh', 'utf8');
    const verify = await readFile('deploy/verify.sh', 'utf8');
    const provision = await readFile('deploy/provision-web-push-runtime.sh', 'utf8');
    const manifest = JSON.parse(await readFile('database/manifest.json', 'utf8')) as {
        migrations: Array<{ version: number; sha256: string }>;
    };
    assert.match(migration, /web_push_jobs/);
    assert.match(migration, /append-only/);
    assert.match(migration, /404|gone/);
    assert.match(compose, /read_only: true/);
    assert.match(compose, /cap_drop: \[ALL\]/);
    assert.match(compose, /meal-db, meal-egress/);
    assert.match(common, /WEB_PUSH_ENABLED:-false/);
    assert.match(common, /compose_web_push_overlay rm --stop --force push-worker/);
    assert.match(deploy, /provision-web-push-runtime\.sh/);
    assert.match(deploy, /schema_version=34/);
    assert.match(stack, /remove_disabled_web_push_worker/);
    assert.match(verify, /Web Push worker must use only database and egress networks/);
    assert.match(provision, /docker exec -i --user postgres/);
    assert.match(provision, /meal_push_runtime/);
    assert.match(provision, /select\(id,status,archived_at\) on meal\.users/);
    assert.match(provision, /select\(id,user_id,revoked_at,expires_at\) on meal\.sessions/);
    assert.match(provision, /select\(user_id,kind,action,revision\) on meal\.legal_consent_events/);
    assert.doesNotMatch(provision, /grant select on meal\.notifications/);
    assert.doesNotMatch(provision, /openssl rand -base64/);
    assert.equal(
        manifest.migrations.find((x) => x.version === 34)?.sha256,
        createHash('sha256').update(migration).digest('hex'),
    );
});
