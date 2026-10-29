import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { AcceptanceCatalog } from './admin-acceptance-tests.catalog.js';
import type { AcceptanceStatus } from './admin-acceptance-tests.contracts.js';

type Db = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;
type Tx = Transaction<DatabaseSchema>;

export type AcceptanceRunRow = Readonly<{ id: string; createdAt: Date }>;
export type AcceptanceResultRow = Readonly<{
    caseId: string;
    sourceChecksum: string;
    status: AcceptanceStatus;
    comment: string;
    version: string;
    checkedAt: Date | null;
    updatedAt: Date;
    checkedById: string | null;
    checkedByLogin: string | null;
    checkedByDisplayName: string | null;
}>;

@Injectable()
export class AdminAcceptanceTestsRepository {
    constructor(private readonly database: DatabaseService) {}

    connection() {
        return this.database.db;
    }

    ready() {
        return this.database.ready();
    }

    transaction<T>(work: (tx: Tx) => Promise<T>) {
        return this.database.transaction(work);
    }

    async findRun(db: Db, catalogVersion: string): Promise<AcceptanceRunRow | null> {
        return (
            (await db
                .selectFrom('acceptance_test_runs')
                .select(['id', 'created_at as createdAt'])
                .where('catalog_version', '=', catalogVersion)
                .executeTakeFirst()) ?? null
        );
    }

    async ensureRun(tx: Tx, catalog: AcceptanceCatalog, actorId: string): Promise<AcceptanceRunRow> {
        await tx
            .insertInto('acceptance_test_runs')
            .values({
                id: sql`gen_random_uuid()`,
                catalog_version: catalog.catalogVersion,
                catalog_published_on: catalog.publishedOn,
                created_by: actorId,
            })
            .onConflict((conflict) => conflict.column('catalog_version').doNothing())
            .execute();
        const run = await this.findRun(tx, catalog.catalogVersion);
        if (!run) throw new Error('Acceptance test run was not created');
        return run;
    }

    async results(db: Db, runId: string): Promise<readonly AcceptanceResultRow[]> {
        return db
            .selectFrom('acceptance_test_results as result')
            .leftJoin('users as checker', 'checker.id', 'result.checked_by')
            .select([
                'result.case_id as caseId',
                'result.source_checksum as sourceChecksum',
                'result.status',
                'result.comment',
                'result.version',
                'result.checked_at as checkedAt',
                'result.updated_at as updatedAt',
                'checker.id as checkedById',
                'checker.login as checkedByLogin',
                'checker.display_name as checkedByDisplayName',
            ])
            .where('result.run_id', '=', runId)
            .orderBy('result.case_id')
            .limit(100)
            .execute();
    }

    async resultForUpdate(tx: Tx, runId: string, caseId: string) {
        return (
            (await tx
                .selectFrom('acceptance_test_results')
                .select(['source_checksum', 'status', 'comment', 'checked_by', 'checked_at', 'updated_at', 'version'])
                .where('run_id', '=', runId)
                .where('case_id', '=', caseId)
                .forUpdate()
                .executeTakeFirst()) ?? null
        );
    }
}
