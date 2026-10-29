import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { acceptanceCaseIdSchema, acceptanceGroupIdSchema } from './admin-acceptance-tests.contracts.js';

const catalogCaseSchema = z.strictObject({
    id: acceptanceCaseIdSchema,
    displayCode: z.string().regex(/^(?:DB|API|ADMIN|FRONTEND)-\d{2}$/),
    group: acceptanceGroupIdSchema,
    order: z.number().int().positive(),
    title: z.string().min(1).max(240),
    steps: z.array(z.string().min(1).max(2000)).min(1).max(100),
    expectedResult: z.string().min(1).max(2000),
    sourceFile: z.string().min(1).max(240),
    sourceAnchor: z.string().min(1).max(240),
    sourceChecksum: z.string().regex(/^[0-9a-f]{64}$/),
});
const catalogSchema = z.strictObject({
    schemaVersion: z.literal(1),
    catalogVersion: z.string().min(1).max(80),
    publishedOn: z.iso.date(),
    groups: z
        .array(
            z.strictObject({
                id: acceptanceGroupIdSchema,
                title: z.string().min(1).max(80),
                order: z.number().int().positive(),
            }),
        )
        .length(4),
    cases: z.array(catalogCaseSchema).length(83),
});
export type AcceptanceCatalog = z.infer<typeof catalogSchema>;
export type AcceptanceCatalogCase = AcceptanceCatalog['cases'][number];

const unique = (values: readonly string[], label: string) => {
    if (new Set(values).size !== values.length) throw new Error(`Duplicate acceptance catalog ${label}`);
};

export function validateAcceptanceCatalog(value: unknown): AcceptanceCatalog {
    const catalog = catalogSchema.parse(value);
    const expectedVersion = `${catalog.publishedOn}.${createHash('sha256').update(JSON.stringify(catalog.cases)).digest('hex').slice(0, 12)}`;
    if (catalog.catalogVersion !== expectedVersion) throw new Error('Acceptance catalog version/checksum mismatch');
    unique(
        catalog.groups.map((item) => item.id),
        'group id',
    );
    unique(
        catalog.groups.map((item) => String(item.order)),
        'group order',
    );
    unique(
        catalog.cases.map((item) => item.id),
        'case id',
    );
    unique(
        catalog.cases.map((item) => item.displayCode),
        'display code',
    );
    for (const group of catalog.groups) {
        const cases = catalog.cases.filter((item) => item.group === group.id);
        unique(
            cases.map((item) => String(item.order)),
            `${group.id} order`,
        );
        const expected = group.id === 'database' ? 13 : group.id === 'backend' ? 25 : group.id === 'admin' ? 17 : 28;
        if (cases.length !== expected) throw new Error(`Invalid acceptance catalog ${group.id} count`);
    }
    for (const item of catalog.cases) {
        if (!/^[0-9a-f]{64}$/.test(item.sourceChecksum)) throw new Error(`Invalid checksum for ${item.id}`);
    }
    return Object.freeze(catalog);
}

export function loadAcceptanceCatalog(path = resolve(process.cwd(), 'resources/acceptance-test-catalog.json')) {
    return validateAcceptanceCatalog(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

export const acceptanceCatalog = loadAcceptanceCatalog();
export const acceptanceCatalogById = new Map(acceptanceCatalog.cases.map((item) => [item.id, item] as const));
export const emptyCommentHash = createHash('sha256').update('').digest('hex');
