import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateSecret, generateSync } from 'otplib';
import { createApp } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';
import { accountInputs, passwordSchema } from '../src/modules/account/account.contracts.js';
import { encryptSecret, hashPassword, verifyPassword } from '../src/modules/auth/crypto.js';
import { consumeFactor, type Factor } from '../src/modules/auth/factor.js';
import type { AccountTx } from '../src/modules/account/account-state.js';
import {
    accountMailMessageSchema,
    DisabledAccountMailOutbox,
    resolveAccountMailRuntime,
    type AccountMailOutbox,
} from '../src/modules/account/account-mail.outbox.js';

await test('new credentials require Unicode upper/lower/digit/symbol; fixture login remains compatible', async () => {
    for (const password of ['1', 'abcdefghijkl', 'Abcdefghijkl', 'Abcdefghijk1', 'ABCDEFGHIJ1!', 'abcdefghijkl1!'])
        assert.equal(passwordSchema.safeParse(password).success, false);
    assert.equal(passwordSchema.safeParse('РусскийПароль1!').success, true);
    assert.equal(passwordSchema.safeParse('Aя1!' + 'x'.repeat(125)).success, false);
    const first = await hashPassword('РусскийПароль1!'),
        second = await hashPassword('РусскийПароль1!');
    assert.notEqual(first, second);
    assert.equal(await verifyPassword('РусскийПароль1!', first), true);
    assert.equal(await verifyPassword('wrong', first), false);
});
await test('account DTOs normalize identifiers and reject privilege/proof injection', () => {
    const registration = {
        username: ' User_Name ',
        displayName: 'User',
        email: ' User@Example.test ',
        password: 'ValidPassword1!',
        acceptTerms: true,
        acceptPrivacy: true,
    };
    assert.equal(accountInputs.register.parse(registration).username, 'user_name');
    assert.equal(accountInputs.register.parse(registration).email, 'user@example.test');
    assert.equal(accountInputs.register.safeParse({ ...registration, acceptTerms: false }).success, false);
    assert.equal(accountInputs.register.safeParse({ ...registration, username: 'a.b' }).success, false);
    assert.equal(
        accountInputs.totpLogin.safeParse({ email: 'user@example.test', code: '123456', context: 'admin' }).success,
        false,
    );
    assert.equal(accountInputs.pinLogin.safeParse({ pin: '12345' }).success, false);
    assert.equal(accountInputs.recoveryCodes.safeParse({ password: '1' }).success, false);
});
await test('production account mail requires a configured durable boundary and never classifies registrations as test', async () => {
    const disabled = new DisabledAccountMailOutbox();
    assert.throws(() => resolveAccountMailRuntime('production', disabled), /outbox is not configured/);
    const configured: AccountMailOutbox = {
        status: () => ({ configured: true, provider: 'test-outbox' }),
        enqueue: () => Promise.resolve(),
    };
    assert.deepEqual(resolveAccountMailRuntime('production', configured), {
        developmentMailbox: false,
        isTestAccount: false,
    });
    assert.deepEqual(resolveAccountMailRuntime('development'), {
        developmentMailbox: true,
        isTestAccount: true,
    });
    await assert.rejects(
        disabled.enqueue({} as AccountTx, {
            eventId: randomUUID(),
            accountTokenId: randomUUID(),
            userId: randomUUID(),
            recipient: 'user@example.test',
            kind: 'verify',
            changeId: null,
            expiresAt: new Date().toISOString(),
        }),
        /outbox is not configured/,
    );
});
await test('account mail outbox accepts only bounded token references, never raw secrets', () => {
    const message = {
        eventId: randomUUID(),
        accountTokenId: randomUUID(),
        userId: randomUUID(),
        recipient: 'user@example.test',
        kind: 'email-confirm' as const,
        changeId: randomUUID(),
        expiresAt: new Date().toISOString(),
    };
    assert.equal(accountMailMessageSchema.safeParse(message).success, true);
    assert.equal(accountMailMessageSchema.safeParse({ ...message, token: 'secret' }).success, false);
    assert.equal(accountMailMessageSchema.safeParse({ ...message, recipient: 'invalid' }).success, false);
});
await test('shared TOTP consumption rejects enrollment by default and globally rejects a replayed step', async () => {
    const secret = generateSecret(),
        key = randomBytes(32).toString('base64'),
        id = randomUUID(),
        now = new Date();
    const factor: Factor = {
        id,
        user_id: randomUUID(),
        kind: 'totp',
        secret_ciphertext: encryptSecret(secret, key, id),
        verified_at: null,
        revoked_at: null,
        last_accepted_step: null,
        created_at: now,
        version: '1',
    };
    let patch: Partial<Factor> = {};
    const builder = {
        set(value: Partial<Factor>) {
            patch = value;
            return builder;
        },
        where() {
            return builder;
        },
        execute() {
            Object.assign(factor, patch);
            return Promise.resolve([]);
        },
    };
    // Isolated in-memory write adapter; no PostgreSQL is contacted.
    const tx = {
        updateTable() {
            return builder;
        },
    } as unknown as AccountTx;
    const code = generateSync({ secret, period: 30, digits: 6, epoch: Math.floor(Date.now() / 1000) });
    assert.equal(await consumeFactor(tx, factor, code, 'totp', key), false);
    assert.equal(await consumeFactor(tx, factor, code, 'totp', key, true), true);
    assert.ok(factor.verified_at);
    assert.ok(factor.last_accepted_step);
    assert.equal(await consumeFactor(tx, factor, code, 'totp', key), false);
    factor.revoked_at = new Date();
    assert.equal(await consumeFactor(tx, factor, code, 'totp', key), false);
});
await test('production mailbox and email lifecycle fail closed; all new mutations require CSRF', async () => {
    const config = readConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://offline_test:offline_test@127.0.0.1:1/meal_planner_postgres',
        LOG_LEVEL: 'silent',
        FRONTEND_ORIGIN: 'https://meal.example',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    const app = await createApp(config);
    try {
        const missing = await app.inject({
            method: 'POST',
            url: '/api/v1/dev/mailbox',
            payload: { email: 'user@example.test' },
        });
        assert.equal(missing.statusCode, 403);
        const csrf = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
        const headers = {
            origin: config.FRONTEND_ORIGIN,
            cookie: csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
            'x-csrf-token': csrf.json<{ data: { token: string } }>().data.token,
        };
        for (const path of ['/api/v1/dev/mailbox', '/api/v1/auth/password/recovery', '/api/v1/auth/email/resend']) {
            const response = await app.inject({
                method: 'POST',
                url: path,
                headers,
                payload: { email: 'user@example.test' },
            });
            assert.equal(response.statusCode, 503);
            assert.equal(response.body.includes('user@example.test'), false);
        }
        const extra = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/totp/login',
            headers,
            payload: { email: 'user@example.test', code: '123456', context: 'admin' },
        });
        assert.equal(extra.statusCode, 400);
    } finally {
        await app.close();
    }
});

await test('password reset rate limit and token preflight run before password hashing', async () => {
    const { AccountService } = await import('../src/modules/account/account.service.js');
    const { BadRequestException, HttpException } = await import('@nestjs/common');
    const events: string[] = [];
    const database = {
        db: {},
        ready: () => Promise.resolve(true),
    } as unknown as import('../src/infrastructure/database/database.service.js').DatabaseService;
    let denied = false;
    const auth = {
        rateLimit: () => {
            events.push('rate');
            return denied ? Promise.reject(new HttpException('limited', 429)) : Promise.resolve();
        },
    } as unknown as import('../src/modules/auth/auth.service.js').AuthService;
    class Probe extends AccountService {
        override resetCheck(_value: string): Promise<{ valid: true }> {
            void _value;
            events.push('token');
            return Promise.reject(new BadRequestException());
        }
    }
    const config = readConfig({
        NODE_ENV: 'test',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    const service = new Probe(database, auth, config);
    // A non-string probe would synchronously fail scrypt if hashing ran before the token gate.
    const poison = Object.create(null) as string;
    await assert.rejects(service.reset('x'.repeat(43), poison, '127.0.0.1', randomUUID()), BadRequestException);
    assert.deepEqual(events, ['rate', 'token']);
    events.length = 0;
    denied = true;
    await assert.rejects(
        service.reset('x'.repeat(43), poison, '127.0.0.1', randomUUID()),
        (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
    );
    assert.deepEqual(events, ['rate']);
});
