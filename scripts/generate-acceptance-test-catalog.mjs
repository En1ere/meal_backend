import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
    {
        group: 'database',
        prefix: 'DB',
        file: resolve(root, 'docs/DATABASE_TESTING.md'),
        sourceFile: 'meal_backend/docs/DATABASE_TESTING.md',
    },
    {
        group: 'backend',
        prefix: 'API',
        file: resolve(root, 'docs/BACKEND_TESTING.md'),
        sourceFile: 'meal_backend/docs/BACKEND_TESTING.md',
    },
    {
        group: 'admin',
        prefix: 'ADMIN',
        file: resolve(root, '../meal_admin/ADMIN_TESTING.md'),
        sourceFile: 'meal_admin/ADMIN_TESTING.md',
    },
    {
        group: 'frontend',
        prefix: 'FRONTEND',
        file: resolve(root, '../meal_frontend/FRONTEND_TESTING.md'),
        sourceFile: 'meal_frontend/FRONTEND_TESTING.md',
    },
];

// Stable domain identifiers are deliberately independent from document order and display codes.
// Adding or renaming an H2 section requires an explicit registry update instead of silently re-keying saved results.
const caseIds = {
    database: [
        'database.run-baseline',
        'database.infrastructure',
        'database.roles',
        'database.migrations',
        'database.structural-integrity',
        'database.reference-data',
        'database.test-personas',
        'database.concurrency',
        'database.domain-invariants',
        'database.performance',
        'database.backup-restore',
        'database.cleanup',
        'database.production-gate',
    ],
    backend: [
        'backend.observability',
        'backend.prerequisites',
        'backend.http-contract',
        'backend.security',
        'backend.auth-sessions',
        'backend.profile-lifecycle',
        'backend.family',
        'backend.catalog',
        'backend.inventory',
        'backend.recipes-cooking',
        'backend.planning-shopping',
        'backend.nutrition',
        'backend.ai',
        'backend.billing',
        'backend.community',
        'backend.moderation',
        'backend.communication-support',
        'backend.notifications-news',
        'backend.admin-operations',
        'backend.workers',
        'backend.reliability',
        'backend.performance',
        'backend.observability-runtime',
        'backend.cross-service',
        'backend.completion',
    ],
    admin: [
        'admin.prerequisites',
        'admin.themes-responsive',
        'admin.auth-mfa',
        'admin.critical-confirmation',
        'admin.overview',
        'admin.recipe-moderation',
        'admin.support',
        'admin.users-access',
        'admin.billing-family',
        'admin.catalog-allergens',
        'admin.achievements-releases',
        'admin.news-notifications',
        'admin.legal-audit-rollback',
        'admin.operations-metrics',
        'admin.performance',
        'admin.cross-service',
        'admin.completion',
    ],
    frontend: [
        'frontend.prerequisites',
        'frontend.shell-controls',
        'frontend.themes',
        'frontend.registration-email',
        'frontend.auth-recovery-mfa',
        'frontend.profile-sessions',
        'frontend.account-lifecycle',
        'frontend.home-search-public',
        'frontend.inventory',
        'frontend.products',
        'frontend.recipes-cooking',
        'frontend.meal-plans',
        'frontend.shopping-receipts',
        'frontend.preserves',
        'frontend.family',
        'frontend.family-chat-notes',
        'frontend.billing',
        'frontend.ai',
        'frontend.pro-data',
        'frontend.community-news',
        'frontend.support-reports',
        'frontend.offline-resilience',
        'frontend.staff-routes',
        'frontend.cross-service',
        'frontend.visual-matrix',
        'frontend.performance',
        'frontend.recipe-revisions',
        'frontend.completion',
    ],
};

const normalize = (value) => value.replace(/\r\n/g, '\n').trim();
const digest = (value) => createHash('sha256').update(normalize(value), 'utf8').digest('hex');
const anchor = (heading) =>
    heading
        .toLocaleLowerCase('ru-RU')
        .replace(/[.():/→+,]/g, '')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-');
const plain = (line) =>
    line
        .replace(/^#{3,6}\s+/, '')
        .replace(/^\s*(?:[-*+] |\d+\.\s+)/, '')
        .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .trim();

function sections(markdown) {
    const matches = [...normalize(markdown).matchAll(/^##\s+(.+)$/gm)];
    return matches.map((match, index) => ({
        heading: match[1].trim(),
        body: normalize(markdown.slice(match.index + match[0].length, matches[index + 1]?.index ?? markdown.length)),
    }));
}

function steps(section) {
    const values = section.body
        .split('\n')
        .map((line) => plain(line))
        .filter(Boolean);
    if (!values.length) throw new Error(`Section has no assertions: ${section.heading}`);
    return values;
}

const expectedResult = (values) => {
    const explicit = values.find((value) =>
        /^(?:Ожидается|Ожидаемый результат|Критерий завершения)[:.\s]/i.test(value),
    );
    return (
        explicit ??
        'Все перечисленные проверки завершены с ожидаемым результатом; отклонения зафиксированы в комментарии.'
    );
};

const cases = [];
for (const source of sources) {
    const markdown = await readFile(source.file, 'utf8');
    const parsed = sections(markdown);
    parsed.forEach((section, index) => {
        const values = steps(section);
        const explicitExpected = values.find((value) =>
            /^(?:Ожидается|Ожидаемый результат|Критерий завершения)[:.\s]/i.test(value),
        );
        const caseId = caseIds[source.group]?.[index];
        if (!caseId) throw new Error(`Missing stable id for ${source.group} section ${index + 1}: ${section.heading}`);
        const sequence = String(index + 1).padStart(2, '0');
        cases.push({
            id: caseId,
            displayCode: `${source.prefix}-${sequence}`,
            group: source.group,
            order: index + 1,
            title: section.heading.replace(/^\d+\.\s*/, ''),
            steps: explicitExpected ? values.filter((value) => value !== explicitExpected) : values,
            expectedResult: explicitExpected ?? expectedResult(values),
            sourceFile: source.sourceFile,
            sourceAnchor: anchor(section.heading),
            sourceChecksum: digest(`${section.heading}\n${section.body}`),
        });
    });
}

const expectedCounts = { database: 13, backend: 25, admin: 17, frontend: 28 };
for (const [group, expected] of Object.entries(expectedCounts)) {
    const actual = cases.filter((item) => item.group === group).length;
    if (actual !== expected) throw new Error(`${group}: expected ${expected} cases, got ${actual}`);
}
if (cases.length !== 83) throw new Error(`Expected 83 cases, got ${cases.length}`);

const catalog = {
    schemaVersion: 1,
    catalogVersion: `2026-10-29.${digest(JSON.stringify(cases)).slice(0, 12)}`,
    publishedOn: '2026-10-29',
    groups: [
        { id: 'database', title: 'База данных', order: 1 },
        { id: 'backend', title: 'Backend/API', order: 2 },
        { id: 'admin', title: 'Админ-панель', order: 3 },
        { id: 'frontend', title: 'Frontend', order: 4 },
    ],
    cases,
};

await writeFile(
    resolve(root, 'resources/acceptance-test-catalog.json'),
    `${JSON.stringify(catalog, null, 4)}\n`,
    'utf8',
);
console.log(
    `Generated ${catalog.catalogVersion}: ${cases.length} cases, ${cases.reduce((sum, item) => sum + item.steps.length, 0)} assertions`,
);
