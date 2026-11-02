import { UnsupportedMediaTypeException } from '@nestjs/common';
import { Transform } from 'node:stream';

const ascii = (value: Buffer, start: number, end: number) => value.subarray(start, end).toString('ascii');

export function detectMediaMime(value: Buffer): string | null {
    if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return 'image/jpeg';
    if (value.length >= 8 && value.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
    if (value.length >= 12 && ascii(value, 0, 4) === 'RIFF' && ascii(value, 8, 12) === 'WEBP') return 'image/webp';
    if (value.length >= 5 && ascii(value, 0, 5) === '%PDF-') return 'application/pdf';
    if (value.length >= 4 && value.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) return 'video/webm';
    if (value.length >= 16 && ascii(value, 4, 8) === 'ftyp') {
        const boxBytes = value.readUInt32BE(0);
        if (boxBytes < 16) return null;
        const brands = [ascii(value, 8, 12)];
        for (let offset = 16; offset + 4 <= Math.min(value.length, boxBytes); offset += 4)
            brands.push(ascii(value, offset, offset + 4));
        if (brands.includes('qt  ')) return 'video/quicktime';
        if (brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)))
            return 'image/heic';
        if (brands.some((brand) => ['mif1', 'msf1'].includes(brand))) return 'image/heif';
        if (
            brands.some((brand) =>
                ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand),
            )
        )
            return 'video/mp4';
        return null;
    }
    const text = value
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trimStart();
    if (text.startsWith('{') || text.startsWith('[')) return 'application/json';
    if (text.length && !value.includes(0)) return 'text/csv';
    return null;
}

export class MediaMimeVerifier extends Transform {
    private pending = Buffer.alloc(0);
    private verified = false;
    constructor(private readonly expectedMime: string) {
        super();
    }
    private verify(): void {
        const actual = detectMediaMime(this.pending);
        if (actual !== this.expectedMime)
            throw new UnsupportedMediaTypeException('Содержимое файла не совпадает с MIME');
        this.verified = true;
        this.push(this.pending);
        this.pending = Buffer.alloc(0);
    }
    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            if (this.verified) this.push(chunk);
            else {
                this.pending = Buffer.concat([this.pending, chunk]);
                if (this.pending.length >= 32) this.verify();
            }
            callback();
        } catch (error) {
            callback(error as Error);
        }
    }
    override _flush(callback: (error?: Error | null) => void): void {
        try {
            if (!this.verified) this.verify();
            callback();
        } catch (error) {
            callback(error as Error);
        }
    }
}
