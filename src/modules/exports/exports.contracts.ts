import { z } from 'zod';

export const exportScopeSchema = z.enum(['private', 'family']);
export const exportDomainSchema = z.enum(['personal_data', 'diary', 'finance', 'nutrition', 'all_pro_data']);
export const exportFormatSchema = z.enum(['csv', 'pdf', 'json']);
export const exportSelectionSchema = z.strictObject({
    scope: exportScopeSchema,
    domain: exportDomainSchema,
    format: exportFormatSchema,
    startsOn: z.iso.date().nullable(),
    endsOn: z.iso.date().nullable(),
});
export const exportPreviewRequestSchema = exportSelectionSchema.superRefine((value, context) => {
    if (value.startsOn && value.endsOn && value.startsOn > value.endsOn)
        context.addIssue({ code: 'custom', path: ['endsOn'], message: 'Конец периода не может быть раньше начала' });
    if (value.domain === 'personal_data' && value.format !== 'json')
        context.addIssue({
            code: 'custom',
            path: ['format'],
            message: 'Общий экспорт доступен только в JSON',
        });
    if (value.domain !== 'personal_data' && value.scope !== 'private')
        context.addIssue({
            code: 'custom',
            path: ['scope'],
            message: 'Pro-экспорт содержит только личные данные',
        });
});
export const exportSectionCodeSchema = z.enum([
    'identity',
    'profile',
    'preferences',
    'consents',
    'inventory',
    'recipes',
    'cooking',
    'preserves',
    'meal_plans',
    'shopping',
    'notifications',
    'community',
    'support',
    'ai_history',
    'subscription_metadata',
    'family_profile',
    'family_memberships',
    'family_inventory',
    'family_recipes',
    'family_preserves',
    'family_meal_plans',
    'family_shopping',
    'family_notes',
    'family_chat',
    'diary_entries',
    'diary_portions',
    'finance_expenses',
    'finance_budgets',
    'finance_prices',
    'finance_receipts',
    'nutrition_profile',
    'nutrition_targets',
]);
export const exportSectionSchema = z.strictObject({
    code: exportSectionCodeSchema,
    label: z.string().min(1).max(100),
    detail: z.string().min(1).max(300),
    ownership: z.enum(['requester', 'shared_family']),
});
export const exportExclusionSchema = z.strictObject({
    code: z.enum(['other_members_private_data', 'credentials', 'internal_audit', 'payment_documents', 'binary_assets']),
    message: z.string().min(1).max(300),
});
export const exportBlockerSchema = z.strictObject({
    code: z.enum(['family_membership_required', 'active_pro_required', 'service_unavailable']),
    message: z.string().min(1).max(300),
});
export const exportProAccessSnapshotSchema = z.strictObject({
    modeAtPreview: z.literal('active'),
    source: z.enum(['personal', 'family', 'trial', 'gift']),
    periodEndsAt: z.iso.datetime().nullable(),
    dataThrough: z.iso.date(),
    checkedAt: z.iso.datetime(),
});
export const exportManifestSchema = z.strictObject({
    schemaVersion: z.enum(['2026-10-06', '2026-10-09']),
    selection: exportSelectionSchema,
    scopeId: z.uuid().nullable(),
    familyId: z.uuid().nullable(),
    requesterId: z.uuid(),
    sections: z.array(exportSectionSchema).min(1),
    exclusions: z.array(exportExclusionSchema),
    aclSnapshotAt: z.iso.datetime(),
    proAccess: exportProAccessSnapshotSchema.nullable().default(null),
});
export const exportPreviewSchema = z.strictObject({
    previewId: z.uuid(),
    manifest: exportManifestSchema.nullable(),
    canCreate: z.boolean(),
    blockers: z.array(exportBlockerSchema),
    expiresAt: z.iso.datetime(),
});
export const createExportSchema = z.strictObject({
    previewId: z.uuid(),
    idempotencyKey: z.uuid(),
    reauthToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const exportStatusSchema = z.enum(['queued', 'processing', 'ready', 'failed', 'expired']);
export const exportJobSchema = z.strictObject({
    id: z.uuid(),
    manifest: exportManifestSchema,
    requestedAt: z.iso.datetime(),
    status: exportStatusSchema,
    completedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    failureCode: z.enum(['generation_failed', 'storage_unavailable', 'access_revoked']).nullable(),
});
export const exportCreateResultSchema = z.strictObject({ job: exportJobSchema });
export const exportListQuerySchema = z.strictObject({
    cursor: z.string().trim().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const exportListSchema = z.strictObject({ items: z.array(exportJobSchema), nextCursor: z.string().nullable() });
export const exportDownloadSchema = z.strictObject({
    fileName: z.string().min(1).max(200),
    mediaType: z.enum(['text/csv', 'application/pdf', 'application/json']),
    content: z.string(),
});
export const exportWorkerRunSchema = z.strictObject({
    claimed: z.number().int().nonnegative(),
    failedClosed: z.number().int().nonnegative(),
});

export type ExportSelection = z.infer<typeof exportSelectionSchema>;
export type ExportDomain = z.infer<typeof exportDomainSchema>;
export type ExportSectionCode = z.infer<typeof exportSectionCodeSchema>;
export type ExportManifest = z.infer<typeof exportManifestSchema>;
export type ExportListQuery = z.infer<typeof exportListQuerySchema>;
export type CreateExport = z.infer<typeof createExportSchema>;
