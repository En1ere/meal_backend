import { z } from 'zod';
import { mediaChecksumSchema, mediaPurposeSchema } from '../media-infrastructure/media-provider.js';

export const mediaReservationRequestSchema = z.strictObject({
    purpose: mediaPurposeSchema,
    fileName: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .regex(/^[^\u0000-\u001f\u007f\\/]+$/),
    mimeType: z.string().trim().min(1).max(200),
    sizeBytes: z
        .number()
        .int()
        .positive()
        .max(50 * 1024 * 1024),
    idempotencyKey: z.uuid(),
});

export const mediaStorageStateSchema = z.enum([
    'reserved',
    'uploading',
    'quarantined',
    'scanning',
    'clean',
    'ready',
    'infected',
    'failed',
    'expired',
    'deleted',
]);

const requiredHeaderSchema = z.strictObject({ name: z.string().min(1).max(100), value: z.string().min(1).max(2_000) });

export const mediaUploadTargetSchema = z.strictObject({
    method: z.literal('PUT'),
    uploadUrl: z.url(),
    expiresAt: z.iso.datetime(),
    fieldName: z.literal('file'),
    requiredHeaders: z.array(requiredHeaderSchema).min(1).max(10),
});

export const mediaReservationSchema = z.strictObject({
    assetId: z.uuid(),
    purpose: mediaPurposeSchema,
    state: mediaStorageStateSchema,
    mimeType: z.string(),
    sizeBytes: z.number().int().positive(),
    checksum: mediaChecksumSchema.nullable(),
    failureCode: z.string().nullable(),
    publicationAllowed: z.literal(false),
    downloadAllowed: z.boolean(),
    upload: mediaUploadTargetSchema.nullable(),
});

export const mediaReservationResultSchema = z.strictObject({ asset: mediaReservationSchema });

export const mediaDownloadTargetSchema = z.strictObject({
    method: z.literal('GET'),
    downloadUrl: z.url(),
    expiresAt: z.iso.datetime(),
    requiredHeaders: z.array(requiredHeaderSchema).min(1).max(10),
});

export const mediaDownloadTargetResultSchema = z.strictObject({
    assetId: z.uuid(),
    target: mediaDownloadTargetSchema,
});

export type MediaReservationRequest = z.infer<typeof mediaReservationRequestSchema>;
export type MediaStorageState = z.infer<typeof mediaStorageStateSchema>;
export type MediaReservation = z.infer<typeof mediaReservationSchema>;
