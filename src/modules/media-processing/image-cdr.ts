import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const imageCdrPolicy = {
    version: 'image-cdr-v1',
    maximumInputBytes: 10 * 1024 * 1024,
    maximumInputPixels: 12_000_000,
    maximumOutputEdge: 1_600,
    acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'] as const,
} as const;

export type ImageCdrResult = Readonly<{
    bytes: Buffer;
    mimeType: 'image/jpeg' | 'image/png';
    width: number;
    height: number;
    checksum: `sha256:${string}`;
    policyVersion: typeof imageCdrPolicy.version;
    safetyEvidence: 'cdr_reencoded';
}>;

function rejected(message: string): never {
    throw new Error(`IMAGE_CDR_REJECTED:${message}`);
}

export async function sanitizeImage(input: Buffer, declaredMime: string): Promise<ImageCdrResult> {
    if (!(imageCdrPolicy.acceptedMimeTypes as readonly string[]).includes(declaredMime)) rejected('mime_not_allowed');
    if (input.length === 0 || input.length > imageCdrPolicy.maximumInputBytes) rejected('size_not_allowed');

    const decoder = sharp(input, {
        animated: true,
        failOn: 'warning',
        limitInputPixels: imageCdrPolicy.maximumInputPixels,
        sequentialRead: true,
    });
    const metadata = await decoder.metadata();
    const actualMime =
        metadata.format === 'jpeg'
            ? 'image/jpeg'
            : metadata.format === 'png'
              ? 'image/png'
              : metadata.format === 'webp'
                ? 'image/webp'
                : null;
    if (!actualMime || actualMime !== declaredMime) rejected('mime_mismatch');
    if ((metadata.pages ?? 1) !== 1) rejected('animated_image');
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > imageCdrPolicy.maximumInputPixels)
        rejected('pixel_limit');

    const pipeline = decoder.rotate().toColourspace('srgb').resize({
        width: imageCdrPolicy.maximumOutputEdge,
        height: imageCdrPolicy.maximumOutputEdge,
        fit: 'inside',
        withoutEnlargement: true,
    });
    const outputMime = declaredMime === 'image/jpeg' ? ('image/jpeg' as const) : ('image/png' as const);
    const encoded =
        outputMime === 'image/jpeg'
            ? pipeline.jpeg({ quality: 88, progressive: false, chromaSubsampling: '4:2:0', optimiseCoding: true })
            : pipeline.png({ compressionLevel: 9, progressive: false, palette: false });
    const result = await encoded.toBuffer({ resolveWithObject: true });
    if (!result.info.width || !result.info.height) rejected('invalid_output');
    return {
        bytes: result.data,
        mimeType: outputMime,
        width: result.info.width,
        height: result.info.height,
        checksum: `sha256:${createHash('sha256').update(result.data).digest('hex')}`,
        policyVersion: imageCdrPolicy.version,
        safetyEvidence: 'cdr_reencoded',
    };
}
