import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import sharp from 'sharp';
import { sanitizeImage } from '../dist/src/modules/media-processing/public.js';

sharp.cache(false);
sharp.concurrency(1);
const [input, output, declaredMime] = process.argv.slice(2);
const root = resolve('/tmp/meal-media-processor');
const inputPath = resolve(input ?? '');
const outputPath = resolve(output ?? '');
if (!inputPath.startsWith(`${root}${sep}`) || !outputPath.startsWith(`${root}${sep}`) || inputPath === outputPath)
    process.exit(64);
try {
    const result = await sanitizeImage(await readFile(inputPath), declaredMime ?? '');
    await writeFile(outputPath, result.bytes, { mode: 0o600, flag: 'wx' });
    process.stdout.write(
        JSON.stringify({
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
            checksum: result.checksum,
            policyVersion: result.policyVersion,
            safetyEvidence: result.safetyEvidence,
        }),
    );
} catch {
    process.exitCode = 1;
}
