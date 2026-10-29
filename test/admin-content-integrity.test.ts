import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
    new URL('../../src/modules/admin-content/admin-content.service.ts', import.meta.url),
    'utf8',
);
const grants = readFileSync(new URL('../../database/application-grants.sql', import.meta.url), 'utf8');
const acceptance = readFileSync(new URL('../../scripts/acceptance/admin-domain.mjs', import.meta.url), 'utf8');
const liveAcceptance = readFileSync(new URL('../../scripts/test-postgres-live.mjs', import.meta.url), 'utf8');

await test('catalog effects bind the route target and revalidate admin role inside the transaction', () => {
    assert.match(source, /this\.assertPairTarget\(params\.id, input\.leftId, input\.rightId\)/);
    assert.match(source, /await this\.access\.assertAdminRole\(tx, actor\)/);
    const merge = source.slice(source.indexOf('async merge('), source.indexOf('async notDuplicate('));
    const role = merge.indexOf('await this.access.assertAdminRole(tx, actor)');
    const replay = merge.indexOf("this.replay(tx, actor, params.id, 'admin.content.merge'");
    assert.ok(role >= 0 && replay > role, 'fresh admin role must precede merge replay');
});

await test('recipe moderation requires a fresh critical admin window before replay or effects', () => {
    const moderate = source.slice(source.indexOf('async moderate('), source.indexOf('async merge('));
    const role = moderate.indexOf('await this.access.assertAdminRole(tx, actor)');
    const critical = moderate.indexOf('await this.access.assertCritical(tx, actor)');
    const replay = moderate.indexOf('if (await this.replay(');
    const lock = moderate.indexOf(".selectFrom('moderation_cases')");
    assert.ok(role >= 0 && critical > role, 'critical confirmation follows fresh role validation');
    assert.ok(replay > critical, 'expired critical confirmation must reject even an idempotent replay');
    assert.ok(lock > replay, 'critical and replay gates must precede target mutation locks');
    assert.match(acceptance, /admin content missing unlock proof/);
    assert.match(acceptance, /admin content stale unlock proof/);
    assert.match(acceptance, /admin content missing critical confirmation/);
    assert.match(acceptance, /admin content expired critical confirmation/);
});

await test('merge locks the exact pair and performs version-bound writes from a fresh comparison', () => {
    const merge = source.slice(source.indexOf('async merge('), source.indexOf('async notDuplicate('));
    assert.match(merge, /const cards = await this\.cards\(tx, pair, true\)/);
    assert.match(merge, /const comparison = compareContentCards\(left, right/);
    assert.match(merge, /comparison\.previewKey !== input\.previewKey/);
    assert.match(merge, /\.where\('version', '=', String\(canonicalCard\.version\)\)/);
    assert.match(merge, /\.where\('version', '=', String\(source\.version\)\)/);
    assert.match(merge, /numUpdatedRows !== 1n/);
    assert.doesNotMatch(merge, /const preview = await this\.compare/);
});

await test('current-version not-duplicate decisions gate compare, merge and duplicate decisions', () => {
    assert.match(source, /private async assertPairAvailable/);
    assert.match(source, /notDuplicateDecisionApplies/);
    assert.ok((source.match(/await this\.assertPairAvailable\(/g) ?? []).length >= 3);
    assert.match(
        grants,
        /GRANT SELECT\([^;]*preview[^;]*\) ON meal\.catalog_merges TO meal_app;/,
        'least-privilege role must be able to read the version-bound not-duplicate preview',
    );
    assert.match(acceptance, /backupAdminRoleId/);
    assert.match(acceptance, /ids\.backupAdmin/);
    assert.match(liveAcceptance, /remoteAddress: '198\.26\.254\.1'/);
    assert.match(liveAcceptance, /target_binding=\$1::text and key=\$4/);
    assert.match(liveAcceptance, /const \{ backupAdminRoleId \} = await runAdminDomainAcceptance/);
});
