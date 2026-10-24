import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { mediaChecksumSchema, mediaObjectKeySchema } from '../media-infrastructure/media-provider.js';

export const OCR_PROVIDER = Symbol('OCR_PROVIDER');

export const ocrProcessingModeSchema = z.enum(['local', 'external']);
export type OcrProcessingMode = z.infer<typeof ocrProcessingModeSchema>;

export const ocrProviderStatusSchema = z.strictObject({
    configured: z.boolean(),
    provider: z
        .string()
        .regex(/^[a-z][a-z0-9_-]{1,63}$/)
        .nullable(),
    processingMode: ocrProcessingModeSchema.nullable(),
    dataRegion: z.string().trim().min(1).max(100).nullable(),
});
export type OcrProviderStatus = z.infer<typeof ocrProviderStatusSchema>;

const policyCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const ocrMimeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);

export const ocrRequestSchema = z
    .strictObject({
        jobId: z.uuid(),
        idempotencyKey: z.string().trim().min(1).max(200),
        purpose: z.enum(['inventory_scan', 'receipt_photo', 'receipt_pdf', 'product_label']),
        source: z.strictObject({
            sourceId: z.uuid(),
            assetId: z.uuid(),
            objectKey: mediaObjectKeySchema,
            checksum: mediaChecksumSchema,
            mime: ocrMimeSchema,
            sizeBytes: z
                .number()
                .int()
                .positive()
                .max(50 * 1024 * 1024),
            mediaState: z.literal('ready'),
            malwareVerdict: z.literal('clean'),
            encrypted: z.literal(true),
        }),
        languages: z
            .array(z.enum(['ru', 'en']))
            .min(1)
            .max(2),
        maxPages: z.number().int().min(1).max(20),
        providerPolicyVersion: policyCodeSchema,
        retentionPolicyVersion: policyCodeSchema,
        externalTransferConsent: z
            .strictObject({
                version: policyCodeSchema,
                consentedAt: z.iso.datetime(),
            })
            .nullable(),
    })
    .superRefine((value, context) => {
        if (new Set(value.languages).size !== value.languages.length)
            context.addIssue({ code: 'custom', path: ['languages'], message: 'Languages must be unique' });
        if (value.source.mime !== 'application/pdf' && value.maxPages !== 1)
            context.addIssue({ code: 'custom', path: ['maxPages'], message: 'Images contain exactly one page' });
    });
export type OcrRequest = z.infer<typeof ocrRequestSchema>;

export const ocrStateSchema = z.enum(['queued', 'processing', 'unknown', 'succeeded', 'failed', 'cancelled']);
export type OcrState = z.infer<typeof ocrStateSchema>;

const ocrFieldSchema = z
    .strictObject({
        path: z.string().regex(/^[a-z][a-z0-9_.\[\]-]{0,199}$/),
        rawValue: z.string().max(2_000),
        confidence: z.number().min(0).max(1).nullable(),
        page: z.number().int().min(1).max(20),
        region: z
            .strictObject({
                x: z.number().min(0).max(1),
                y: z.number().min(0).max(1),
                width: z.number().positive().max(1),
                height: z.number().positive().max(1),
            })
            .nullable(),
    })
    .superRefine((value, context) => {
        if (value.region && (value.region.x + value.region.width > 1 || value.region.y + value.region.height > 1))
            context.addIssue({ code: 'custom', path: ['region'], message: 'OCR region exceeds page bounds' });
    });

export const ocrSnapshotSchema = z
    .strictObject({
        provider: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
        processingMode: ocrProcessingModeSchema,
        jobId: z.uuid(),
        sourceId: z.uuid(),
        assetId: z.uuid(),
        checksum: mediaChecksumSchema,
        state: ocrStateSchema,
        occurredAt: z.iso.datetime(),
        rawText: z.string().max(100_000),
        fields: z.array(ocrFieldSchema).max(500),
        requiresReview: z.literal(true),
        failureCode: policyCodeSchema.nullable(),
    })
    .superRefine((value, context) => {
        const total = value.rawText.length + value.fields.reduce((sum, field) => sum + field.rawValue.length, 0);
        if (total > 150_000) context.addIssue({ code: 'custom', message: 'OCR result is too large' });
        if (new Set(value.fields.map((field) => `${field.page}:${field.path}`)).size !== value.fields.length)
            context.addIssue({ code: 'custom', path: ['fields'], message: 'OCR field paths must be unique per page' });
        if (value.state === 'succeeded' && value.failureCode !== null)
            context.addIssue({ code: 'custom', path: ['failureCode'], message: 'Successful OCR has no failure code' });
        if (value.state !== 'succeeded' && (value.fields.length || value.rawText.length))
            context.addIssue({ code: 'custom', path: ['fields'], message: 'Incomplete OCR cannot expose content' });
    });
export type OcrSnapshot = z.infer<typeof ocrSnapshotSchema>;

export const ocrJobRequestSchema = z.strictObject({ jobId: z.uuid(), sourceId: z.uuid() });
export type OcrJobRequest = z.infer<typeof ocrJobRequestSchema>;

export interface OcrProvider {
    status(): OcrProviderStatus;
    start(request: OcrRequest): Promise<OcrSnapshot>;
    lookup(request: OcrJobRequest): Promise<OcrSnapshot>;
    cancel(request: OcrJobRequest): Promise<OcrSnapshot>;
}

export class OcrBoundaryError extends Error {
    constructor(
        public readonly code:
            | 'invalid_request'
            | 'provider_unavailable'
            | 'external_consent_required'
            | 'binding_mismatch'
            | 'invalid_transition',
    ) {
        super(code);
    }
}

const transitions: Readonly<Record<OcrState, ReadonlySet<OcrState>>> = {
    queued: new Set(['queued', 'processing', 'unknown', 'failed', 'cancelled']),
    processing: new Set(['processing', 'unknown', 'succeeded', 'failed', 'cancelled']),
    unknown: new Set(['unknown', 'processing', 'succeeded', 'failed', 'cancelled']),
    succeeded: new Set(['succeeded']),
    failed: new Set(['failed']),
    cancelled: new Set(['cancelled']),
};

export function validateOcrRequestForProvider(raw: OcrRequest, statusRaw: OcrProviderStatus): OcrRequest {
    const requestResult = ocrRequestSchema.safeParse(raw);
    const statusResult = ocrProviderStatusSchema.safeParse(statusRaw);
    if (!requestResult.success || !statusResult.success) throw new OcrBoundaryError('invalid_request');
    if (!statusResult.data.configured || !statusResult.data.processingMode || !statusResult.data.provider)
        throw new OcrBoundaryError('provider_unavailable');
    if (
        statusResult.data.processingMode === 'external' &&
        requestResult.data.externalTransferConsent?.version !== requestResult.data.providerPolicyVersion
    )
        throw new OcrBoundaryError('external_consent_required');
    return requestResult.data;
}

export function validateOcrSnapshot(request: OcrRequest, status: OcrProviderStatus, raw: unknown): OcrSnapshot {
    const parsedRequest = validateOcrRequestForProvider(request, status);
    const parsedStatus = ocrProviderStatusSchema.parse(status);
    const result = ocrSnapshotSchema.safeParse(raw);
    if (!result.success) throw new OcrBoundaryError('invalid_request');
    if (
        parsedStatus.provider !== result.data.provider ||
        parsedStatus.processingMode !== result.data.processingMode ||
        parsedRequest.jobId !== result.data.jobId ||
        parsedRequest.source.sourceId !== result.data.sourceId ||
        parsedRequest.source.assetId !== result.data.assetId ||
        parsedRequest.source.checksum !== result.data.checksum
    )
        throw new OcrBoundaryError('binding_mismatch');
    return result.data;
}

export function ocrTransition(current: OcrState, next: OcrState): OcrState {
    if (!transitions[current].has(next)) throw new OcrBoundaryError('invalid_transition');
    return next;
}

@Injectable()
export class DisabledOcrProvider implements OcrProvider {
    status(): OcrProviderStatus {
        return { configured: false, provider: null, processingMode: null, dataRegion: null };
    }

    private unavailable(): Promise<OcrSnapshot> {
        return Promise.reject(new ServiceUnavailableException('OCR provider is not configured'));
    }

    start(request: OcrRequest): Promise<OcrSnapshot> {
        void request;
        return this.unavailable();
    }

    lookup(request: OcrJobRequest): Promise<OcrSnapshot> {
        void request;
        return this.unavailable();
    }

    cancel(request: OcrJobRequest): Promise<OcrSnapshot> {
        void request;
        return this.unavailable();
    }
}
