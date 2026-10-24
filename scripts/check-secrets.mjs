// Lightweight repository check, not a guarantee that arbitrary secrets cannot be committed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const list = spawnSync(
    'git',
    [
        '-c',
        `safe.directory=${path.resolve(root, '..')}`,
        '-c',
        `safe.directory=${root}`,
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '.',
    ],
    { cwd: root, encoding: 'utf8', shell: false },
);
if (list.status !== 0) throw Error('Secret check requires the repository file inventory');
const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /AKIA[0-9A-Z]{16}/,
    /ghp_[A-Za-z0-9]{36}/,
    /postgres(?:ql)?:\/\/[^\s:]+:[a-f0-9]{64}@/,
];
const violations = [];
for (const file of list.stdout.split('\0').filter(Boolean)) {
    if (/(^|\/)(\.local|backups)(\/|$)|(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')) {
        violations.push(file);
        continue;
    }
    const absolute = path.resolve(root, file);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).size > 2_000_000) continue;
    if (/\.(png|jpg|woff2?|ico|dump)$/.test(file)) continue;
    const value = fs.readFileSync(absolute, 'utf8');
    if (patterns.some((pattern) => pattern.test(value))) violations.push(file);
}
if (violations.length) {
    console.error('Potential secret files (values suppressed): ' + [...new Set(violations)].join(', '));
    process.exitCode = 1;
} else console.log('Repository secret patterns: no matches; private env/backup files not tracked');
