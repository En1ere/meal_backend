import { z } from 'zod';

export const importPreviewSchema = z.strictObject({
    filename: z.string(),
    sheets: z.array(z.strictObject({ name: z.string(), rows: z.array(z.array(z.string())) })),
    warnings: z.array(z.string()),
});
export const scanPreviewSchema = z.strictObject({
    images: z.array(z.strictObject({ filename: z.string(), text: z.string(), confidence: z.number() })),
    warnings: z.array(z.string()),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export type ScanPreview = z.infer<typeof scanPreviewSchema>;
export const ingestLimitsSchema = z.strictObject({
    fileBytes: z.number().int().positive().max(10485760).default(10485760),
    photos: z.number().int().positive().max(3).default(3),
    pixels: z.number().int().positive().max(20000000).default(20000000),
    rows: z.number().int().positive().max(5000).default(5000),
    sheets: z.number().int().positive().max(10).default(10),
    columns: z.number().int().positive().max(100).default(100),
    expandedBytes: z.number().int().positive().max(104857600).default(52428800),
    timeoutMs: z.number().int().positive().max(120000).default(60000),
});
export type IngestLimits = z.infer<typeof ingestLimitsSchema>;
