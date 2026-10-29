import {
    ConflictException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import type { Principal } from '../auth/auth.service.js';
import {
    acceptanceCatalog,
    acceptanceCatalogById,
    emptyCommentHash,
    type AcceptanceCatalogCase,
} from './admin-acceptance-tests.catalog.js';
import {
    acceptanceMutationResultSchema,
    acceptanceResetSchema,
    acceptanceUpdateSchema,
    acceptanceWorkspaceSchema,
    type AcceptanceMutationResult,
    type AcceptanceReset,
    type AcceptanceStatus,
    type AcceptanceUpdate,
    type AcceptanceWorkspace,
} from './admin-acceptance-tests.contracts.js';
import {
    AdminAcceptanceTestsRepository,
    type AcceptanceResultRow,
    type AcceptanceRunRow,
} from './admin-acceptance-tests.repository.js';

type Db = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;
const requestIdSchema = z.uuid();
const commentHash = (value: string) => createHash('sha256').update(value).digest('hex');
const requestHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

@Injectable()
export class AdminAcceptanceTestsService {
    constructor(
        private readonly repository: AdminAcceptanceTestsRepository,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
    ) {}

    async read(actor: Principal): Promise<AcceptanceWorkspace> {
        const db = await this.connection();
        await this.assertLiveAdmin(db, actor);
        const run = await this.repository.findRun(db, acceptanceCatalog.catalogVersion);
        const rows = run ? await this.repository.results(db, run.id) : [];
        return this.workspace(run, rows);
    }

    update(caseId: string, body: unknown, actor: Principal, requestId: string) {
        const input = acceptanceUpdateSchema.parse(body);
        return this.mutate(caseId, input, 'updated', actor, requestId);
    }

    reset(caseId: string, body: unknown, actor: Principal, requestId: string) {
        const input = acceptanceResetSchema.parse(body);
        return this.mutate(caseId, input, 'reset', actor, requestId);
    }

    private async mutate(
        caseId: string,
        input: AcceptanceUpdate | AcceptanceReset,
        action: 'updated' | 'reset',
        actor: Principal,
        requestId: string,
    ): Promise<AcceptanceMutationResult> {
        const item = acceptanceCatalogById.get(caseId);
        if (!item) throw new NotFoundException();
        await this.connection();
        return this.repository.transaction(async (tx) => {
            const actorRow = await this.assertLiveAdmin(tx, actor, true);
            const namespace = `admin:${actor.id}`;
            const operation = `admin.acceptance-tests.${action}`;
            const targetBinding = `${acceptanceCatalog.catalogVersion}:${item.id}`;
            const hash = requestHash([item.id, action, input]);
            const prior = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', namespace)
                .where('operation', '=', operation)
                .where('target_binding', '=', targetBinding)
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (prior) {
                if (prior.request_hash !== hash) throw new ConflictException('Idempotency key payload changed');
                return acceptanceMutationResultSchema.parse(prior.response_snapshot);
            }
            const run = await this.repository.ensureRun(tx, acceptanceCatalog, actor.id);
            const current = await this.repository.resultForUpdate(tx, run.id, item.id);
            const effective = current?.source_checksum === item.sourceChecksum ? current : null;
            const currentVersion = effective ? Number(effective.version) : 0;
            if (currentVersion !== input.expectedVersion)
                throw new ConflictException({
                    code: 'ACCEPTANCE_RESULT_CHANGED',
                    message: 'Результат проверки уже изменён',
                });
            if (action === 'reset' && (!effective || effective.status === 'not_tested'))
                throw new ConflictException({
                    code: 'ACCEPTANCE_RESULT_NOT_CHECKED',
                    message: 'Кейс уже находится на проверке',
                });
            const status: AcceptanceStatus = 'status' in input ? input.status : 'not_tested';
            const comment = 'comment' in input ? input.comment : (effective?.comment ?? '');
            const now = new Date();
            const nextVersion = current ? Number(current.version) + 1 : 1;
            if (!current) {
                await tx
                    .insertInto('acceptance_test_results')
                    .values({
                        run_id: run.id,
                        case_id: item.id,
                        source_checksum: item.sourceChecksum,
                        status,
                        comment,
                        checked_by: actor.id,
                        checked_at: now,
                        updated_at: now,
                        version: String(nextVersion),
                    })
                    .execute();
            } else {
                const updated = await tx
                    .updateTable('acceptance_test_results')
                    .set({
                        source_checksum: item.sourceChecksum,
                        status,
                        comment,
                        checked_by: actor.id,
                        checked_at: now,
                        updated_at: now,
                        version: String(nextVersion),
                    })
                    .where('run_id', '=', run.id)
                    .where('case_id', '=', item.id)
                    .where('version', '=', current.version)
                    .executeTakeFirst();
                if (Number(updated.numUpdatedRows) !== 1) throw new ConflictException('Acceptance result changed');
            }
            const beforeStatus: AcceptanceStatus = effective?.status ?? 'not_tested';
            const beforeComment = effective?.comment ?? '';
            await tx
                .insertInto('acceptance_test_events')
                .values({
                    id: randomUUID(),
                    run_id: run.id,
                    case_id: item.id,
                    source_checksum: item.sourceChecksum,
                    action,
                    before_status: beforeStatus,
                    after_status: status,
                    before_comment_hash: beforeComment ? commentHash(beforeComment) : emptyCommentHash,
                    after_comment_hash: comment ? commentHash(comment) : emptyCommentHash,
                    result_version: String(nextVersion),
                    actor_id: actor.id,
                    occurred_at: now,
                    request_id: requestIdSchema.safeParse(requestId).success ? requestId : randomUUID(),
                    idempotency_key: input.idempotencyKey,
                })
                .execute();
            const result = acceptanceMutationResultSchema.parse({
                caseId: item.id,
                run: { id: run.id, createdAt: run.createdAt.toISOString() },
                result: {
                    status,
                    comment,
                    version: nextVersion,
                    checkedBy: actorRow,
                    checkedAt: now.toISOString(),
                    updatedAt: now.toISOString(),
                },
            });
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation,
                    target_binding: targetBinding,
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
                    action: `admin.acceptance-tests.${action}`,
                    target_type: 'acceptance_test_case',
                    target_id: item.id,
                    actor_id: actor.id,
                    scope_id: null,
                    effective_at: now,
                    recorded_at: now,
                    request_id: requestIdSchema.safeParse(requestId).success ? requestId : randomUUID(),
                    reason: null,
                    before_redacted: { status: beforeStatus, version: currentVersion },
                    after_redacted: { status, version: nextVersion },
                })
                .execute();
            return result;
        });
    }

    private async connection() {
        const db = this.repository.connection();
        if (!db || !(await this.repository.ready())) throw new ServiceUnavailableException();
        return db;
    }

    private async assertLiveAdmin(db: Db, actor: Principal, lock = false) {
        let query = db
            .selectFrom('sessions')
            .innerJoin('users', 'users.id', 'sessions.user_id')
            .select(['users.id', 'users.login', 'users.display_name as displayName', 'users.is_test_account as isTest'])
            .where('sessions.id', '=', actor.sessionId)
            .where('users.id', '=', actor.id)
            .where('sessions.kind', '=', 'staff')
            .where('sessions.auth_context', '=', 'admin')
            .where('sessions.revoked_at', 'is', null)
            .where('sessions.expires_at', '>', new Date())
            .where('sessions.mfa_verified_at', 'is not', null)
            .where('users.status', '=', 'active')
            .where('users.archived_at', 'is', null)
            .where('users.email_verified_at', 'is not', null)
            .where((eb) =>
                eb.exists(
                    eb
                        .selectFrom('staff_role_assignments')
                        .select('id')
                        .whereRef('user_id', '=', 'users.id')
                        .where('role', '=', 'admin')
                        .where('revoked_at', 'is', null),
                ),
            )
            .where((eb) =>
                eb.exists(
                    eb
                        .selectFrom('mfa_factors')
                        .select('id')
                        .whereRef('user_id', '=', 'users.id')
                        .where('kind', '=', 'totp')
                        .where('verified_at', 'is not', null)
                        .where('revoked_at', 'is', null),
                ),
            );
        if (lock) query = query.forUpdate();
        const row = await query.executeTakeFirst();
        if (!row || actor.context !== 'admin' || (this.config.NODE_ENV === 'production' && row.isTest))
            throw new UnauthorizedException();
        return { id: row.id, login: row.login, displayName: row.displayName };
    }

    private result(row: AcceptanceResultRow | null, item: AcceptanceCatalogCase) {
        if (!row || row.sourceChecksum !== item.sourceChecksum)
            return {
                status: 'not_tested' as const,
                comment: '',
                version: 0,
                checkedBy: null,
                checkedAt: null,
                updatedAt: null,
            };
        return {
            status: row.status,
            comment: row.comment,
            version: Number(row.version),
            checkedBy:
                row.checkedById && row.checkedByLogin
                    ? { id: row.checkedById, login: row.checkedByLogin, displayName: row.checkedByDisplayName }
                    : null,
            checkedAt: row.checkedAt?.toISOString() ?? null,
            updatedAt: row.updatedAt.toISOString(),
        };
    }

    private workspace(run: AcceptanceRunRow | null, rows: readonly AcceptanceResultRow[]) {
        const byCase = new Map(rows.map((row) => [row.caseId, row] as const));
        const groups = acceptanceCatalog.groups
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((group) => ({
                ...group,
                cases: acceptanceCatalog.cases
                    .filter((item) => item.group === group.id)
                    .sort((a, b) => a.order - b.order)
                    .map((item) => ({
                        id: item.id,
                        displayCode: item.displayCode,
                        order: item.order,
                        title: item.title,
                        steps: item.steps,
                        expectedResult: item.expectedResult,
                        source: { file: item.sourceFile, anchor: item.sourceAnchor, checksum: item.sourceChecksum },
                        result: this.result(byCase.get(item.id) ?? null, item),
                    })),
            }));
        const results = groups.flatMap((group) => group.cases.map((item) => item.result));
        const count = (status: AcceptanceStatus) => results.filter((item) => item.status === status).length;
        const summary = {
            total: results.length,
            notTested: count('not_tested'),
            passed: count('passed'),
            partial: count('partial'),
            failed: count('failed'),
            completed: results.length - count('not_tested'),
        };
        return acceptanceWorkspaceSchema.parse({
            schemaVersion: 1,
            catalog: { version: acceptanceCatalog.catalogVersion, publishedOn: acceptanceCatalog.publishedOn },
            run: run ? { id: run.id, createdAt: run.createdAt.toISOString() } : null,
            summary,
            groups,
        });
    }
}
