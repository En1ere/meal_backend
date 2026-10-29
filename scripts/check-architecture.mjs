import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulesRoot = path.join(root, 'src', 'modules');
const sourceFiles = [];
const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.name.endsWith('.ts')) sourceFiles.push(target);
    }
};
walk(modulesRoot);

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

if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
} else console.log(`Architecture OK: ${sourceFiles.length} module files, ${graph.size} domain modules, no cycles.`);
