import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Transporter } from 'nodemailer';
import { readConfig } from '../src/app/config.js';
import type { MailWorkerConfig } from '../src/modules/account-mail/mail-worker.config.js';
import { renderAccountMail, SmtpAccountMailProvider } from '../src/modules/account-mail/smtp-account-mail.js';

const text = (path: string) => readFile(path, 'utf8');
const config = {
    FRONTEND_ORIGIN: 'https://meal.example',
    SMTP_HOST: 'smtp.example',
    SMTP_PORT: 465,
    SMTP_SECURE: true,
    SMTP_REQUIRE_TLS: true,
    SMTP_USERNAME: 'mailer',
    SMTP_FROM: 'no-reply@example.com',
    SMTP_REPLY_TO: undefined,
    SMTP_CONNECTION_TIMEOUT_MS: 5000,
    SMTP_SOCKET_TIMEOUT_MS: 5000,
    smtpPassword: 'secret',
} as MailWorkerConfig;

void test('four account-mail templates keep token only in the intended HTTPS action URL', () => {
    for (const kind of ['verify', 'reset', 'email-confirm', 'email-cancel'] as const) {
        const rendered = renderAccountMail(config.FRONTEND_ORIGIN, kind, 'a&b');
        assert.match(rendered.text, /^.+https:\/\/meal\.example\/auth\//);
        assert.match(rendered.text, /token=a%26b/);
        assert.doesNotMatch(rendered.subject, /a&b/);
    }
});

void test('SMTP adapter keeps deterministic Message-ID and requires explicit recipient acceptance', async () => {
    let observed = '';
    const accepted = {
        sendMail: (message: { messageId?: string }) => {
            observed = message.messageId ?? '';
            return Promise.resolve({ accepted: ['user@example.com'], messageId: message.messageId });
        },
    } as unknown as Transporter;
    const provider = new SmtpAccountMailProvider(config, accepted);
    const outcome = await provider.send({
        recipient: 'user@example.com',
        kind: 'verify',
        token: 'secret-token',
        messageId: '<event@transactional.meal-planner.invalid>',
    });
    assert.equal(observed, '<event@transactional.meal-planner.invalid>');
    assert.equal(outcome.status, 'accepted');
    const rejected = new SmtpAccountMailProvider(config, {
        sendMail: () => Promise.resolve({ accepted: [], messageId: 'x' }),
    } as unknown as Transporter);
    assert.deepEqual(
        await rejected.send({ recipient: 'user@example.com', kind: 'reset', token: 'x', messageId: '<x@test>' }),
        { status: 'failed', errorCode: 'SMTP_NOT_ACCEPTED' },
    );
});

void test('ambiguous SMTP failure is terminal unknown while definite pre-connect failure may retry', async () => {
    const transport = (value: { code?: string; responseCode?: number }) => {
        const error = Object.assign(new Error('redacted provider failure'), value);
        return { sendMail: () => Promise.reject(error) } as unknown as Transporter;
    };
    const input = { recipient: 'user@example.com', kind: 'verify' as const, token: 'secret', messageId: '<x@test>' };
    assert.equal(
        (await new SmtpAccountMailProvider(config, transport({ code: 'ETIMEDOUT' })).send(input)).status,
        'unknown',
    );
    assert.equal(
        (await new SmtpAccountMailProvider(config, transport({ code: 'ECONNREFUSED' })).send(input)).status,
        'retry_scheduled',
    );
    assert.equal(
        (await new SmtpAccountMailProvider(config, transport({ responseCode: 550 })).send(input)).status,
        'failed',
    );
});

void test('production account mail is disabled by default and enabled mode requires its own key', () => {
    const base = {
        NODE_ENV: 'production',
        FRONTEND_ORIGIN: 'https://meal.example',
        DATABASE_URL: 'postgresql://u:p@db/meal_planner_postgres',
        SECURITY_KEY: 'x'.repeat(43),
        MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    };
    assert.equal(readConfig(base).ACCOUNT_MAIL_ENABLED, false);
    assert.throws(() => readConfig({ ...base, ACCOUNT_MAIL_ENABLED: 'true' }), /ACCOUNT_MAIL_TOKEN_KEY/);
    const own = Buffer.alloc(32, 2).toString('base64');
    assert.notEqual(own, base.MFA_ENCRYPTION_KEY);
    assert.equal(
        readConfig({ ...base, ACCOUNT_MAIL_ENABLED: 'true', ACCOUNT_MAIL_TOKEN_KEY: own }).ACCOUNT_MAIL_ENABLED,
        true,
    );
});

void test('migration, grants and Compose encode durable least-privilege mail boundary', async () => {
    const [migration, grants, compose, processor, bootstrap, provision, isolated, mailRuntime] = await Promise.all([
        text('database/migrations/031_account_mail_delivery.sql'),
        text('database/application-grants.sql'),
        text('deploy/compose.account-mail.yml'),
        text('src/modules/account-mail/account-mail.processor.ts'),
        text('deploy/bootstrap-restore.sh'),
        text('scripts/provision-local.mjs'),
        text('scripts/run-isolated-postgres-acceptance.ps1'),
        text('deploy/provision-account-mail-runtime.sh'),
    ]);
    assert.match(migration, /account_mail_deliveries/);
    assert.match(migration, /account_mail_attempts/);
    assert.match(migration, /SET revoked_at = now\(\)/i);
    assert.match(grants, /TO meal_mail_worker/);
    assert.doesNotMatch(grants, /GRANT .*password_credentials.*meal_mail_worker/i);
    assert.match(compose, /profiles: \[mail\]/);
    assert.match(compose, /cap_drop: \[ALL\]/);
    assert.match(compose, /networks: \[meal-db, meal-egress\]/);
    assert.doesNotMatch(compose, /MFA_ENCRYPTION_KEY/);
    assert.match(processor, /for update skip locked/i);
    assert.match(processor, /status='unknown'/);
    assert.match(processor, /lease_token=/);
    assert.match(processor, /Promise\.all\(claimed\.map/);
    assert.match(bootstrap, /create role meal_mail_worker nologin noinherit/);
    assert.doesNotMatch(bootstrap, /grant meal_mail_worker to meal_runtime/);
    assert.match(provision, /CREATE ROLE meal_mail_worker NOLOGIN/);
    assert.match(isolated, /CREATE ROLE meal_mail_worker NOLOGIN/);
    assert.match(mailRuntime, /create role meal_mail_runtime login noinherit/);
    assert.match(mailRuntime, /revoke meal_app from meal_mail_runtime/);
});
