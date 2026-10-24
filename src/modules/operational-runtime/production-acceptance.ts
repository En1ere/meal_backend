import { isIP } from 'node:net';
import { z } from 'zod';

export const PRODUCTION_ACCEPTANCE_VERSION = 'production-browser-acceptance-v1' as const;
const productionOriginSchema = z.url().superRefine((value, context) => {
    const url = new URL(value);
    if (
        url.protocol !== 'https:' ||
        url.origin !== value ||
        url.username ||
        url.password ||
        isIP(url.hostname) !== 0 ||
        url.hostname === 'localhost'
    )
        context.addIssue({ code: 'custom', message: 'Expected a public HTTPS origin' });
});
export const productionAcceptanceTargetSchema = z.strictObject({
    version: z.literal(PRODUCTION_ACCEPTANCE_VERSION),
    publicOrigin: productionOriginSchema,
    adminOrigin: productionOriginSchema,
    apiOrigin: productionOriginSchema,
    release: z.strictObject({
        root: z.string().regex(/^\d+\.\d+\.\d+$/),
        back: z.string().regex(/^\d+\.\d+\.\d+$/),
        front: z.string().regex(/^\d+\.\d+\.\d+$/),
        admin: z.string().regex(/^\d+\.\d+\.\d+$/),
        openapi: z.string().regex(/^\d+\.\d+\.\d+$/),
    }),
    allowMutations: z.literal(false),
    acknowledgedAt: z.iso.datetime(),
});
export const productionAcceptanceManifest = {
    version: PRODUCTION_ACCEPTANCE_VERSION,
    devices: ['desktop-chromium', 'mobile-chromium'],
    allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
    checks: [
        'health-live',
        'health-ready',
        'public-about',
        'public-community',
        'public-pricing',
        'public-not-found',
        'anonymous-auth',
        'protected-redirect',
        'external-return-to-blocked',
        'admin-anonymous-redirect',
        'no-mutation-requests',
        'no-runtime-errors',
    ],
} as const;
export const productionAcceptanceEvidenceSchema = z
    .strictObject({
        version: z.literal(PRODUCTION_ACCEPTANCE_VERSION),
        target: productionAcceptanceTargetSchema,
        executedAt: z.iso.datetime(),
        mutationRequests: z.literal(0),
        results: z
            .array(
                z.strictObject({
                    device: z.enum(['desktop-chromium', 'mobile-chromium']),
                    check: z.enum(productionAcceptanceManifest.checks),
                    passed: z.boolean(),
                }),
            )
            .length(productionAcceptanceManifest.devices.length * productionAcceptanceManifest.checks.length),
    })
    .superRefine((value, context) => {
        const pairs = new Set(value.results.map((result) => `${result.device}/${result.check}`));
        if (pairs.size !== value.results.length)
            context.addIssue({ code: 'custom', path: ['results'], message: 'Acceptance results must be unique' });
        for (const device of productionAcceptanceManifest.devices)
            for (const check of productionAcceptanceManifest.checks)
                if (
                    !value.results.some((result) => result.device === device && result.check === check && result.passed)
                )
                    context.addIssue({
                        code: 'custom',
                        path: ['results'],
                        message: `Missing passed ${device}/${check}`,
                    });
    });

export function productionAcceptanceReadiness(raw: unknown) {
    return productionAcceptanceEvidenceSchema.safeParse(raw).success
        ? ({ status: 'passed' } as const)
        : ({ status: 'blocked', reason: 'not_executed_or_failed' } as const);
}
