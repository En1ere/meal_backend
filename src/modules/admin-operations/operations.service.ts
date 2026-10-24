import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { Principal } from '../auth/auth.service.js';
import { operationsCommandSchema, operationsResultSchema, type Operation } from './operations.contracts.js';

type Tx = Transaction<DatabaseSchema>;
type Input = ReturnType<typeof operationsCommandSchema.parse>;

export function operationAvailability(section: 'operations' | 'errors', kind: string, status: string) {
    if (section === 'errors')
        return (['new', 'in_progress', 'resolved', 'ignored'] as const).map((operation) => ({
            operation,
            enabled: true,
            reason: '',
        }));
    return [
        {
            operation: 'retry' as const,
            enabled: kind === 'recipe_import' && ['failed', 'dead_letter'].includes(status),
            reason:
                kind === 'recipe_import'
                    ? 'Повтор доступен только для неудавшегося импорта.'
                    : 'Для этого обработчика безопасный повтор ещё не поддержан.',
        },
        {
            operation: 'cancel' as const,
            enabled: kind === 'recipe_import' && ['pending', 'queued'].includes(status),
            reason:
                status === 'running'
                    ? 'Выполняющуюся задачу нельзя безопасно остановить.'
                    : 'Отмена доступна только для ожидающего импорта.',
        },
    ];
}

@Injectable()
export class OperationsWorkspaceService {
    constructor(private readonly database: DatabaseService) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    private descriptions: Record<Operation, string> = {
        retry: 'Импорт будет повторно поставлен в очередь. Результат импорта не гарантируется.',
        cancel: 'Ожидающий импорт будет отменён. Уже выполненные действия не откатываются.',
        new: 'Инцидент вернётся в новые. События и история сохранятся.',
        in_progress: 'Инцидент отмечается как взятый в работу.',
        resolved: 'Инцидент отмечается решённым. Это не подтверждение исправления кода.',
        ignored: 'Инцидент игнорируется до указанного срока. Сбор событий продолжается.',
    };

    private input(raw: unknown, action: Input['action']) {
        const input = operationsCommandSchema.parse(raw);
        if (input.action !== action) throw new BadRequestException();
        return input;
    }

    private async state(db: NonNullable<DatabaseService['db']> | Tx, input: Input) {
        if (input.section === 'operations') {
            const row = await db
                .selectFrom('background_jobs')
                .select(['id', 'kind', 'status', 'version'])
                .where('id', '=', input.id)
                .executeTakeFirst();
            if (!row) throw new NotFoundException();
            const status = row.status;
            const allowed = operationAvailability('operations', row.kind, status);
            return operationsResultSchema.parse({
                id: row.id,
                version: String(row.version),
                status,
                kind: row.kind,
                failure: 'Подробности сбоя доступны в связанном санитизированном журнале ошибок.',
                allowed,
                preview: null,
                message: '',
            });
        }
        const event = await db
            .selectFrom('admin_error_events')
            .leftJoin('admin_incident_states', 'admin_incident_states.event_id', 'admin_error_events.id')
            .select([
                'admin_error_events.id',
                'admin_error_events.code',
                'admin_error_events.message',
                'admin_error_events.version as event_version',
                'admin_incident_states.status',
                'admin_incident_states.ignored_until',
                'admin_incident_states.version as state_version',
            ])
            .where('admin_error_events.id', '=', input.id)
            .executeTakeFirst();
        if (!event) throw new NotFoundException();
        const status =
            event.status === 'ignored' && event.ignored_until && new Date(event.ignored_until) <= new Date()
                ? 'new'
                : (event.status ?? 'new');
        return operationsResultSchema.parse({
            id: event.id,
            version: String(event.state_version ?? event.event_version),
            status,
            kind: event.code,
            failure: event.message,
            allowed: operationAvailability('errors', event.code, status),
            preview: null,
            message: '',
        });
    }

    async inspect(raw: unknown) {
        return this.state(await this.db(), this.input(raw, 'inspect'));
    }

    async preview(raw: unknown) {
        const input = this.input(raw, 'preview');
        const result = await this.state(await this.db(), input);
        this.validate(input, result);
        return { ...result, preview: { summary: this.descriptions[input.operation], critical: false } };
    }

    execute(raw: unknown, actor: Principal, requestId: string) {
        const input = this.input(raw, 'execute');
        const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        return this.database.transaction(async (tx) => {
            const session = await tx
                .selectFrom('sessions')
                .innerJoin('users', 'users.id', 'sessions.user_id')
                .select('sessions.id')
                .where('sessions.id', '=', actor.sessionId)
                .where('sessions.user_id', '=', actor.id)
                .where('sessions.auth_context', '=', 'admin')
                .where('sessions.revoked_at', 'is', null)
                .where('sessions.expires_at', '>', new Date())
                .where('users.status', '=', 'active')
                .where('users.archived_at', 'is', null)
                .executeTakeFirst();
            if (!session || actor.context !== 'admin') throw new UnauthorizedException();
            const namespace = `admin:${actor.id}`;
            const previous = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', namespace)
                .where('operation', '=', 'admin.operations.execute')
                .where('target_binding', '=', input.id)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (previous) {
                if (previous.request_hash !== hash) throw new ConflictException('Idempotency key already used');
                return operationsResultSchema.parse(previous.response_snapshot);
            }
            const before = await this.state(tx, input);
            this.validate(input, before);
            if (input.section === 'operations') {
                await tx
                    .updateTable('background_jobs')
                    .set({
                        status: input.operation === 'retry' ? 'queued' : 'cancelled',
                        ...(input.operation === 'retry' ? { run_at: new Date() } : {}),
                        version: Number(before.version) + 1,
                    })
                    .where('id', '=', input.id)
                    .where('version', '=', before.version)
                    .executeTakeFirstOrThrow();
            } else {
                const existing = await tx
                    .selectFrom('admin_incident_states')
                    .select('id')
                    .where('event_id', '=', input.id)
                    .executeTakeFirst();
                await tx
                    .insertInto('admin_incident_states')
                    .values({
                        id: existing?.id ?? randomUUID(),
                        event_id: input.id,
                        status: input.operation as 'new' | 'in_progress' | 'resolved' | 'ignored',
                        ignored_until: input.operation === 'ignored' ? new Date(input.ignoreUntil!) : null,
                        reason: input.reason,
                        assigned_to: input.operation === 'in_progress' ? actor.id : null,
                        version: Number(before.version) + 1,
                    })
                    .onConflict((conflict) =>
                        conflict.column('event_id').doUpdateSet({
                            status: input.operation as 'new' | 'in_progress' | 'resolved' | 'ignored',
                            ignored_until: input.operation === 'ignored' ? new Date(input.ignoreUntil!) : null,
                            reason: input.reason,
                            assigned_to: input.operation === 'in_progress' ? actor.id : null,
                            updated_at: new Date(),
                            version: Number(before.version) + 1,
                        }),
                    )
                    .execute();
            }
            const after = await this.state(tx, input);
            const result = operationsResultSchema.parse({
                ...after,
                message: 'Изменение сохранено и записано в аудит.',
            });
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'admin.operations.execute',
                    target_binding: input.id,
                    key: input.idempotencyKey,
                    request_hash: hash,
                    status: 'completed',
                    response_snapshot: result,
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: actor.id,
                    scope_id: null,
                    actor_namespace: namespace,
                })
                .execute();
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: `admin.operations.${input.operation}`,
                    target_type: input.section,
                    target_id: input.id,
                    actor_id: actor.id,
                    scope_id: null,
                    effective_at: new Date(),
                    recorded_at: new Date(),
                    request_id: requestId,
                    reason: input.reason,
                    before_redacted: { status: before.status },
                    after_redacted: { status: result.status },
                })
                .execute();
            return result;
        });
    }

    private validate(input: Input, result: ReturnType<typeof operationsResultSchema.parse>) {
        if (result.version !== input.expectedVersion) throw new ConflictException('State changed');
        if (!input.reason) throw new ConflictException('Reason required');
        if (!result.allowed.some((item) => item.operation === input.operation && item.enabled))
            throw new ConflictException('Operation unavailable');
        if (
            input.operation === 'ignored' &&
            (!input.ignoreUntil || new Date(input.ignoreUntil).getTime() <= Date.now())
        )
            throw new ConflictException('Future ignore date required');
    }
}
