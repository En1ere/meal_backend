import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

export const OBJECT_STORAGE_PROVIDER = Symbol('OBJECT_STORAGE_PROVIDER');
export const KEY_MANAGEMENT_PROVIDER = Symbol('KEY_MANAGEMENT_PROVIDER');
export const MALWARE_SCANNER_PROVIDER = Symbol('MALWARE_SCANNER_PROVIDER');

export const MAX_MEDIA_SOURCE_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_URL_TTL_MS = 15 * 60 * 1000;
export const MAX_DOWNLOAD_URL_TTL_MS = 5 * 60 * 1000;

const providerCodeSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/);
const policyCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
export const mediaChecksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const httpsUrlSchema = z.url().refine((value) => new URL(value).protocol === 'https:', 'Expected HTTPS URL');
export const mediaObjectKeySchema = z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine(
        (value) =>
            !value.startsWith('/') &&
            !value.includes('://') &&
            !value.includes('\\') &&
            !value.split('/').includes('..'),
        'Expected an opaque relative object key',
    );

export const mediaPurposeSchema = z.enum([
    'diary_photo',
    'support_attachment',
    'allergen_icon',
    'receipt_source',
    'export_file',
    'billing_document',
    'community_media',
    'profile_avatar',
]);
export type MediaPurpose = z.infer<typeof mediaPurposeSchema>;

export const mediaObjectBindingSchema = z.strictObject({
    assetId: z.uuid(),
    objectKey: mediaObjectKeySchema,
    purpose: mediaPurposeSchema,
    mime: z.string().trim().min(1).max(200),
    sizeBytes: z.number().int().positive().max(MAX_MEDIA_SOURCE_BYTES),
    checksum: mediaChecksumSchema,
    retentionClass: policyCodeSchema,
});
export type MediaObjectBinding = z.infer<typeof mediaObjectBindingSchema>;

export const keyBindingSchema = z.strictObject({
    provider: providerCodeSchema,
    keyReference: z.string().trim().min(1).max(500),
    mode: z.literal('provider_managed_kms'),
});
export type KeyBinding = z.infer<typeof keyBindingSchema>;

export const uploadReservationRequestSchema = mediaObjectBindingSchema.extend({
    idempotencyKey: z.string().trim().min(1).max(200),
    encryption: keyBindingSchema,
});
export type UploadReservationRequest = z.infer<typeof uploadReservationRequestSchema>;

export const uploadTargetSchema = z.strictObject({
    provider: providerCodeSchema,
    assetId: z.uuid(),
    objectKey: mediaObjectKeySchema,
    uploadUrl: httpsUrlSchema,
    expiresAt: z.iso.datetime(),
    requiredHeaders: z
        .array(
            z.strictObject({
                name: z.string().trim().min(1).max(100),
                value: z.string().min(1).max(2_000),
            }),
        )
        .max(20),
});
export type UploadTarget = z.infer<typeof uploadTargetSchema>;

export const downloadRequestSchema = z.strictObject({
    assetId: z.uuid(),
    objectKey: mediaObjectKeySchema,
    disposition: z.enum(['inline', 'attachment']),
    filename: z.string().trim().min(1).max(255).optional(),
});
export type DownloadRequest = z.infer<typeof downloadRequestSchema>;

export const deleteObjectRequestSchema = z.strictObject({
    assetId: z.uuid(),
    objectKey: mediaObjectKeySchema,
});
export type DeleteObjectRequest = z.infer<typeof deleteObjectRequestSchema>;

export const downloadTargetSchema = z.strictObject({
    provider: providerCodeSchema,
    assetId: z.uuid(),
    objectKey: mediaObjectKeySchema,
    downloadUrl: httpsUrlSchema,
    expiresAt: z.iso.datetime(),
});
export type DownloadTarget = z.infer<typeof downloadTargetSchema>;

export const keyRequestSchema = z.strictObject({
    assetId: z.uuid(),
    purpose: mediaPurposeSchema,
    encryptionContext: z.strictObject({
        objectKey: mediaObjectKeySchema,
        uploaderId: z.uuid(),
    }),
});
export type KeyRequest = z.infer<typeof keyRequestSchema>;

export const malwareScanRequestSchema = mediaObjectBindingSchema.extend({
    policyVersion: policyCodeSchema,
});
export type MalwareScanRequest = z.infer<typeof malwareScanRequestSchema>;

export const malwareScanResultSchema = z.strictObject({
    provider: providerCodeSchema,
    assetId: z.uuid(),
    objectKey: mediaObjectKeySchema,
    checksum: mediaChecksumSchema,
    policyVersion: policyCodeSchema,
    verdict: z.enum(['clean', 'infected', 'unknown', 'error']),
    scannedAt: z.iso.datetime(),
    engineVersion: z.string().trim().min(1).max(200).nullable(),
    reasonCode: policyCodeSchema.nullable(),
});
export type MalwareScanResult = z.infer<typeof malwareScanResultSchema>;

export const mediaStateSchema = z.enum([
    'reserved',
    'uploading',
    'quarantined',
    'scanning',
    'clean',
    'ready',
    'infected',
    'failed',
    'deleted',
]);
export type MediaState = z.infer<typeof mediaStateSchema>;

export interface ObjectStorageProvider {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    reserveUpload(request: UploadReservationRequest): Promise<UploadTarget>;
    createDownload(request: DownloadRequest): Promise<DownloadTarget>;
    deleteObject(request: DeleteObjectRequest): Promise<void>;
}

export interface KeyManagementProvider {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    resolveKey(request: KeyRequest): Promise<KeyBinding>;
}

export interface MalwareScannerProvider {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    scan(request: MalwareScanRequest): Promise<MalwareScanResult>;
}

export class MediaBoundaryError extends Error {
    constructor(
        public readonly code:
            'invalid_request' | 'binding_mismatch' | 'invalid_transition' | 'unsafe_url_ttl' | 'media_not_ready',
    ) {
        super(code);
    }
}

const transitions: Readonly<Record<MediaState, ReadonlySet<MediaState>>> = {
    reserved: new Set(['reserved', 'uploading', 'failed']),
    uploading: new Set(['uploading', 'quarantined', 'failed']),
    quarantined: new Set(['quarantined', 'scanning', 'failed']),
    scanning: new Set(['scanning', 'clean', 'infected', 'failed']),
    clean: new Set(['clean', 'ready', 'failed']),
    ready: new Set(['ready', 'deleted']),
    infected: new Set(['infected', 'deleted']),
    failed: new Set(['failed', 'deleted']),
    deleted: new Set(['deleted']),
};

function parseProviderResult<T>(schema: z.ZodType<T>, raw: unknown): T {
    const result = schema.safeParse(raw);
    if (!result.success) throw new MediaBoundaryError('invalid_request');
    return result.data;
}

function assertBound(
    expected: Readonly<{ assetId: string; objectKey: string }>,
    actual: Readonly<{ assetId: string; objectKey: string }>,
): void {
    if (expected.assetId !== actual.assetId || expected.objectKey !== actual.objectKey) {
        throw new MediaBoundaryError('binding_mismatch');
    }
}

function assertSafeExpiry(expiresAt: string, now: Date, maximumTtlMs: number): void {
    const ttl = Date.parse(expiresAt) - now.getTime();
    if (ttl <= 0 || ttl > maximumTtlMs) throw new MediaBoundaryError('unsafe_url_ttl');
}

export function mediaTransition(current: MediaState, next: MediaState): MediaState {
    if (!transitions[current].has(next)) throw new MediaBoundaryError('invalid_transition');
    return next;
}

export function validateUploadTarget(
    request: UploadReservationRequest,
    raw: unknown,
    now: Date = new Date(),
): UploadTarget {
    const parsedRequest = uploadReservationRequestSchema.parse(request);
    const result = parseProviderResult(uploadTargetSchema, raw);
    assertBound(parsedRequest, result);
    assertSafeExpiry(result.expiresAt, now, MAX_UPLOAD_URL_TTL_MS);
    return result;
}

export function validateDownloadTarget(request: DownloadRequest, raw: unknown, now: Date = new Date()): DownloadTarget {
    const parsedRequest = downloadRequestSchema.parse(request);
    const result = parseProviderResult(downloadTargetSchema, raw);
    assertBound(parsedRequest, result);
    assertSafeExpiry(result.expiresAt, now, MAX_DOWNLOAD_URL_TTL_MS);
    return result;
}

export function validateMalwareScan(request: MalwareScanRequest, raw: unknown): MalwareScanResult {
    const parsedRequest = malwareScanRequestSchema.parse(request);
    const result = parseProviderResult(malwareScanResultSchema, raw);
    assertBound(parsedRequest, result);
    if (parsedRequest.checksum !== result.checksum || parsedRequest.policyVersion !== result.policyVersion) {
        throw new MediaBoundaryError('binding_mismatch');
    }
    return result;
}

export function assertMediaReady(
    binding: MediaObjectBinding,
    encryption: KeyBinding | null,
    scan: MalwareScanResult,
): void {
    const parsedBinding = mediaObjectBindingSchema.parse(binding);
    const parsedScan = parseProviderResult(malwareScanResultSchema, scan);
    if (!encryption) throw new MediaBoundaryError('media_not_ready');
    keyBindingSchema.parse(encryption);
    assertBound(parsedBinding, parsedScan);
    if (parsedBinding.checksum !== parsedScan.checksum || parsedScan.verdict !== 'clean') {
        throw new MediaBoundaryError('media_not_ready');
    }
}

abstract class DisabledProvider {
    status() {
        return { configured: false, provider: null } as const;
    }

    protected unavailable<T>(message: string): Promise<T> {
        return Promise.reject(new ServiceUnavailableException(message));
    }
}

@Injectable()
export class DisabledObjectStorageProvider extends DisabledProvider implements ObjectStorageProvider {
    reserveUpload(request: UploadReservationRequest): Promise<UploadTarget> {
        void request;
        return this.unavailable('Object storage is not configured');
    }

    createDownload(request: DownloadRequest): Promise<DownloadTarget> {
        void request;
        return this.unavailable('Object storage is not configured');
    }

    deleteObject(request: DeleteObjectRequest): Promise<void> {
        void request;
        return this.unavailable('Object storage is not configured');
    }
}

@Injectable()
export class DisabledKeyManagementProvider extends DisabledProvider implements KeyManagementProvider {
    resolveKey(request: KeyRequest): Promise<KeyBinding> {
        void request;
        return this.unavailable('Key management is not configured');
    }
}

@Injectable()
export class DisabledMalwareScannerProvider extends DisabledProvider implements MalwareScannerProvider {
    scan(request: MalwareScanRequest): Promise<MalwareScanResult> {
        void request;
        return this.unavailable('Malware scanner is not configured');
    }
}
