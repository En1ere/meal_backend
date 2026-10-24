import { inflateRawSync } from 'node:zlib';

// Check central and local headers before SheetJS allocates/decompresses anything.
export function checkZip(bytes: Buffer, maxExpanded: number): void {
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (bytes.readUInt32LE(i) === 0x06054b50) {
            end = i;
            break;
        }
    }
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Некорректный архив');
    const count = bytes.readUInt16LE(end + 10);
    let cursor = bytes.readUInt32LE(end + 16),
        total = 0;
    if (count > 2000 || count === 65535) throw new Error('Слишком много объектов в архиве');
    const names = new Set<string>();
    for (let index = 0; index < count; index++) {
        if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Некорректный архив');
        const flags = bytes.readUInt16LE(cursor + 8),
            method = bytes.readUInt16LE(cursor + 10);
        const compressed = bytes.readUInt32LE(cursor + 20),
            expanded = bytes.readUInt32LE(cursor + 24);
        const nameLength = bytes.readUInt16LE(cursor + 28),
            extra = bytes.readUInt16LE(cursor + 30),
            comment = bytes.readUInt16LE(cursor + 32);
        const local = bytes.readUInt32LE(cursor + 42);
        const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
        if (
            flags & 1 ||
            ![0, 8].includes(method) ||
            name.includes('..') ||
            name.includes('\\') ||
            name.startsWith('/') ||
            names.has(name) ||
            /vbaProject|externalLinks/i.test(name)
        )
            throw new Error('Неподдерживаемое содержимое архива');
        names.add(name);
        if (local + 30 > cursor || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Некорректный архив');
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        if (start + compressed > cursor || expanded > maxExpanded - total)
            throw new Error('Превышен размер распакованных данных');
        const input = bytes.subarray(start, start + compressed);
        const output =
            method === 0 ? input : inflateRawSync(input, { maxOutputLength: Math.max(1, maxExpanded - total) });
        if (output.length !== expanded) throw new Error('Некорректный размер объекта архива');
        total += output.length;
        if (total > maxExpanded) throw new Error('Превышен размер распакованных данных');
        cursor += 46 + nameLength + extra + comment;
    }
    if (cursor !== end) throw new Error('Неподдерживаемая структура архива');
}
