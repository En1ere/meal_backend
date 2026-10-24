import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import type { Principal } from '../src/modules/auth/auth.service.js';
import { AdminActionsService, supportTransition } from '../src/modules/admin-actions/admin-actions.service.js';
import {
    preferenceChangeSchema,
    supportReplySchema,
    supportMessagesSearchSchema,
} from '../src/modules/admin-actions/admin-actions.contracts.js';

const actor: Principal = {
    id: randomUUID(),
    sessionId: randomUUID(),
    context: 'admin',
    displayName: 'Admin',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
};
function memoryService(rows: Record<string, unknown>, writes: string[]) {
    function builder(table: string, write = false) {
        const query = {
            select() {
                return query;
            },
            innerJoin() {
                return query;
            },
            where() {
                return query;
            },
            forUpdate() {
                return query;
            },
            executeTakeFirst() {
                return Promise.resolve(rows[table]);
            },
            executeTakeFirstOrThrow() {
                return Promise.resolve(rows[table]);
            },
            values() {
                return query;
            },
            execute() {
                if (write) writes.push(table);
                return Promise.resolve(write ? [] : (rows[table] ?? []));
            },
        };
        return query;
    }
    const tx = { selectFrom: builder, insertInto: (table: string) => builder(table, true) };
    const database = {
        db: {},
        ready: () => Promise.resolve(true),
        transaction: (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    } as unknown as DatabaseService;
    return new AdminActionsService(database);
}
await test('notification preferences default off, project mobile channel, and reject unverified email before writes', async () => {
    const writes: string[] = [];
    const rows: Record<string, unknown> = {
        sessions: { id: actor.sessionId },
        users: { id: actor.id, email_normalized: 'admin@example.test', email_verified_at: new Date() },
    };
    const service = memoryService(rows, writes);
    assert.deepEqual(await service.preferences(actor, randomUUID()), {
        preferences: { browser: false, mobilePush: false, email: false },
        verifiedEmail: 'admin@example.test',
    });
    rows.notification_preferences = [{ channel: 'mobile_push', enabled: true }];
    assert.equal((await service.preferences(actor, randomUUID())).preferences.mobilePush, true);
    rows.users = { id: actor.id, email_normalized: 'admin@example.test', email_verified_at: null };
    writes.length = 0;
    await assert.rejects(
        service.preferences(actor, randomUUID(), { channel: 'email', enabled: true }),
        ConflictException,
    );
    assert.deepEqual(writes, []);
});
await test('admin support commands bound input and enforce legal state transitions', () => {
    const input = { body: '  Reply  ', version: '1', idempotencyKey: randomUUID() };
    assert.equal(supportReplySchema.parse(input).body, 'Reply');
    for (const body of ['', ' '.repeat(3), 'a'.repeat(10001)])
        assert.equal(supportReplySchema.safeParse({ ...input, body }).success, false);
    assert.equal(supportReplySchema.safeParse({ ...input, assigneeId: actor.id }).success, false);
    assert.equal(
        preferenceChangeSchema.safeParse({ channel: 'email', enabled: true, email: 'other@example.test' }).success,
        false,
    );
    assert.equal(supportMessagesSearchSchema.safeParse({ limit: 51 }).success, false);
    assert.equal(supportTransition('open', 'reply'), 'waiting_for_user');
    assert.equal(supportTransition('closed', 'reopen'), 'waiting_for_support');
    assert.throws(() => supportTransition('closed', 'reply'), ConflictException);
    assert.throws(() => supportTransition('open', 'reopen'), ConflictException);
});
await test('fresh transactional authorization precedes idempotency replay and all writes', async () => {
    const writes: string[] = [];
    const service = memoryService({ sessions: undefined }, writes);
    await assert.rejects(
        service.support(randomUUID(), 'reopen', { version: '1', idempotencyKey: randomUUID() }, actor, randomUUID()),
        UnauthorizedException,
    );
    assert.deepEqual(writes, []);
});
await test('support idempotency replay returns original result without another message and rejects changed payload', async () => {
    const writes: string[] = [],
        ticketId = randomUUID();
    const input = { body: 'Reply', version: '1', idempotencyKey: randomUUID() };
    const response = {
        ticketId,
        version: '2',
        status: 'waiting_for_user',
        assigneeId: actor.id,
        messageId: randomUUID(),
    };
    const requestHash = createHash('sha256')
        .update(JSON.stringify([ticketId, 'reply', input.version, input.body]))
        .digest('hex');
    const service = memoryService(
        {
            sessions: { id: actor.sessionId },
            users: { id: actor.id },
            idempotency_records: { request_hash: requestHash, response_snapshot: response },
        },
        writes,
    );
    assert.deepEqual(await service.support(ticketId, 'reply', input, actor, randomUUID()), response);
    assert.deepEqual(writes, ['audit_events']);
    await assert.rejects(
        service.support(ticketId, 'reply', { ...input, body: 'Different' }, actor, randomUUID()),
        ConflictException,
    );
    assert.deepEqual(writes, ['audit_events']);
});
await test('support stale version is rejected before any message/event/idempotency write', async () => {
    const writes: string[] = [],
        ticketId = randomUUID();
    const service = memoryService(
        {
            sessions: { id: actor.sessionId },
            users: { id: actor.id },
            support_tickets: { id: ticketId, version: '2', status: 'open' },
        },
        writes,
    );
    await assert.rejects(
        service.support(
            ticketId,
            'reply',
            { body: 'Reply', version: '1', idempotencyKey: randomUUID() },
            actor,
            randomUUID(),
        ),
        ConflictException,
    );
    assert.deepEqual(writes, []);
});
