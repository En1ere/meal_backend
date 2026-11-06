import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulesRoot = path.join(root, 'src', 'modules');
const contextsRoot = path.join(root, 'src', 'contexts');
const architectureMapPath = path.join(root, 'docs', 'architecture', 'backend-context-map.json');
const approvedContexts = [
    'catalog-recipes',
    'community-content',
    'household-entitlements',
    'identity-access',
    'integrations',
    'inventory-commerce',
    'planning-health',
    'platform-operations',
];
const architecture = JSON.parse(fs.readFileSync(architectureMapPath, 'utf8'));
const mappedBoundaryModules = Object.values(architecture.contexts ?? {})
    .flat()
    .filter((module) => typeof module === 'string')
    .sort();
const publicBoundaryExceptions = new Map([]);
const legacyDeepImportBaselines = new Map([
    [
        'auth',
        {
            count: 149,
            sha256: '24f2b8619e1ba4eecb757338db694b0706400974b7a921067475374c97f5753c',
            reason: 'ADR-088: foundational auth implementation imports remain exact ratcheted migration debt',
        },
    ],
]);
const sourceFiles = [];
const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.name.endsWith('.ts')) sourceFiles.push(target);
    }
};
walk(modulesRoot);

const importConsumerFiles = [];
const walkConsumers = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walkConsumers(target);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs')) importConsumerFiles.push(target);
    }
};
for (const directory of ['src', 'test', 'scripts']) walkConsumers(path.join(root, directory));

const importPattern = /(?:from\s+|import\s*\()(['"])(\.\.?\/[^'"]+)\1/g;
const graph = new Map();
const violations = [];
for (const file of sourceFiles) {
    const sourceModule = path.relative(modulesRoot, file).split(path.sep)[0];
    const edges = graph.get(sourceModule) ?? new Set();
    graph.set(sourceModule, edges);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
        const resolved = path.resolve(path.dirname(file), match[2]);
        const relativeSource = path.relative(root, file).replaceAll(path.sep, '/');
        const relativeTarget = path.relative(root, resolved).replaceAll(path.sep, '/');
        if (relativeTarget.startsWith('src/app/'))
            violations.push(`${relativeSource}: domain modules must not import ${relativeTarget}`);
        if (!resolved.startsWith(modulesRoot + path.sep)) continue;
        const targetModule = path.relative(modulesRoot, resolved).split(path.sep)[0];
        if (targetModule !== sourceModule) edges.add(targetModule);
    }
}

for (const [module, reason] of publicBoundaryExceptions) {
    if (!mappedBoundaryModules.includes(module)) violations.push(`public-boundary exception is stale: ${module}`);
    if (typeof reason !== 'string' || reason.trim().length < 20)
        violations.push(`public-boundary exception ${module} must have a documented reason`);
}
for (const module of mappedBoundaryModules) {
    const moduleRoot = path.join(modulesRoot, module);
    const moduleSegment = `/modules/${module}/`;
    const publicApi = path.join(moduleRoot, 'public.ts');
    const exception = publicBoundaryExceptions.has(module);
    const deepImports = [];
    if (!fs.existsSync(moduleRoot)) {
        violations.push(`public-boundary module directory is missing: ${module}`);
        continue;
    }
    if (!fs.existsSync(publicApi) && !exception)
        violations.push(`module ${module} has no public.ts and no documented public-boundary exception`);
    if (fs.existsSync(publicApi) && exception)
        violations.push(`public-boundary exception ${module} is stale because public.ts exists`);
    for (const file of importConsumerFiles) {
        if (file.startsWith(moduleRoot + path.sep)) continue;
        for (const match of fs.readFileSync(file, 'utf8').matchAll(importPattern)) {
            const resolved = path.resolve(path.dirname(file), match[2]);
            const normalizedTarget = resolved.replaceAll(path.sep, '/');
            if (normalizedTarget.includes(moduleSegment) && !normalizedTarget.endsWith(`${moduleSegment}public.js`))
                deepImports.push(
                    `${path.relative(root, file).replaceAll(path.sep, '/')} -> ${path.relative(moduleRoot, resolved).replaceAll(path.sep, '/')}`,
                );
            if (normalizedTarget.includes(moduleSegment) && exception)
                violations.push(
                    `${path.relative(root, file).replaceAll(path.sep, '/')}: exception ${module} is externally imported`,
                );
        }
    }
    const baseline = legacyDeepImportBaselines.get(module);
    const canonicalDeepImports = [...new Set(deepImports)].sort();
    if (!baseline)
        for (const deepImport of canonicalDeepImports)
            violations.push(`${deepImport}: deep import into ${module}; use its public.js API`);
    else {
        const digest = createHash('sha256').update(canonicalDeepImports.join('\n')).digest('hex');
        if (
            typeof baseline.reason !== 'string' ||
            baseline.reason.trim().length < 20 ||
            baseline.count !== canonicalDeepImports.length ||
            baseline.sha256 !== digest
        )
            violations.push(
                `legacy deep-import baseline drift for ${module}: count=${canonicalDeepImports.length}, sha256=${digest}`,
            );
    }
}
for (const module of legacyDeepImportBaselines.keys())
    if (!mappedBoundaryModules.includes(module)) violations.push(`legacy deep-import baseline is stale: ${module}`);

for (const file of sourceFiles.filter((candidate) => path.basename(candidate) === 'public.ts')) {
    if (/export\s*\*\s*from/u.test(fs.readFileSync(file, 'utf8')))
        violations.push(
            `${path.relative(root, file).replaceAll(path.sep, '/')}: export-star is forbidden in public.ts`,
        );
}

const moduleNames = [...graph.keys()].sort();
if (architecture.schemaVersion !== 1) violations.push('architecture map schemaVersion must be 1');
const contexts = architecture.contexts;
if (!contexts || typeof contexts !== 'object' || Array.isArray(contexts)) {
    violations.push('architecture map contexts must be an object');
} else {
    const contextNames = Object.keys(contexts).sort();
    if (JSON.stringify(contextNames) !== JSON.stringify(approvedContexts))
        violations.push(`architecture map contexts must be exactly: ${approvedContexts.join(', ')}`);
    const ownership = new Map();
    for (const context of contextNames) {
        const modules = contexts[context];
        if (!Array.isArray(modules)) {
            violations.push(`architecture context ${context} must contain a module array`);
            continue;
        }
        if (JSON.stringify(modules) !== JSON.stringify([...modules].sort()))
            violations.push(`architecture context ${context} modules must be sorted`);
        for (const module of modules) {
            if (typeof module !== 'string') {
                violations.push(`architecture context ${context} contains a non-string module`);
                continue;
            }
            if (ownership.has(module))
                violations.push(`module ${module} is assigned to both ${ownership.get(module)} and ${context}`);
            else ownership.set(module, context);
        }
    }
    for (const module of moduleNames)
        if (!ownership.has(module)) violations.push(`module ${module} has no approved logical context`);
    for (const module of ownership.keys())
        if (!graph.has(module)) violations.push(`architecture map contains stale module ${module}`);
}

const edgeKey = (from, to) => `${from} -> ${to}`;
const actualEdges = [];
for (const [from, targets] of [...graph.entries()].sort(([left], [right]) => left.localeCompare(right)))
    for (const to of [...targets].sort()) actualEdges.push(edgeKey(from, to));

const allowedEdges = new Set();
if (!Array.isArray(architecture.allowedCrossModuleEdges)) {
    violations.push('architecture map allowedCrossModuleEdges must be an array');
} else {
    const baselineOrder = [];
    for (const edge of architecture.allowedCrossModuleEdges) {
        if (
            !edge ||
            typeof edge !== 'object' ||
            typeof edge.from !== 'string' ||
            typeof edge.to !== 'string' ||
            edge.from === edge.to
        ) {
            violations.push('architecture map contains an invalid cross-module edge');
            continue;
        }
        const key = edgeKey(edge.from, edge.to);
        baselineOrder.push(key);
        if (allowedEdges.has(key)) violations.push(`architecture map contains duplicate edge ${key}`);
        allowedEdges.add(key);
        if (!graph.has(edge.from) || !graph.has(edge.to)) violations.push(`architecture map edge is stale: ${key}`);
    }
    if (JSON.stringify(baselineOrder) !== JSON.stringify([...baselineOrder].sort()))
        violations.push('architecture map cross-module edges must be sorted');
}
for (const edge of actualEdges)
    if (!allowedEdges.has(edge)) violations.push(`unapproved cross-module dependency: ${edge}`);
for (const edge of allowedEdges)
    if (!actualEdges.includes(edge)) violations.push(`stale allowed cross-module dependency: ${edge}`);

const index = new Map();
const low = new Map();
const stack = [];
const active = new Set();
const components = [];
let nextIndex = 0;
const visit = (node) => {
    index.set(node, nextIndex);
    low.set(node, nextIndex++);
    stack.push(node);
    active.add(node);
    for (const target of graph.get(node) ?? []) {
        if (!index.has(target)) {
            visit(target);
            low.set(node, Math.min(low.get(node), low.get(target)));
        } else if (active.has(target)) low.set(node, Math.min(low.get(node), index.get(target)));
    }
    if (low.get(node) !== index.get(node)) return;
    const component = [];
    let current;
    do {
        current = stack.pop();
        active.delete(current);
        component.push(current);
    } while (current !== node);
    if (component.length > 1) components.push(component.sort());
};
for (const node of graph.keys()) if (!index.has(node)) visit(node);
for (const component of components) violations.push(`cyclic domain modules: ${component.join(' -> ')}`);

const readBalanced = (source, start) => {
    const pairs = { '(': ')', '[': ']', '{': '}' };
    const expected = pairs[source[start]];
    if (!expected) return null;
    const stack = [expected];
    let quote = null;
    let lineComment = false;
    let blockComment = false;
    for (let index = start + 1; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        if (lineComment) {
            if (character === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === '*' && next === '/') {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (character === '\\') index += 1;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '/' && next === '/') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (character === '/' && next === '*') {
            blockComment = true;
            index += 1;
            continue;
        }
        if (character === "'" || character === '"' || character === '`') {
            quote = character;
            continue;
        }
        if (pairs[character]) stack.push(pairs[character]);
        else if (character === stack.at(-1)) {
            stack.pop();
            if (stack.length === 0) return { body: source.slice(start + 1, index), end: index };
        }
    }
    return null;
};

const splitTopLevel = (source) => {
    const values = [];
    let start = 0;
    const pairs = { '(': ')', '[': ']', '{': '}' };
    const stack = [];
    let quote = null;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        if (quote) {
            if (character === '\\') index += 1;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === "'" || character === '"' || character === '`') {
            quote = character;
            continue;
        }
        if (pairs[character]) stack.push(pairs[character]);
        else if (character === stack.at(-1)) stack.pop();
        else if (character === ',' && stack.length === 0) {
            const value = source.slice(start, index).trim();
            if (value) values.push(value);
            start = index + 1;
        }
    }
    const value = source.slice(start).trim();
    if (value) values.push(value);
    return values;
};

const propertyArray = (source, property) => {
    const match = new RegExp(`\\b${property}\\s*:\\s*\\[`, 'u').exec(source);
    if (!match) return '';
    const open = source.indexOf('[', match.index);
    return readBalanced(source, open)?.body ?? null;
};

const moduleMetadata = (source, relativeFile) => {
    const decorator = source.indexOf('@Module(');
    if (decorator < 0) {
        violations.push(`${relativeFile}: context module has no @Module metadata`);
        return null;
    }
    const objectStart = source.indexOf('{', decorator);
    const result = readBalanced(source, objectStart);
    if (!result) violations.push(`${relativeFile}: @Module metadata is not statically balanced`);
    return result?.body ?? null;
};

const contextModuleFiles = [];
const walkContextModules = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walkContextModules(target);
        else if (entry.name.endsWith('.module.ts')) contextModuleFiles.push(target);
    }
};
walkContextModules(contextsRoot);
const contextModuleByClass = new Map();
const contextMetadata = new Map();
for (const file of contextModuleFiles) {
    const relativeFile = path.relative(root, file).replaceAll(path.sep, '/');
    const context = path.relative(contextsRoot, file).split(path.sep)[0];
    if (!approvedContexts.includes(context)) violations.push(`${relativeFile}: context folder is not approved`);
    const source = fs.readFileSync(file, 'utf8');
    if (/\bforwardRef\s*\(/u.test(source))
        violations.push(`${relativeFile}: forwardRef is forbidden in context modules`);
    const classMatch = /export\s+class\s+([A-Za-z_$][\w$]*Module)\b/u.exec(source);
    if (!classMatch) {
        violations.push(`${relativeFile}: context module has no exported *Module class`);
        continue;
    }
    const moduleClass = classMatch[1];
    if (contextModuleByClass.has(moduleClass))
        violations.push(`${relativeFile}: duplicate context module class ${moduleClass}`);
    else contextModuleByClass.set(moduleClass, file);
    const metadata = moduleMetadata(source, relativeFile);
    if (metadata !== null) contextMetadata.set(moduleClass, { file, metadata });
}

const capabilityGraph = new Map([...contextModuleByClass.keys()].map((moduleClass) => [moduleClass, new Set()]));
const controllerOwners = new Map();
const providerOwners = new Map();
const addOwner = (owners, token, owner) => {
    const current = owners.get(token) ?? [];
    current.push(owner);
    owners.set(token, current);
};
const identifier = /^[A-Za-z_$][\w$]*$/u;
const inspectOwnershipArray = (body, kind, owner) => {
    if (body === null) {
        violations.push(`${owner}: ${kind} metadata cannot be statically parsed`);
        return;
    }
    for (const entry of splitTopLevel(body)) {
        if (identifier.test(entry)) addOwner(kind === 'controllers' ? controllerOwners : providerOwners, entry, owner);
        else if (kind === 'providers' && entry.startsWith('{')) {
            const token = /\bprovide\s*:\s*([A-Za-z_$][\w$]*)\b/u.exec(entry)?.[1];
            if (token) addOwner(providerOwners, token, owner);
            else violations.push(`${owner}: provider declaration is not statically resolvable`);
        } else violations.push(`${owner}: ${kind} declaration is not statically resolvable: ${entry.slice(0, 80)}`);
    }
};

for (const [moduleClass, { file, metadata }] of contextMetadata) {
    const owner = path.relative(root, file).replaceAll(path.sep, '/');
    const imports = propertyArray(metadata, 'imports');
    if (imports === null) violations.push(`${owner}: imports metadata cannot be statically parsed`);
    else
        for (const importedModule of splitTopLevel(imports)) {
            if (!identifier.test(importedModule)) {
                violations.push(
                    `${owner}: capability import is not statically resolvable: ${importedModule.slice(0, 80)}`,
                );
                continue;
            }
            if (!contextModuleByClass.has(importedModule))
                violations.push(`${owner}: missing context module ${importedModule}`);
            else capabilityGraph.get(moduleClass).add(importedModule);
        }
    inspectOwnershipArray(propertyArray(metadata, 'controllers'), 'controllers', owner);
    inspectOwnershipArray(propertyArray(metadata, 'providers'), 'providers', owner);
}

const inspectRootProviders = (relativeFile) => {
    const source = fs.readFileSync(path.join(root, relativeFile), 'utf8');
    inspectOwnershipArray(propertyArray(source, 'providers'), 'providers', relativeFile);
};
inspectRootProviders('src/app/core-runtime.module.ts');
inspectRootProviders('src/app/app.module.ts');

for (const [controller, owners] of controllerOwners)
    if (owners.length > 1) violations.push(`duplicate controller ownership ${controller}: ${owners.join(', ')}`);
for (const [provider, owners] of providerOwners) {
    const rootGuardException =
        provider === 'APP_GUARD' && owners.length === 2 && owners.every((owner) => owner === 'src/app/app.module.ts');
    if (owners.length > 1 && !rootGuardException)
        violations.push(`duplicate provider/token ownership ${provider}: ${owners.join(', ')}`);
}
const appGuardOwners = providerOwners.get('APP_GUARD') ?? [];
if (appGuardOwners.length !== 2 || appGuardOwners.some((owner) => owner !== 'src/app/app.module.ts'))
    violations.push('APP_GUARD ownership exception must be exactly two root AppModule providers');

const capabilityIndex = new Map();
const capabilityLow = new Map();
const capabilityStack = [];
const activeCapabilities = new Set();
let nextCapabilityIndex = 0;
const visitCapability = (node) => {
    capabilityIndex.set(node, nextCapabilityIndex);
    capabilityLow.set(node, nextCapabilityIndex++);
    capabilityStack.push(node);
    activeCapabilities.add(node);
    for (const target of capabilityGraph.get(node) ?? []) {
        if (!capabilityIndex.has(target)) {
            visitCapability(target);
            capabilityLow.set(node, Math.min(capabilityLow.get(node), capabilityLow.get(target)));
        } else if (activeCapabilities.has(target))
            capabilityLow.set(node, Math.min(capabilityLow.get(node), capabilityIndex.get(target)));
    }
    if (capabilityLow.get(node) !== capabilityIndex.get(node)) return;
    const component = [];
    let current;
    do {
        current = capabilityStack.pop();
        activeCapabilities.delete(current);
        component.push(current);
    } while (current !== node);
    if (component.length > 1) violations.push(`cyclic capability modules: ${component.sort().join(' -> ')}`);
};
for (const node of capabilityGraph.keys()) if (!capabilityIndex.has(node)) visitCapability(node);

const appModuleSource = fs.readFileSync(path.join(root, 'src', 'app', 'app.module.ts'), 'utf8');
const appImports = propertyArray(appModuleSource, 'imports');
const reachableCapabilities = new Set();
const visitReachableCapability = (moduleClass) => {
    if (reachableCapabilities.has(moduleClass)) return;
    reachableCapabilities.add(moduleClass);
    for (const dependency of capabilityGraph.get(moduleClass) ?? []) visitReachableCapability(dependency);
};
if (appImports === null) violations.push('src/app/app.module.ts: imports metadata cannot be statically parsed');
else
    for (const entry of splitTopLevel(appImports)) {
        const moduleClass = /^([A-Za-z_$][\w$]*)/u.exec(entry)?.[1];
        if (moduleClass && contextModuleByClass.has(moduleClass)) visitReachableCapability(moduleClass);
    }
for (const moduleClass of contextModuleByClass.keys())
    if (!reachableCapabilities.has(moduleClass))
        violations.push(`stale context module is unreachable from AppModule: ${moduleClass}`);

if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
} else {
    console.log(
        `Architecture OK: ${sourceFiles.length} module files, ${graph.size} domain modules, ${contextModuleFiles.length} context modules, ${approvedContexts.length} logical contexts, ${actualEdges.length} approved cross-module edges, no cycles.`,
    );
}
