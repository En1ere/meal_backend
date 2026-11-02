import { HttpException } from '@nestjs/common';
import type { MediaPurpose } from '../media-infrastructure/media-provider.js';

export type MediaPurposePolicy = Readonly<{
    purpose: MediaPurpose;
    maximumBytes: number;
    acceptedMimeTypes: readonly string[];
    retentionClass: string;
    publishable: boolean;
    userReservable: boolean;
}>;

const mib = 1024 * 1024;

export const mediaPurposePolicies: Readonly<Record<MediaPurpose, MediaPurposePolicy>> = {
    diary_photo: {
        purpose: 'diary_photo',
        maximumBytes: 10 * mib,
        acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        retentionClass: 'private-diary-v1',
        publishable: false,
        userReservable: true,
    },
    support_attachment: {
        purpose: 'support_attachment',
        maximumBytes: 10 * mib,
        acceptedMimeTypes: [
            'image/jpeg',
            'image/png',
            'image/webp',
            'application/pdf',
            'video/mp4',
            'video/webm',
            'video/quicktime',
        ],
        retentionClass: 'private-support-v1',
        publishable: false,
        userReservable: true,
    },
    allergen_icon: {
        purpose: 'allergen_icon',
        maximumBytes: 1 * mib,
        acceptedMimeTypes: ['image/png', 'image/webp'],
        retentionClass: 'public-catalog-v1',
        publishable: true,
        userReservable: false,
    },
    receipt_source: {
        purpose: 'receipt_source',
        maximumBytes: 20 * mib,
        acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
        retentionClass: 'private-receipt-v1',
        publishable: false,
        userReservable: true,
    },
    export_file: {
        purpose: 'export_file',
        maximumBytes: 50 * mib,
        acceptedMimeTypes: ['application/json', 'text/csv', 'application/pdf'],
        retentionClass: 'private-export-v1',
        publishable: false,
        userReservable: false,
    },
    billing_document: {
        purpose: 'billing_document',
        maximumBytes: 10 * mib,
        acceptedMimeTypes: ['application/pdf'],
        retentionClass: 'private-billing-v1',
        publishable: false,
        userReservable: false,
    },
    community_media: {
        purpose: 'community_media',
        maximumBytes: 50 * mib,
        acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'],
        retentionClass: 'public-community-v1',
        publishable: true,
        userReservable: true,
    },
    profile_avatar: {
        purpose: 'profile_avatar',
        maximumBytes: 5 * mib,
        acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        retentionClass: 'public-profile-v1',
        publishable: true,
        userReservable: true,
    },
};

export function mediaPurposePolicy(purpose: MediaPurpose, mimeType: string, sizeBytes: number): MediaPurposePolicy {
    const policy = mediaPurposePolicies[purpose];
    if (!policy.acceptedMimeTypes.includes(mimeType))
        throw new HttpException(
            { code: 'MEDIA_MIME_NOT_ALLOWED', message: 'Формат файла недоступен для этого назначения' },
            415,
        );
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > policy.maximumBytes)
        throw new HttpException({ code: 'MEDIA_SIZE_NOT_ALLOWED', message: 'Размер файла превышает допустимый' }, 413);
    return policy;
}
