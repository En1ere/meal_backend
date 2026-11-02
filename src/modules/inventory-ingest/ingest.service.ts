import {
    Inject,
    Injectable,
    BadRequestException,
    ServiceUnavailableException,
    RequestTimeoutException,
    ForbiddenException,
    UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { resolve as resolvePath } from 'node:path';
import type { FastifyRequest } from 'fastify';
import type {} from '@fastify/multipart';
import { sql } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import { ingestLimitsSchema, importPreviewSchema, scanPreviewSchema } from './ingest.contracts.js';
import { OcrPreviewClientError, requestOcrPreview } from './ocr-preview.client.js';

@Injectable()
export class InventoryIngestService {
    constructor(
        private readonly database: DatabaseService,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
    ) {}
    private active = 0;
    private scanActive = false;
    private readonly users = new Set<string>();
    readonly limits = ingestLimitsSchema.parse({
        ...Object.fromEntries(
            Object.entries({
                fileBytes: 'INGEST_FILE_BYTES',
                photos: 'INGEST_PHOTOS',
                pixels: 'INGEST_PIXELS',
                rows: 'INGEST_ROWS',
                sheets: 'INGEST_SHEETS',
                columns: 'INGEST_COLUMNS',
                timeoutMs: 'INGEST_TIMEOUT_MS',
                expandedBytes: 'INGEST_EXPANDED_BYTES',
            }).flatMap(([key, env]) => (process.env[env] ? [[key, Number(process.env[env])]] : [])),
        ),
    });
    async preview(request: FastifyRequest, kind: 'table' | 'scan', userId: string) {
        if (kind === 'scan' && !this.config.INLINE_INGEST_OCR_ENABLED)
            throw new ServiceUnavailableException({
                code: 'INGEST_OCR_DISABLED',
                message: 'Распознавание изображений временно недоступно.',
            });
        if (!request.isMultipart()) throw new UnsupportedMediaTypeException('Ожидался multipart/form-data');
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        const access = await sql<{
            allowed: boolean;
        }>`select exists(select 1 from meal.users u where u.id=${userId}::uuid and u.status='active' and u.archived_at is null and not exists(select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))) as allowed`.execute(
            this.database.db,
        );
        if (!access.rows[0]?.allowed) throw new ForbiddenException('Доступен только просмотр');
        if (this.active >= 2 || this.users.has(userId) || (kind === 'scan' && this.scanActive))
            throw new ServiceUnavailableException({
                code: 'INGEST_BUSY',
                message: 'Обработка занята. Повторите позже.',
            });
        this.active++;
        if (kind === 'scan') this.scanActive = true;
        this.users.add(userId);
        try {
            const files: { filename: string; mimetype: string; bytes: Buffer }[] = [];
            for await (const part of request.parts({
                limits: {
                    fileSize: this.limits.fileBytes,
                    files: kind === 'table' ? 1 : this.limits.photos,
                    fields: 0,
                    parts: kind === 'table' ? 1 : this.limits.photos,
                },
            })) {
                if (part.type !== 'file') throw new BadRequestException('Ожидался файл');
                const bytes = await part.toBuffer();
                if (!bytes.length || part.file.truncated)
                    throw new BadRequestException('Пустой или слишком большой файл');
                if (kind === 'scan' && !['image/jpeg', 'image/png', 'image/webp'].includes(part.mimetype))
                    throw new BadRequestException('Нужны JPEG, PNG или WebP');
                files.push({
                    filename: part.filename.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200),
                    mimetype: part.mimetype,
                    bytes,
                });
            }
            if (!files.length) throw new BadRequestException('Выберите файл');
            if (kind === 'scan' && this.config.OCR_PREVIEW_URL && this.config.OCR_PREVIEW_TOKEN) {
                const abortController = new AbortController();
                const abort = () => abortController.abort();
                request.raw.once('aborted', abort);
                try {
                    const images = [];
                    const warnings = new Set<string>();
                    for (const file of files) {
                        const preview = await requestOcrPreview(
                            {
                                url: this.config.OCR_PREVIEW_URL,
                                token: this.config.OCR_PREVIEW_TOKEN,
                                timeoutMs: this.config.OCR_PREVIEW_TIMEOUT_MS,
                            },
                            { bytes: file.bytes, mimeType: file.mimetype },
                            abortController.signal,
                        );
                        images.push({ filename: file.filename, text: preview.text, confidence: preview.confidence });
                        preview.warnings.forEach((warning) => warnings.add(warning));
                    }
                    return scanPreviewSchema.parse({ images, warnings: [...warnings], requiresReview: true });
                } catch (error) {
                    if (!(error instanceof OcrPreviewClientError)) throw error;
                    if (error.code === 'invalid_file')
                        throw new BadRequestException({
                            code: 'INGEST_INVALID_FILE',
                            message: 'Фотографию не удалось безопасно распознать.',
                        });
                    if (error.code === 'timeout')
                        throw new RequestTimeoutException(
                            'Распознавание заняло слишком много времени. Попробуйте ещё раз.',
                        );
                    throw new ServiceUnavailableException({
                        code: error.code === 'busy' ? 'INGEST_BUSY' : 'INGEST_OCR_UNAVAILABLE',
                        message: 'Распознавание временно недоступно. Повторите позже или заполните данные вручную.',
                    });
                } finally {
                    request.raw.off('aborted', abort);
                }
            }
            const result = await new Promise<unknown>((resolve, reject) => {
                const worker = new Worker(new URL('./ingest.worker.js', import.meta.url), {
                    workerData: {
                        kind,
                        files,
                        limits: this.limits,
                        models: process.env.OCR_MODELS_PATH ?? resolvePath('resources/ocr'),
                    },
                    resourceLimits: { maxOldGenerationSizeMb: 256 },
                });
                let done = false;
                const finish = (error: Error | null, value?: unknown) => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    request.raw.off('aborted', abort);
                    void worker.terminate();
                    if (error) reject(error);
                    else resolve(value);
                };
                const abort = () => finish(new RequestTimeoutException('Загрузка отменена'));
                const timer = setTimeout(
                    () =>
                        finish(
                            new RequestTimeoutException(
                                'Обработка заняла слишком много времени. Попробуйте меньший файл.',
                            ),
                        ),
                    this.limits.timeoutMs,
                );
                request.raw.once('aborted', abort);
                worker.once('message', (message: { ok: boolean; data?: unknown; message?: string }) =>
                    finish(
                        message.ok
                            ? null
                            : new BadRequestException({
                                  code: 'INGEST_INVALID_FILE',
                                  message: message.message ?? 'Файл не удалось обработать',
                              }),
                        message.data,
                    ),
                );
                worker.once('error', () => finish(new BadRequestException('Не удалось обработать файл')));
                worker.once('exit', () => {
                    if (!done) finish(new BadRequestException('Обработка прервана'));
                });
            });
            return kind === 'table' ? importPreviewSchema.parse(result) : scanPreviewSchema.parse(result);
        } finally {
            this.active--;
            if (kind === 'scan') this.scanActive = false;
            this.users.delete(userId);
        }
    }
}
