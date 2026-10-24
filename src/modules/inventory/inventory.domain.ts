import { HttpException } from '@nestjs/common';
import type { InventoryBatch, InventoryCommand } from './inventory.contracts.js';

export function decimal(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole ?? '0') * 100000000n + BigInt(fraction.padEnd(8, '0'));
}
export function decimalText(value: bigint): string {
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const fraction = (absolute % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
    return `${negative ? '-' : ''}${absolute / 100000000n}${fraction ? `.${fraction}` : ''}`;
}
export function transition(batch: InventoryBatch, command: InventoryCommand, now: string): InventoryBatch {
    if (batch.version !== command.version) throw new HttpException('Версия партии изменилась', 412);
    if (batch.archivedAt && command.action !== 'restore') throw new HttpException('Партия в архиве', 409);
    let next = { ...batch, version: batch.version + 1 };
    if (command.action === 'edit') next = { ...next, ...command.fields };
    if (command.action === 'consume') {
        if (batch.quantity === null) throw new HttpException('Сначала уточните остаток', 409);
        const amount = decimal(command.quantity);
        if (amount <= 0n || amount > decimal(batch.quantity))
            throw new HttpException('Недопустимое количество расхода', 422);
        next.quantity = decimalText(decimal(batch.quantity) - amount);
    }
    if (command.action === 'transfer') next.locationId = command.locationId;
    if (command.action === 'archive') next.archivedAt = now;
    if (command.action === 'restore') {
        if (!batch.archivedAt) throw new HttpException('Партия уже активна', 409);
        next.archivedAt = null;
    }
    return next;
}
export function requireVersion(header: string | string[] | undefined, version: number): void {
    if (!header) throw new HttpException('Необходим If-Match', 428);
    if (header !== `"${version}"`) throw new HttpException('If-Match не совпадает с версией', 412);
}
