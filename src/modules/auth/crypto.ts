import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
    randomBytes,
    scrypt,
    timingSafeEqual,
} from 'node:crypto';

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const keyedHash = (key: string, value: string) => createHmac('sha256', key).update(value).digest('base64url');
export function equalSecret(left: string, right: string): boolean {
    const a = Buffer.from(left),
        b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}
const dummyHash = `scrypt$32768$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
export async function verifyPassword(password: string, stored = dummyHash): Promise<boolean> {
    const parts = stored.split('$');
    if (
        parts.length !== 6 ||
        parts[0] !== 'scrypt' ||
        parts[1] !== '32768' ||
        parts[2] !== '8' ||
        parts[3] !== '1' ||
        !/^[a-f0-9]{32}$/.test(parts[4] ?? '') ||
        !/^[a-f0-9]{128}$/.test(parts[5] ?? '')
    )
        return false;
    const actual = await new Promise<Buffer>((resolve, reject) =>
        scrypt(password, parts[4]!, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) =>
            error ? reject(error) : resolve(result),
        ),
    );
    return timingSafeEqual(actual, Buffer.from(parts[5]!, 'hex'));
}
export function encryptSecret(secret: string, key: string, factorId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
    cipher.setAAD(Buffer.from(factorId));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [
        'v1',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
    ].join('.');
}
export function decryptSecret(value: string, key: string, factorId: string): string {
    const [version, iv, tag, ciphertext] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Invalid encrypted factor');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(factorId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const hash = await new Promise<Buffer>((resolve, reject) =>
        scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) =>
            error ? reject(error) : resolve(result),
        ),
    );
    return `scrypt$32768$8$1$${salt}$${hash.toString('hex')}`;
}
