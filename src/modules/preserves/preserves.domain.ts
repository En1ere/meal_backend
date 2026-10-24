import { HttpException } from '@nestjs/common';
import { decimal, decimalText } from '../inventory/inventory.domain.js';
export function preserveTotal(values: Array<string | null>): string | null {
    if (values.some((v) => v === null)) return null;
    const sum = values.reduce<bigint>((total, v) => total + decimal(v!), 0n);
    if (sum > 999999999999999999999999n) throw new HttpException('Слишком большое количество', 422);
    return decimalText(sum);
}
export function preserveRemainder(current: string | null, amount: string): string {
    if (current === null) throw new HttpException('Сначала уточните количество выбранной банки', 409);
    const next = decimal(current) - decimal(amount);
    if (decimal(amount) <= 0n || next < 0n) throw new HttpException('Недопустимое количество расхода', 422);
    return decimalText(next);
}
export function preserveImage(value: string | null) {
    if (value === null) return null;
    if (/^\/(?:assets|preserves)\/[A-Za-z0-9/_-]+\.(?:png|jpe?g|webp)$/.test(value)) return value;
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' && !url.username && !url.password) return value;
    } catch {
        /* Invalid external URL. */
    }
    throw new HttpException('Недопустимый адрес изображения', 422);
}
