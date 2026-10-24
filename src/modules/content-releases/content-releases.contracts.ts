import { z } from 'zod';

const key = z.string().trim().min(1).max(160);
const title = z.string().trim().min(1).max(160);
const description = z.string().trim().min(1).max(2000);
const icon = z.strictObject({
    assetId: z.uuid().nullable(),
    fallbackKey: z.string().trim().min(1).max(80),
    alt: z.string().trim().min(1).max(200),
});
const conditionScalar = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
const condition = z
    .record(z.string().min(1).max(80), z.union([conditionScalar, z.array(conditionScalar).max(100)]))
    .refine((value) => Object.keys(value).length > 0);

export const achievementPayloadSchema = z.strictObject({
    code: key,
    title,
    description,
    icon,
    category: z.enum([
        'culinary',
        'inventory',
        'planning',
        'author',
        'community',
        'catalog',
        'collections',
        'family',
        'seasonal',
        'secret',
    ]),
    condition,
    reputationDelta: z.number().int().min(0).max(10_000),
    secret: z.boolean(),
});
export const reputationTitlePayloadSchema = z.strictObject({
    level: z.number().int().min(1).max(10),
    threshold: z.number().int().min(0).max(1_000_000_000),
    title,
});
export const legalTextPayloadSchema = z.strictObject({
    kind: key,
    content: z.string().trim().min(1).max(200_000),
    effectiveAt: z.iso.datetime(),
});
export const productDescriptionPayloadSchema = z.strictObject({
    productId: z.uuid(),
    description,
});

const locale = z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/);
const documentCommon = { locale, title, body: z.string().trim().min(1).max(200_000) };
export const contentDocumentPayloadSchema = z.discriminatedUnion('namespace', [
    z.strictObject({
        ...documentCommon,
        namespace: z.literal('help'),
        metadata: z.strictObject({
            schemaVersion: z.literal(1),
            slug: key,
            audience: z.enum(['all', 'user', 'admin']),
        }),
    }),
    z.strictObject({
        ...documentCommon,
        namespace: z.literal('pricing'),
        metadata: z.strictObject({
            schemaVersion: z.literal(1),
            plan: z.enum(['free', 'plus']),
            billingPeriod: z.enum(['none', 'month', 'year']),
        }),
    }),
    z.strictObject({
        ...documentCommon,
        namespace: z.literal('onboarding'),
        metadata: z.strictObject({ schemaVersion: z.literal(1), flow: key, step: z.number().int().positive() }),
    }),
    z.strictObject({
        ...documentCommon,
        namespace: z.literal('notification_template'),
        metadata: z.strictObject({
            schemaVersion: z.literal(1),
            channel: z.enum(['in_app', 'email', 'push']),
            templateKey: key,
            variables: z.array(key).max(50),
        }),
    }),
    z.strictObject({
        ...documentCommon,
        namespace: z.literal('feature_copy'),
        metadata: z.strictObject({ schemaVersion: z.literal(1), featureKey: key, placement: key }),
    }),
]);

export const dictionaryEntryPayloadSchema = z.strictObject({
    schemaVersion: z.literal(1),
    dictionary: z.enum(['category', 'unit', 'allergen']),
    code: z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
        .max(120),
    label: title,
    description: z.string().trim().max(2000).nullable(),
    icon,
    sortOrder: z.number().int().min(0).max(1_000_000),
    enabled: z.boolean(),
});

const patchBase = { patchId: z.uuid(), expectedVersion: z.number().int().min(0) };
export const releasePatchSchema = z.union([
    z.strictObject({
        ...patchBase,
        resourceType: z.literal('achievement'),
        action: z.enum(['create', 'update']),
        resourceKey: key,
        payload: achievementPayloadSchema,
    }),
    z.strictObject({
        ...patchBase,
        resourceType: z.literal('achievement'),
        action: z.literal('retire'),
        resourceKey: key,
        payload: z.null(),
    }),
    z.strictObject({
        ...patchBase,
        resourceType: z.literal('reputation_title'),
        action: z.enum(['create', 'update']),
        resourceKey: key,
        payload: reputationTitlePayloadSchema,
    }),
    z.strictObject({
        ...patchBase,
        resourceType: z.literal('reputation_title'),
        action: z.literal('retire'),
        resourceKey: key,
        payload: z.null(),
    }),
    z.strictObject({
        ...patchBase,
        resourceType: z.literal('legal_text'),
        action: z.enum(['create', 'update']),
        resourceKey: key,
        payload: legalTextPayloadSchema,
    }),
    z.strictObject({
        ...patchBase,
        resourceType: z.literal('legal_text'),
        action: z.literal('retire'),
        resourceKey: key,
        payload: z.null(),
    }),
    z.strictObject({
        ...patchBase,
        resourceType: z.literal('product_description'),
        action: z.enum(['create', 'update']),
        resourceKey: key,
        payload: productDescriptionPayloadSchema,
    }),
    z.strictObject({
        ...patchBase,
        resourceType: z.literal('product_description'),
        action: z.literal('retire'),
        resourceKey: key,
        payload: z.null(),
    }),
    z.strictObject({
        ...patchBase,
        resourceType: z.literal('content_document'),
        action: z.enum(['create', 'update']),
        resourceKey: key,
        payload: contentDocumentPayloadSchema,
    }),
    z.strictObject({
        ...patchBase,
        resourceType: z.literal('content_document'),
        action: z.literal('retire'),
        resourceKey: key,
        payload: z.null(),
    }),
    z.strictObject({
        ...patchBase,
        resourceType: z.literal('dictionary_entry'),
        action: z.enum(['create', 'update']),
        resourceKey: key,
        payload: dictionaryEntryPayloadSchema,
    }),
    z.strictObject({
        ...patchBase,
        resourceType: z.literal('dictionary_entry'),
        action: z.literal('retire'),
        resourceKey: key,
        payload: z.null(),
    }),
]);

export const releaseStatusSchema = z.enum(['draft', 'published']);
export const releaseSummarySchema = z.strictObject({
    id: z.uuid(),
    name: z.string(),
    status: releaseStatusSchema,
    version: z.number().int().positive(),
    patchCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    publishedAt: z.iso.datetime().nullable(),
    sourceReleaseId: z.uuid().nullable(),
    rolledBackFromEventId: z.uuid().nullable(),
});
export const releaseDetailSchema = releaseSummarySchema.extend({
    patches: z.array(releasePatchSchema),
    validation: z.strictObject({ valid: z.boolean(), conflicts: z.array(z.string()), errors: z.array(z.string()) }),
    ack: z
        .strictObject({ clientRevision: z.number().int().positive(), checksum: z.string().regex(/^[a-f0-9]{64}$/) })
        .nullable(),
});
export const releaseListSchema = z.strictObject({ items: z.array(releaseSummarySchema) });
export const createReleaseSchema = z.strictObject({
    name: z.string().trim().min(1).max(160),
    idempotencyKey: z.uuid(),
});
export const saveReleaseSchema = z.strictObject({
    name: z.string().trim().min(1).max(160),
    expectedVersion: z.number().int().positive(),
    patches: z.array(releasePatchSchema).max(500),
    clientRevision: z.number().int().positive(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.uuid(),
});
export const releaseCommandSchema = z.strictObject({
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
});
export const releaseValidateSchema = z.strictObject({ expectedVersion: z.number().int().positive() });
export const releaseEventSchema = z.strictObject({
    id: z.uuid(),
    releaseId: z.uuid(),
    kind: z.enum(['published', 'rolled_back']),
    createdAt: z.iso.datetime(),
    snapshot: z.array(releasePatchSchema),
});
export const releaseHistorySchema = z.strictObject({ items: z.array(releaseEventSchema) });

export const publicAchievementSchema = z.strictObject({
    id: z.uuid(),
    code: z.string(),
    title: z.string(),
    description: z.string(),
    icon,
    category: achievementPayloadSchema.shape.category,
    secret: z.boolean(),
    awardedAt: z.iso.datetime(),
});
export const publicReputationSchema = z.strictObject({
    score: z.number().int(),
    level: z.number().int().min(1).max(10),
    title: z.string(),
    nextThreshold: z.number().int().nullable(),
});
export const publicReputationLevelSchema = reputationTitlePayloadSchema;
export const publicReputationLevelsSchema = z.strictObject({ items: z.array(publicReputationLevelSchema).length(10) });
const publicProfileIdentitySchema = z.strictObject({ username: z.string(), avatarUrl: z.string().nullable() });
const publicRankSchema = z.strictObject({
    id: z.string(),
    title: z.string(),
    minimumScore: z.number().int().nonnegative(),
    nextMinimumScore: z.number().int().nonnegative().nullable(),
});
export const authorAchievementsSchema = z.strictObject({
    profile: publicProfileIdentitySchema,
    reputation: z.strictObject({ score: z.number().int(), rank: publicRankSchema }),
    categories: z.array(z.strictObject({ id: z.string(), title: z.string() })),
    achievements: z.array(
        z.strictObject({
            id: z.string(),
            title: z.string(),
            description: z.string(),
            category: z.string(),
            icon,
            secret: z.boolean(),
            status: z.enum(['earned', 'locked']),
            earnedAt: z.iso.datetime().nullable(),
        }),
    ),
});
export const authorReputationSchema = z.strictObject({
    profile: publicProfileIdentitySchema,
    score: z.number().int(),
    rank: publicRankSchema,
    ranks: z
        .array(z.strictObject({ id: z.string(), title: z.string(), minimumScore: z.number().int().nonnegative() }))
        .length(10),
    factors: z.array(z.strictObject({ id: z.string(), title: z.string(), icon })),
});
export const releaseSourcesSchema = z.strictObject({
    achievements: z.array(
        z.strictObject({
            key,
            version: z.number().int().positive(),
            retired: z.boolean(),
            value: achievementPayloadSchema,
        }),
    ),
    reputationTitles: z.array(
        z.strictObject({
            key,
            version: z.number().int().positive(),
            retired: z.boolean(),
            value: reputationTitlePayloadSchema,
        }),
    ),
    legalTexts: z.array(
        z.strictObject({
            key,
            version: z.number().int().positive(),
            retired: z.boolean(),
            value: legalTextPayloadSchema,
        }),
    ),
    products: z.array(
        z.strictObject({
            id: z.uuid(),
            name: z.string(),
            version: z.number().int().nonnegative(),
            description: z.string().nullable(),
        }),
    ),
    contentDocuments: z.array(
        z.strictObject({
            key,
            version: z.number().int().positive(),
            retired: z.boolean(),
            value: contentDocumentPayloadSchema,
        }),
    ),
    dictionaryEntries: z.array(
        z.strictObject({
            key,
            version: z.number().int().positive(),
            retired: z.boolean(),
            value: dictionaryEntryPayloadSchema,
        }),
    ),
});

export type ReleasePatch = z.infer<typeof releasePatchSchema>;
export type ReleaseDetail = z.infer<typeof releaseDetailSchema>;
