import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

interface ArchitectureMap {
    readonly schemaVersion: number;
    readonly contexts: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly allowedCrossModuleEdges: ReadonlyArray<Readonly<{ from: string; to: string }>>;
}

const modulesRoot = path.resolve('src/modules');
const sourceFiles: string[] = [];
function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.name.endsWith('.ts')) sourceFiles.push(target);
    }
}
walk(modulesRoot);

const importPattern = /(?:from\s+|import\s*\()(['"])(\.\.?\/[^'"]+)\1/g;
const modules = readdirSync(modulesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
const currentEdges = new Set<string>();
for (const file of sourceFiles) {
    const from = path.relative(modulesRoot, file).split(path.sep)[0]!;
    for (const match of readFileSync(file, 'utf8').matchAll(importPattern)) {
        const resolved = path.resolve(path.dirname(file), match[2]!);
        if (!resolved.startsWith(modulesRoot + path.sep)) continue;
        const to = path.relative(modulesRoot, resolved).split(path.sep)[0]!;
        if (from !== to) currentEdges.add(`${from} -> ${to}`);
    }
}

const architecture = JSON.parse(readFileSync('docs/architecture/backend-context-map.json', 'utf8')) as ArchitectureMap;

void test('all backend modules have exactly one approved logical context', () => {
    assert.equal(architecture.schemaVersion, 1);
    assert.deepEqual(Object.keys(architecture.contexts).sort(), [
        'catalog-recipes',
        'community-content',
        'household-entitlements',
        'identity-access',
        'integrations',
        'inventory-commerce',
        'planning-health',
        'platform-operations',
    ]);
    const assigned = Object.values(architecture.contexts).flat();
    assert.equal(new Set(assigned).size, assigned.length, 'a module cannot belong to two contexts');
    assert.deepEqual([...assigned].sort(), modules);
    assert.equal(modules.length, 69);
});

void test('cross-module dependency baseline exactly matches the current graph', () => {
    const baseline = architecture.allowedCrossModuleEdges.map(({ from, to }) => `${from} -> ${to}`);
    assert.equal(new Set(baseline).size, baseline.length, 'baseline edges must be unique');
    assert.deepEqual(baseline, [...baseline].sort(), 'baseline edges must be canonical');
    assert.deepEqual(baseline, [...currentEdges].sort());
    assert.equal(baseline.length, 155);
});

void test('architecture checker keeps fail-closed ownership and edge diagnostics', () => {
    const checker = readFileSync('scripts/check-architecture.mjs', 'utf8');
    assert.match(checker, /domain modules must not import/);
    assert.match(checker, /cyclic domain modules/);
    assert.match(checker, /has no approved logical context/);
    assert.match(checker, /is assigned to both/);
    assert.match(checker, /unapproved cross-module dependency/);
    assert.match(checker, /stale allowed cross-module dependency/);
    assert.match(checker, /deep import into/);
    assert.match(checker, /export-star is forbidden/);
    assert.match(checker, /forwardRef is forbidden/);
    assert.match(checker, /cyclic capability modules/);
    assert.match(checker, /stale context module is unreachable/);
    assert.match(checker, /duplicate controller ownership/);
    assert.match(checker, /duplicate provider\/token ownership/);
    assert.match(checker, /APP_GUARD ownership exception/);
});

void test('every mapped domain module has an explicit non-wildcard public API', () => {
    for (const module of modules) {
        const publicApi = path.join(modulesRoot, module, 'public.ts');
        assert.equal(existsSync(publicApi), true, `${module} must expose public.ts`);
        assert.doesNotMatch(readFileSync(publicApi, 'utf8'), /export\s*\*\s*from/u, module);
    }
});

void test('the four closure gaps cannot regress to external deep imports', () => {
    const consumerFiles: string[] = [];
    const collect = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) collect(target);
            else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs')) consumerFiles.push(target);
        }
    };
    for (const directory of ['src', 'test', 'scripts']) collect(path.resolve(directory));
    for (const module of ['account-mail', 'legal-runtime', 'media-processing', 'web-push']) {
        const moduleRoot = path.join(modulesRoot, module);
        const moduleSegment = `/modules/${module}/`;
        for (const file of consumerFiles) {
            if (file.startsWith(moduleRoot + path.sep)) continue;
            for (const match of readFileSync(file, 'utf8').matchAll(importPattern)) {
                const resolved = path.resolve(path.dirname(file), match[2]!);
                const normalizedTarget = resolved.replaceAll(path.sep, '/');
                if (normalizedTarget.includes(moduleSegment))
                    assert.equal(normalizedTarget.endsWith(`${moduleSegment}public.js`), true, file);
            }
        }
    }
});

void test('architecture checker accepts the complete capability and public-boundary graph', () => {
    const result = spawnSync(process.execPath, ['scripts/check-architecture.mjs'], { encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /81 context modules/);
    assert.match(result.stdout, /155 approved cross-module edges/);
});
