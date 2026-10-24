import { z } from 'zod';

export const browserTelemetryApplicationSchema = z.enum(['front', 'admin']);
export const browserTelemetryCodeSchema = z.enum([
    'root_error',
    'route_error',
    'unhandled_error',
    'unhandled_rejection',
]);
export const applicationVersionSchema = z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
    .max(64);

export const browserTelemetryInputSchema = z.strictObject({
    application: browserTelemetryApplicationSchema,
    code: browserTelemetryCodeSchema,
    appVersion: applicationVersionSchema.nullable(),
});

export const telemetryAcceptedSchema = z.strictObject({ accepted: z.literal(true) });

export type BrowserTelemetryInput = z.infer<typeof browserTelemetryInputSchema>;
