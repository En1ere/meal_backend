import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ServiceUnavailableException, UnsupportedMediaTypeException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import * as XLSX from 'xlsx';
import { readConfig } from '../src/app/config.js';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import {
    checkZip,
    ingestLimitsSchema,
    InventoryIngestService,
    parseTable,
} from '../src/modules/inventory-ingest/public.js';

const limits = ingestLimitsSchema.parse({});
const productionConfig = () =>
    readConfig({
        NODE_ENV: 'production',
        FRONTEND_ORIGIN: 'https://meal.example.test',
        DATABASE_URL: 'postgresql://meal_app:test@localhost/meal_planner_postgres',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });

void test('legacy inline OCR is enabled by default only outside production and remains explicitly configurable', () => {
    assert.equal(readConfig({ NODE_ENV: 'development' }).INLINE_INGEST_OCR_ENABLED, true);
    assert.equal(readConfig({ NODE_ENV: 'test' }).INLINE_INGEST_OCR_ENABLED, true);
    assert.equal(productionConfig().INLINE_INGEST_OCR_ENABLED, false);
    assert.equal(
        readConfig({
            NODE_ENV: 'test',
            INLINE_INGEST_OCR_ENABLED: 'false',
        }).INLINE_INGEST_OCR_ENABLED,
        false,
    );
    assert.throws(
        () =>
            readConfig({
                NODE_ENV: 'production',
                FRONTEND_ORIGIN: 'https://meal.example.test',
                DATABASE_URL: 'postgresql://meal_app:test@localhost/meal_planner_postgres',
                SECURITY_KEY: randomBytes(32).toString('base64'),
                MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
                INLINE_INGEST_OCR_ENABLED: 'true',
            }),
        /isolated internal preview service/,
    );
    const preview = readConfig({
        NODE_ENV: 'test',
        INLINE_INGEST_OCR_ENABLED: 'true',
        OCR_PREVIEW_URL: 'http://ocr-preview:3100',
        OCR_PREVIEW_TOKEN: 'a'.repeat(64),
    });
    assert.equal(preview.OCR_PREVIEW_URL, 'http://ocr-preview:3100');
    assert.equal(preview.OCR_PREVIEW_TIMEOUT_MS, 60_000);
    assert.throws(
        () => readConfig({ NODE_ENV: 'test', OCR_PREVIEW_URL: 'http://ocr-preview:3100' }),
        /configured together/,
    );
    assert.throws(() => readConfig({ INLINE_INGEST_OCR_ENABLED: 'yes' }), /INLINE_INGEST_OCR_ENABLED/);
});

void test('disabled legacy OCR fails closed before request, database or worker processing while table import is unchanged', async () => {
    const database = new Proxy(
        {},
        {
            get() {
                throw new Error('database must not be accessed');
            },
        },
    ) as DatabaseService;
    const service = new InventoryIngestService(
        database,
        readConfig({ NODE_ENV: 'test', INLINE_INGEST_OCR_ENABLED: 'false' }),
    );
    const inaccessibleRequest = new Proxy(
        {},
        {
            get() {
                throw new Error('request must not be accessed');
            },
        },
    ) as FastifyRequest;
    await assert.rejects(
        service.preview(inaccessibleRequest, 'scan', 'c9cc69e6-430f-4ef8-b6fe-335647a248d0'),
        (error: unknown) => {
            assert.ok(error instanceof ServiceUnavailableException);
            assert.equal(error.getStatus(), 503);
            assert.deepEqual(error.getResponse(), {
                code: 'INGEST_OCR_DISABLED',
                message: 'Распознавание изображений временно недоступно.',
            });
            return true;
        },
    );
    await assert.rejects(
        service.preview(
            { isMultipart: () => false } as FastifyRequest,
            'table',
            'c9cc69e6-430f-4ef8-b6fe-335647a248d0',
        ),
        UnsupportedMediaTypeException,
    );
});

void test('CSV and TSV preserve quoted fields, Cyrillic, unknown quantity and separate rows', () => {
    const csv = parseTable(
        Buffer.from('Название;Количество;Единица\n"Молоко; цельное";1;л\nЯйца;;шт'),
        'data.csv',
        limits,
    );
    assert.deepEqual(csv.sheets[0]!.rows[1], ['Молоко; цельное', '1', 'л']);
    assert.equal(csv.sheets[0]!.rows[2]![1], '');
    assert.deepEqual(parseTable(Buffer.from('Название\tКоличество\nСахар\t2'), 'data.tsv', limits).sheets[0]!.rows[1], [
        'Сахар',
        '2',
    ]);
});
void test('XLSX and ODS are parsed locally; formula results are never accepted', () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
        ['Название', 'Количество'],
        ['Молоко', 2],
    ]);
    sheet.B2 = { t: 'n', f: '1+1', v: 2 };
    XLSX.utils.book_append_sheet(workbook, sheet, 'Лист 1');
    const xlsx = parseTable(
        XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer,
        'data.xlsx',
        limits,
    );
    assert.equal(xlsx.sheets[0]!.rows[1]![1], '');
    assert.equal(xlsx.warnings.length, 1);
    const ods = parseTable(
        XLSX.write(workbook, { type: 'buffer', bookType: 'ods', compression: true }) as Buffer,
        'data.ods',
        limits,
    );
    assert.equal(ods.sheets[0]!.rows[1]![0], 'Молоко');
});
void test('limits apply to totals across sheets and reject hidden excessive used ranges', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['a'], ['b']]), 'first');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['a'], ['b']]), 'second');
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    assert.throws(() => parseTable(bytes, 'data.xlsx', { ...limits, rows: 3 }), /общий лимит/);
    assert.throws(() => parseTable(Buffer.from('a,b,c'), 'data.csv', { ...limits, columns: 2 }), /лимит/);
    assert.throws(() => parseTable(bytes, 'data.xlsx', { ...limits, sheets: 1 }), /лимит листов/);
});
void test('unsupported or oversized data and malicious ZIP expansion are rejected', () => {
    assert.throws(() => parseTable(Buffer.from('a'), 'data.xls', limits), /Допустимы/);
    assert.throws(() => parseTable(Buffer.from([0xff, 0xff]), 'data.csv', limits));
    assert.throws(() => parseTable(Buffer.alloc(2), 'data.csv', { ...limits, fileBytes: 1 }), /большой/);
    assert.throws(() => checkZip(Buffer.from('notzip'), 100));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['x'.repeat(5000)]]), 'sheet');
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
    assert.throws(() => checkZip(bytes, 100), /размер/);
});
