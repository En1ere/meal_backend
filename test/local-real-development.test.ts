import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const text = async (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

void test('local database bootstrap is explicit, persistent and development-only', async () => {
    const script = await text('scripts/local-development-database.ps1');

    assert.match(script, /ValidateSet\('Plan', 'Create', 'Start', 'Status', 'Stop'\)/);
    assert.match(script, /127\.0\.0\.1:\$port/);
    assert.match(script, /\$port = 54329/);
    assert.match(script, /--environment=development/);
    assert.match(script, /database\\reference-data\.sql/);
    assert.match(script, /database\\application-grants\.sql/);
    assert.match(script, /LEGAL_EVIDENCE_MODE=demonstration/);
    assert.match(script, /meal_app\|42\|7\|3/);
    assert.match(script, /The local database or its settings already exist/);
    assert.doesNotMatch(script, /ValidateSet\([^)]*(?:Delete|Reset)/);
    assert.doesNotMatch(script, /Remove-Item[^\r\n]*-Recurse/);
});

void test('one-command real launcher forces real transports and verifies the full route', async () => {
    const launcher = await text('scripts/start-local-real.mjs');
    const packageJson = JSON.parse(await text('package.json')) as {
        scripts: Record<string, string>;
    };

    assert.match(launcher, /NEXT_PUBLIC_API_MODE: 'real'/);
    assert.match(launcher, /VITE_API_MODE: 'real'/);
    assert.match(launcher, /NEXT_PUBLIC_LEGAL_EVIDENCE_MODE: 'demonstration'/);
    assert.match(launcher, /\['run', 'test:integration'\]/);
    assert.match(launcher, /health\/ready/);
    assert.doesNotMatch(launcher, /API_MODE: 'mock'/);
    assert.equal(packageJson.scripts['local:real'], 'node scripts/start-local-real.mjs');
    assert.equal(packageJson.scripts['local:real:check'], 'node scripts/start-local-real.mjs --check');
    assert.equal(
        packageJson.scripts['admin:bootstrap'],
        'node --env-file-if-exists=.local/backend.env --env-file-if-exists=.env scripts/admin-bootstrap.mjs',
    );
});
