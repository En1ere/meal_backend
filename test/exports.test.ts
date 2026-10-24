import assert from 'node:assert/strict';
import test from 'node:test';
import { exportManifestSchema, exportPreviewRequestSchema } from '../src/modules/exports/exports.contracts.js';
import { exportDataThrough, isProExportDomain, proExportSections } from '../src/modules/exports/exports.policy.js';

const userId = '10000000-0000-4000-8000-000000000001';

void test('Pro export contract keeps the legacy personal manifest readable and constrains scope and format', () => {
    const legacy = exportManifestSchema.parse({
        schemaVersion: '2026-10-06',
        selection: {
            scope: 'private',
            domain: 'personal_data',
            format: 'json',
            startsOn: null,
            endsOn: null,
        },
        scopeId: userId,
        familyId: null,
        requesterId: userId,
        sections: [{ code: 'profile', label: 'Профиль', detail: 'Личные данные.', ownership: 'requester' }],
        exclusions: [],
        aclSnapshotAt: '2026-10-06T10:00:00.000Z',
    });
    assert.equal(legacy.proAccess, null);
    assert.equal(
        exportPreviewRequestSchema.safeParse({
            scope: 'private',
            domain: 'personal_data',
            format: 'csv',
            startsOn: null,
            endsOn: null,
        }).success,
        false,
    );
    assert.equal(
        exportPreviewRequestSchema.safeParse({
            scope: 'family',
            domain: 'finance',
            format: 'pdf',
            startsOn: null,
            endsOn: null,
        }).success,
        false,
    );
});

void test('Pro manifest domains have deterministic sections and a bounded data cutoff', () => {
    assert.equal(isProExportDomain('personal_data'), false);
    assert.equal(isProExportDomain('all_pro_data'), true);
    assert.deepEqual(
        proExportSections('all_pro_data').map(([code]) => code),
        [
            'diary_entries',
            'diary_portions',
            'finance_expenses',
            'finance_budgets',
            'finance_prices',
            'finance_receipts',
            'nutrition_profile',
            'nutrition_targets',
        ],
    );
    assert.equal(
        exportDataThrough(
            { scope: 'private', domain: 'diary', format: 'csv', startsOn: null, endsOn: '2026-12-31' },
            new Date('2026-10-09T12:00:00.000Z'),
            '2026-11-01T00:00:00.000Z',
        ),
        '2026-10-09',
    );
});
