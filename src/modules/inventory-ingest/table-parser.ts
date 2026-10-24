import * as XLSX from 'xlsx';
import type { ImportPreview, IngestLimits } from './ingest.contracts.js';
import { checkZip } from './zip-safety.js';

export function parseTable(bytes: Buffer, filename: string, limits: IngestLimits): ImportPreview {
    const extension = filename.toLowerCase().split('.').at(-1);
    if (!extension || !['csv', 'tsv', 'xlsx', 'ods'].includes(extension))
        throw new Error('Допустимы CSV, TSV, XLSX и ODS');
    if (!bytes.length || bytes.length > limits.fileBytes) throw new Error('Пустой или слишком большой файл');
    const zipped = extension === 'xlsx' || extension === 'ods';
    if (zipped) checkZip(bytes, limits.expandedBytes);
    else if (bytes.includes(0)) throw new Error('CSV/TSV должен быть текстом UTF-8');
    const workbook = XLSX.read(zipped ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
        type: zipped ? 'buffer' : 'string',
        raw: true,
        cellFormula: true,
        cellDates: true,
        cellHTML: false,
        cellStyles: false,
        bookVBA: false,
        bookDeps: false,
        sheetRows: limits.rows + 2,
        ...(extension === 'tsv' ? { FS: '\t' } : {}),
    });
    if (workbook.SheetNames.length > limits.sheets) throw new Error('Превышен лимит листов');
    let total = 0,
        formulas = 0,
        characters = 0;
    const sheets = workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name]!;
        const fullRange: unknown = sheet['!fullref'];
        const range = XLSX.utils.decode_range(typeof fullRange === 'string' ? fullRange : (sheet['!ref'] ?? 'A1:A1'));
        if (range.e.c + 1 > limits.columns || range.e.r + 1 > limits.rows)
            throw new Error('Превышен лимит строк или колонок');
        const rows: string[][] = [];
        for (let r = 0; r <= range.e.r; r++) {
            const row: string[] = [];
            for (let c = 0; c <= range.e.c; c++) {
                const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
                if (cell?.f) formulas++;
                const value = cell?.f ? '' : cell?.v;
                const text =
                    value === undefined || value === null
                        ? ''
                        : value instanceof Date
                          ? value.toISOString().slice(0, 10)
                          : String(value);
                if (text.length > 2000) throw new Error('Слишком длинное значение ячейки');
                characters += text.length;
                if (characters > limits.expandedBytes / 2) throw new Error('Превышен размер текстового предпросмотра');
                row.push(text);
            }
            rows.push(row);
        }
        total += rows.length;
        if (total > limits.rows) throw new Error('Превышен общий лимит строк');
        return { name, rows };
    });
    return { filename, sheets, warnings: formulas ? [`Пропущено формул: ${formulas}. Проверьте пустые ячейки.`] : [] };
}
