import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
    acceptanceCatalog,
    validateAcceptanceCatalog,
} from '../src/modules/admin-acceptance-tests/admin-acceptance-tests.catalog.js';
import {
    acceptanceResetSchema,
    acceptanceUpdateSchema,
    acceptanceWorkspaceSchema,
} from '../src/modules/admin-acceptance-tests/admin-acceptance-tests.contracts.js';

void test('acceptance catalog has stable unique identities and complete four-repository coverage', () => {
    assert.equal(acceptanceCatalog.cases.length, 83);
    assert.deepEqual(
        Object.fromEntries(
            acceptanceCatalog.groups.map((group) => [
                group.id,
                acceptanceCatalog.cases.filter((item) => item.group === group.id).length,
            ]),
        ),
        { database: 13, backend: 25, admin: 17, frontend: 28 },
    );
    assert.equal(new Set(acceptanceCatalog.cases.map((item) => item.id)).size, 83);
    assert.equal(new Set(acceptanceCatalog.cases.map((item) => item.displayCode)).size, 83);
    assert.ok(acceptanceCatalog.cases.every((item) => item.steps.length > 0));
    assert.ok(acceptanceCatalog.cases.every((item) => /^[0-9a-f]{64}$/.test(item.sourceChecksum)));
    assert.ok(
        acceptanceCatalog.cases.every((item) => !/^\w+-\d+$/.test(item.id)),
        'semantic ids do not depend on order',
    );
});

void test('catalog checksum version rejects unversioned content drift', () => {
    const changed = structuredClone(acceptanceCatalog);
    changed.cases[0]!.title = `${changed.cases[0]!.title} changed`;
    assert.throws(() => validateAcceptanceCatalog(changed), /version\/checksum mismatch/);
    const duplicate = structuredClone(acceptanceCatalog);
    duplicate.cases[1]!.id = duplicate.cases[0]!.id;
    assert.throws(() => validateAcceptanceCatalog(duplicate));
});

void test('acceptance mutation contracts are strict, bounded and separate reset from outcomes', () => {
    const common = { expectedVersion: 0, idempotencyKey: '00000000-0000-4000-8000-000000000001' };
    assert.equal(
        acceptanceUpdateSchema.parse({ ...common, status: 'partial', comment: 'Needs retest' }).status,
        'partial',
    );
    assert.equal(acceptanceResetSchema.parse(common).expectedVersion, 0);
    assert.throws(() => acceptanceUpdateSchema.parse({ ...common, status: 'not_tested', comment: '' }));
    assert.throws(() => acceptanceUpdateSchema.parse({ ...common, status: 'passed', comment: 'x'.repeat(1001) }));
    assert.throws(() => acceptanceResetSchema.parse({ ...common, comment: 'must not be accepted' }));
});

void test('workspace schema invalidates unpersisted cases to an explicit zero-version result', () => {
    const groups = acceptanceCatalog.groups.map((group) => ({
        ...group,
        cases: acceptanceCatalog.cases
            .filter((item) => item.group === group.id)
            .map((item) => ({
                id: item.id,
                displayCode: item.displayCode,
                order: item.order,
                title: item.title,
                steps: item.steps,
                expectedResult: item.expectedResult,
                source: { file: item.sourceFile, anchor: item.sourceAnchor, checksum: item.sourceChecksum },
                result: {
                    status: 'not_tested',
                    comment: '',
                    version: 0,
                    checkedBy: null,
                    checkedAt: null,
                    updatedAt: null,
                },
            })),
    }));
    const parsed = acceptanceWorkspaceSchema.parse({
        schemaVersion: 1,
        catalog: { version: acceptanceCatalog.catalogVersion, publishedOn: acceptanceCatalog.publishedOn },
        run: null,
        summary: { total: 83, notTested: 83, passed: 0, partial: 0, failed: 0, completed: 0 },
        groups,
    });
    assert.equal(parsed.summary.notTested, 83);
    assert.equal(parsed.groups[0]!.cases[0]!.result.version, 0);
});

void test('migration enforces immutable events, CAS identity, idempotency and least-privilege grants', async () => {
    const migration = await readFile(
        new URL('../../database/migrations/030_admin_acceptance_testing.sql', import.meta.url),
        'utf8',
    );
    const grants = await readFile(new URL('../../database/application-grants.sql', import.meta.url), 'utf8');
    const service = await readFile(
        new URL('../../src/modules/admin-acceptance-tests/admin-acceptance-tests.service.ts', import.meta.url),
        'utf8',
    );
    assert.match(migration, /UNIQUE \(actor_id, action, run_id, case_id, idempotency_key\)/);
    assert.match(migration, /protect_acceptance_result_identity/);
    assert.match(migration, /immutable_rows BEFORE UPDATE OR DELETE ON meal\.acceptance_test_runs/);
    assert.match(migration, /immutable_rows BEFORE UPDATE OR DELETE ON meal\.acceptance_test_events/);
    assert.doesNotMatch(
        migration,
        /protect_scope_and_identity\(\);\s*\n\s*CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON meal\.acceptance_test_events/,
    );
    assert.match(grants, /UPDATE\(source_checksum,status,comment,checked_by,checked_at,updated_at,version\)/);
    assert.doesNotMatch(grants, /UPDATE ON meal\.acceptance_test_events/);
    assert.match(service, /ACCEPTANCE_RESULT_CHANGED/);
    assert.match(service, /Idempotency key payload changed/);
    assert.match(service, /source_checksum === item\.sourceChecksum/);
    assert.match(service, /admin\.acceptance-tests\.\$\{action\}/);
});
