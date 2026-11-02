import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { imageCdrPolicy, sanitizeImage } from '../src/modules/media-processing/image-cdr.js';

void test('CDR accepts only bounded JPEG/PNG/WebP and emits canonical metadata-free images', async () => {
    for (const mime of imageCdrPolicy.acceptedMimeTypes) {
        const format = mime === 'image/jpeg' ? 'jpeg' : mime === 'image/png' ? 'png' : 'webp';
        const source = await sharp({
            create: { width: 32, height: 24, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
        })
            .withMetadata({ orientation: 6 })
            .toFormat(format)
            .toBuffer();
        const result = await sanitizeImage(source, mime);
        assert.equal(result.safetyEvidence, 'cdr_reencoded');
        assert.equal(result.policyVersion, 'image-cdr-v1');
        assert.match(result.checksum, /^sha256:[0-9a-f]{64}$/);
        assert.ok(result.width <= 1_600 && result.height <= 1_600);
        const metadata = await sharp(result.bytes).metadata();
        assert.equal(metadata.exif, undefined);
        assert.equal(metadata.xmp, undefined);
        assert.equal(metadata.icc, undefined);
        assert.equal(metadata.pages ?? 1, 1);
    }
});

void test('CDR rejects unsupported, mismatched and corrupt input fail closed', async () => {
    const png = await sharp({
        create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
        .png()
        .toBuffer();
    await assert.rejects(sanitizeImage(png, 'application/pdf'), /mime_not_allowed/);
    await assert.rejects(sanitizeImage(png, 'image/jpeg'), /mime_mismatch/);
    await assert.rejects(sanitizeImage(Buffer.from('not-an-image'), 'image/png'));
});
