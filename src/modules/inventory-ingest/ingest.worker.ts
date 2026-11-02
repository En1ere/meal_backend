import { parentPort, workerData } from 'node:worker_threads';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createWorker } from 'tesseract.js';
import { sanitizeImage } from '../media-processing/image-cdr.js';
import { parseTable } from './table-parser.js';
import type { IngestLimits } from './ingest.contracts.js';

interface Job {
    kind: 'table' | 'scan';
    files: { filename: string; mimetype?: string; bytes: Uint8Array }[];
    limits: IngestLimits;
    models: string | undefined;
}
const job = workerData as Job;
try {
    if (job.kind === 'table') {
        const file = job.files[0]!;
        parentPort!.postMessage({ ok: true, data: parseTable(Buffer.from(file.bytes), file.filename, job.limits) });
    } else {
        if (!job.models)
            throw new Error(
                'OCR_MODELS_PATH не задан. Загрузите локальные модели rus и eng или заполните продукт вручную.',
            );
        const models = resolve(job.models);
        try {
            await Promise.all(['rus', 'eng'].map((language) => access(join(models, `${language}.traineddata`))));
        } catch {
            throw new Error('Локальные модели OCR недоступны. Заполните продукт вручную и сообщите администратору.');
        }
        const worker = await createWorker(['rus', 'eng'], 1, { langPath: models, gzip: false, cacheMethod: 'none' });
        const images = [];
        try {
            for (const file of job.files) {
                const normalized = await sanitizeImage(Buffer.from(file.bytes), file.mimetype ?? '');
                const result = await worker.recognize(normalized.bytes);
                images.push({
                    filename: file.filename,
                    text: result.data.text.slice(0, 20000),
                    confidence: result.data.confidence,
                });
            }
        } finally {
            await worker.terminate();
        }
        parentPort!.postMessage({
            ok: true,
            data: {
                images,
                warnings: [
                    'Распознавание может ошибаться. Проверьте название, количество, единицу и даты перед сохранением.',
                ],
                requiresReview: true,
            },
        });
    }
} catch (error) {
    parentPort!.postMessage({
        ok: false,
        message: error instanceof Error ? error.message : 'Файл не удалось обработать',
    });
}
