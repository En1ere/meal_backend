import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const tokenPayloadSchema = z.strictObject({
    version: z.literal(1),
    action: z.enum(['upload', 'download']),
    assetId: z.uuid(),
    userId: z.uuid(),
    accessKeyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    expiresAt: z.number().int().positive(),
});
export type MediaStorageTokenPayload = z.infer<typeof tokenPayloadSchema>;

const encode = (value: Uint8Array | string) => Buffer.from(value).toString('base64url');

export class MediaStorageTokenSigner {
    private readonly key: Buffer;
    constructor(
        keyBase64: string,
        private readonly accessKeyId: string,
    ) {
        this.key = Buffer.from(keyBase64, 'base64');
        if (this.key.length !== 32) throw new Error('Media storage signing key must decode to 32 bytes');
    }

    sign(input: Omit<MediaStorageTokenPayload, 'version' | 'accessKeyId'>): string {
        const payload = tokenPayloadSchema.parse({ version: 1, accessKeyId: this.accessKeyId, ...input });
        const encoded = encode(JSON.stringify(payload));
        return `${encoded}.${encode(createHmac('sha256', this.key).update(encoded).digest())}`;
    }

    verify(token: string, action: MediaStorageTokenPayload['action'], now = Date.now()): MediaStorageTokenPayload {
        const [encoded, signature, extra] = token.split('.');
        if (!encoded || !signature || extra || token.length > 2_000) throw new Error('Invalid media token');
        const expected = createHmac('sha256', this.key).update(encoded).digest();
        let actual: Buffer;
        try {
            actual = Buffer.from(signature, 'base64url');
        } catch {
            throw new Error('Invalid media token');
        }
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            throw new Error('Invalid media token');
        let payload: unknown;
        try {
            payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        } catch {
            throw new Error('Invalid media token');
        }
        const parsed = tokenPayloadSchema.parse(payload);
        if (parsed.action !== action || parsed.accessKeyId !== this.accessKeyId || parsed.expiresAt <= now)
            throw new Error('Invalid media token');
        return parsed;
    }
}
