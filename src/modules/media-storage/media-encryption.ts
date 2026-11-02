import { createCipheriv, createDecipheriv, createHash, type DecipherGCM } from 'node:crypto';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const envelopeMagic = Buffer.from('MEALMED1', 'ascii');
const nonceBytes = 12;
export const encryptedMediaHeaderBytes = envelopeMagic.length + nonceBytes;

export type MediaEncryptionResult = Readonly<{
    sizeBytes: number;
    checksum: string;
    nonce: string;
    authenticationTag: string;
}>;

export type MediaEncryptionContext = Readonly<{ assetId: string; purpose: string; keyVersion: number }>;

export function mediaEncryptionAad(context: MediaEncryptionContext): Buffer {
    if (!/^[0-9a-f-]{36}$/.test(context.assetId) || !/^[a-z_]{3,32}$/.test(context.purpose))
        throw new Error('Invalid media encryption context');
    if (!Number.isInteger(context.keyVersion) || context.keyVersion < 1 || context.keyVersion > 32767)
        throw new Error('Invalid media encryption context');
    return Buffer.from(`meal-media-aad-v1\n${context.assetId}\n${context.purpose}\n${context.keyVersion}`, 'utf8');
}

export function encryptMediaStream(
    source: Readable,
    key: Buffer,
    nonce: Buffer,
    maximumBytes: number,
    context: MediaEncryptionContext,
    inputVerifier?: Transform,
): Readonly<{ body: Readable; completion: Promise<MediaEncryptionResult>; cancel(error: Error): void }> {
    if (key.length !== 32 || nonce.length !== nonceBytes) throw new Error('Invalid media encryption material');
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const verifier = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            sizeBytes += chunk.length;
            if (sizeBytes > maximumBytes) return callback(new Error('MEDIA_TOO_LARGE'));
            hash.update(chunk);
            callback(null, chunk);
        },
    });
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(mediaEncryptionAad(context));
    let headerWritten = false;
    const packager = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            if (!headerWritten) {
                this.push(Buffer.concat([envelopeMagic, nonce]));
                headerWritten = true;
            }
            callback(null, chunk);
        },
        flush(callback) {
            if (!headerWritten) this.push(Buffer.concat([envelopeMagic, nonce]));
            callback();
        },
    });
    const body = new PassThrough();
    const transfer = inputVerifier
        ? pipeline(source, inputVerifier, verifier, cipher, packager, body)
        : pipeline(source, verifier, cipher, packager, body);
    const completion = transfer.then(() => ({
        sizeBytes,
        checksum: `sha256:${hash.digest('hex')}`,
        nonce: nonce.toString('base64url'),
        authenticationTag: cipher.getAuthTag().toString('base64url'),
    }));
    return {
        body,
        completion,
        cancel(error: Error) {
            source.destroy(error);
            body.destroy();
        },
    };
}

export function decryptMediaStream(
    source: Readable,
    key: Buffer,
    expectedNonce: Buffer,
    authenticationTag: Buffer,
    context: MediaEncryptionContext,
    expectedChecksum: string,
): Readonly<{ body: Readable; completion: Promise<void> }> {
    if (key.length !== 32 || expectedNonce.length !== nonceBytes || authenticationTag.length !== 16)
        throw new Error('Invalid media decryption material');
    let header = Buffer.alloc(0);
    let initialized = false;
    let decipher: DecipherGCM | undefined;
    const hash = createHash('sha256');
    const output = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            try {
                let content = chunk;
                if (!initialized) {
                    header = Buffer.concat([header, chunk]);
                    if (header.length < encryptedMediaHeaderBytes) return callback();
                    const magic = header.subarray(0, envelopeMagic.length);
                    const nonce = header.subarray(envelopeMagic.length, encryptedMediaHeaderBytes);
                    if (!magic.equals(envelopeMagic) || !nonce.equals(expectedNonce))
                        throw new Error('Invalid encrypted media header');
                    decipher = createDecipheriv('aes-256-gcm', key, nonce);
                    decipher.setAuthTag(authenticationTag);
                    decipher.setAAD(mediaEncryptionAad(context));
                    content = header.subarray(encryptedMediaHeaderBytes);
                    initialized = true;
                }
                if (content.length) {
                    const plain = decipher!.update(content);
                    hash.update(plain);
                    this.push(plain);
                }
                callback();
            } catch (error) {
                callback(error as Error);
            }
        },
        flush(callback) {
            try {
                if (!initialized || !decipher) throw new Error('Encrypted media is truncated');
                const final = decipher.final();
                hash.update(final);
                if (`sha256:${hash.digest('hex')}` !== expectedChecksum)
                    throw new Error('Media plaintext checksum mismatch');
                this.push(final);
                callback();
            } catch (error) {
                callback(error as Error);
            }
        },
    });
    const body = new PassThrough();
    const completion = pipeline(source, output, body).then(() => undefined);
    return { body, completion };
}
