import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { ingestLimitsSchema } from '../src/modules/inventory-ingest/ingest.contracts.js';
import { parseTable } from '../src/modules/inventory-ingest/table-parser.js';
import { checkZip } from '../src/modules/inventory-ingest/zip-safety.js';

const limits = ingestLimitsSchema.parse({});
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
