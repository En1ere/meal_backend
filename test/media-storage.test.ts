import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { readConfig } from '../src/app/config.js';
import {
    decryptMediaStream,
    detectMediaMime,
    DisabledMediaObjectStore,
    encryptMediaStream,
    MediaMimeVerifier,
    mediaPurposePolicy,
    MediaStorageTokenSigner,
} from '../src/modules/media-storage/public.js';

const bytes = async (stream: Readable): Promise<Buffer> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
        assert.ok(chunk instanceof Uint8Array);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
};

void test('media config is all-or-nothing, credential-free and independently keyed', () => {
    assert.equal(readConfig({ NODE_ENV: 'test' }).LEGAL_EVIDENCE_MODE, 'approved');
    assert.equal(
        readConfig({ NODE_ENV: 'test', LEGAL_EVIDENCE_MODE: 'demonstration' }).LEGAL_EVIDENCE_MODE,
        'demonstration',
    );
    assert.throws(() => readConfig({ LEGAL_EVIDENCE_MODE: 'unsafe' }), /LEGAL_EVIDENCE_MODE/);
    assert.throws(
        () => readConfig({ NODE_ENV: 'test', MEDIA_STORAGE_ENDPOINT: 'https://storage.example' }),
        /MEDIA_STORAGE_ENABLED/,
    );
    const key = randomBytes(32).toString('base64');
    const signing = randomBytes(32).toString('base64');
    const mediaEnv = {
        NODE_ENV: 'test',
        MEDIA_STORAGE_ENABLED: 'true',
        MEDIA_STORAGE_ENDPOINT: 'http://seaweedfs',
        MEDIA_STORAGE_BACKEND_PORT: '8333',
        MEDIA_STORAGE_REGION: 'us-east-1',
        MEDIA_STORAGE_ACCESS_KEY_ID: 'meal-backend',
        MEDIA_STORAGE_SECRET_ACCESS_KEY: 'storage-secret-access-key-value-1234',
        MEDIA_STORAGE_QUARANTINE_BUCKET: 'meal-media-quarantine',
        MEDIA_STORAGE_READY_BUCKET: 'meal-media-ready',
        MEDIA_STORAGE_PREFIX: 'meal',
        MEDIA_STORAGE_FORCE_PATH_STYLE: 'true',
        MEDIA_STORAGE_PUBLIC_ORIGIN: 'https://meal.example.test',
        MEDIA_STORAGE_SIGNING_KEY: signing,
        MEDIA_STORAGE_ENCRYPTION_KEY: key,
        MEDIA_STORAGE_KEY_VERSION: '1',
    } as const;
    const config = readConfig(mediaEnv);
    assert.equal(config.MEDIA_STORAGE_BACKEND_PORT, 8333);
    assert.equal(config.MEDIA_STORAGE_FORCE_PATH_STYLE, true);
    assert.throws(
        () =>
            readConfig({
                ...mediaEnv,
                MEDIA_STORAGE_ENDPOINT: 'https://user:password@storage.example',
            }),
        /credential-free/,
    );
    assert.throws(
        () =>
            readConfig({
                NODE_ENV: 'test',
                MEDIA_STORAGE_ENABLED: 'true',
                MEDIA_STORAGE_ENDPOINT: 'https://storage.example',
            }),
        /complete endpoint/,
    );
    assert.throws(
        () =>
            readConfig({
                ...mediaEnv,
                NODE_ENV: 'production',
                FRONTEND_ORIGIN: 'https://meal.example.test',
                DATABASE_URL: 'postgresql://meal_runtime:fixture@localhost/meal_planner_postgres',
                SECURITY_KEY: randomBytes(32).toString('base64'),
                MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
            }),
        /root-owned \*_FILE/,
    );
});

void test('AES-GCM media envelope round-trips and rejects wrong authentication metadata', async () => {
    const plain = Buffer.from('private media payload');
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const context = {
        assetId: '00000000-0000-4000-8000-000000000001',
        purpose: 'profile_avatar',
        keyVersion: 1,
    };
    const encrypted = encryptMediaStream(Readable.from([plain]), key, nonce, 1024, context);
    const stored = await bytes(encrypted.body);
    const metadata = await encrypted.completion;
    assert.equal(metadata.sizeBytes, plain.length);
    assert.equal(metadata.checksum.length, 'sha256:'.length + 64);
    const decryptedStream = decryptMediaStream(
        Readable.from([stored.subarray(0, 7), stored.subarray(7)]),
        key,
        Buffer.from(metadata.nonce, 'base64url'),
        Buffer.from(metadata.authenticationTag, 'base64url'),
        context,
        metadata.checksum,
    );
    const decrypted = await bytes(decryptedStream.body);
    await decryptedStream.completion;
    assert.deepEqual(decrypted, plain);
    const wrongContext = decryptMediaStream(
        Readable.from([stored]),
        key,
        Buffer.from(metadata.nonce, 'base64url'),
        Buffer.from(metadata.authenticationTag, 'base64url'),
        { ...context, purpose: 'community_media' },
        metadata.checksum,
    );
    const wrongContextResults = await Promise.allSettled([bytes(wrongContext.body), wrongContext.completion]);
    assert.equal(
        wrongContextResults.every((result) => result.status === 'rejected'),
        true,
    );
    const wrongTag = decryptMediaStream(
        Readable.from([stored]),
        key,
        Buffer.from(metadata.nonce, 'base64url'),
        randomBytes(16),
        context,
        metadata.checksum,
    );
    const wrongTagResults = await Promise.allSettled([bytes(wrongTag.body), wrongTag.completion]);
    assert.equal(
        wrongTagResults.every((result) => result.status === 'rejected'),
        true,
    );
    const wrongChecksum = decryptMediaStream(
        Readable.from([stored]),
        key,
        Buffer.from(metadata.nonce, 'base64url'),
        Buffer.from(metadata.authenticationTag, 'base64url'),
        context,
        `sha256:${'0'.repeat(64)}`,
    );
    const wrongChecksumResults = await Promise.allSettled([bytes(wrongChecksum.body), wrongChecksum.completion]);
    assert.equal(
        wrongChecksumResults.every((result) => result.status === 'rejected'),
        true,
    );
});

void test('media sniffing detects supported signatures and rejects declared MIME mismatch before forwarding', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]);
    assert.equal(detectMediaMime(png), 'image/png');
    assert.equal(detectMediaMime(Buffer.from('%PDF-1.7\n')), 'application/pdf');
    const quicktime = Buffer.alloc(20);
    quicktime.writeUInt32BE(20, 0);
    quicktime.write('ftypqt  ', 4, 'ascii');
    assert.equal(detectMediaMime(quicktime), 'video/quicktime');
    const unknownBrand = Buffer.from(quicktime);
    unknownBrand.write('evil', 8, 'ascii');
    assert.equal(detectMediaMime(unknownBrand), null);
    assert.deepEqual(await bytes(Readable.from([png]).pipe(new MediaMimeVerifier('image/png'))), png);
    await assert.rejects(bytes(Readable.from([png]).pipe(new MediaMimeVerifier('image/jpeg'))), HttpException);
});

void test('media tokens are action, owner, asset, key-id and expiry bound', () => {
    const signer = new MediaStorageTokenSigner(randomBytes(32).toString('base64'), 'meal-backend');
    const payload = {
        action: 'upload' as const,
        assetId: '00000000-0000-4000-8000-000000000001',
        userId: '00000000-0000-4000-8000-000000000002',
        nonce: randomBytes(16).toString('base64url'),
        expiresAt: Date.now() + 60_000,
    };
    const token = signer.sign(payload);
    assert.equal(signer.verify(token, 'upload').assetId, payload.assetId);
    assert.throws(() => signer.verify(token, 'download'), /Invalid media token/);
    assert.throws(() => signer.verify(token, 'upload', payload.expiresAt), /Invalid media token/);
    assert.throws(() => signer.verify(`${token}x`, 'upload'), /Invalid media token/);
});

void test('purpose policy limits MIME/size and keeps privileged sources off the user reservation API', () => {
    assert.equal(mediaPurposePolicy('profile_avatar', 'image/webp', 100).userReservable, true);
    assert.equal(mediaPurposePolicy('billing_document', 'application/pdf', 100).userReservable, false);
    assert.throws(() => mediaPurposePolicy('profile_avatar', 'image/svg+xml', 100), HttpException);
    assert.throws(() => mediaPurposePolicy('profile_avatar', 'image/png', 6 * 1024 * 1024), HttpException);
});

void test('provider port remains explicit fail-closed while the reviewed S3 adapter is disabled', async () => {
    const store = new DisabledMediaObjectStore();
    assert.deepEqual(store.status(), { configured: false, provider: null, endpoint: null });
    await assert.rejects(store.read('quarantine', 'meal/quarantine/asset'), ServiceUnavailableException);
});

void test('schema v32 and application grants preserve quarantine lifecycle and least privilege', () => {
    const migration = readFileSync('database/migrations/032_media_storage_lifecycle.sql', 'utf8');
    const grants = readFileSync('database/application-grants.sql', 'utf8');
    assert.doesNotMatch(migration, /OLD\.state = 'uploading' AND NEW\.state[^\n]*'reserved'/);
    assert.match(migration, /r\.state IN \('quarantined','deleted'\)/);
    assert.match(migration, /a\.status = r\.state/);
    assert.match(grants, /every migration listed in database\/manifest\.json/);
    assert.match(grants, /GRANT UPDATE\(state,completed_at,failure_code,updated_at,version\)/);
    assert.doesNotMatch(grants, /GRANT DELETE ON meal\.media_/);
});

void test('schema v33 binds image reservations to exact domain targets and durable processing evidence', () => {
    const migration = readFileSync('database/migrations/033_media_target_processing.sql', 'utf8');
    const grants = readFileSync('database/application-grants.sql', 'utf8');
    const generated = readFileSync('src/infrastructure/database/schema.generated.ts', 'utf8');
    assert.match(migration, /'inventory_source'/);
    assert.match(migration, /ADD COLUMN intake_id uuid/);
    assert.match(migration, /ADD COLUMN diary_entry_id uuid/);
    assert.match(migration, /ADD COLUMN support_message_id uuid/);
    assert.match(migration, /ADD COLUMN avatar_user_id uuid/);
    assert.match(migration, /num_nonnulls\(intake_id,diary_entry_id,support_message_id,avatar_user_id\)/);
    assert.match(migration, /declared_mime IN \('image\/jpeg','image\/png','image\/webp'\)/);
    assert.match(migration, /CREATE TABLE meal\.media_intake_sources/);
    assert.match(migration, /CREATE TABLE meal\.media_processing_jobs/);
    assert.match(migration, /'malware_scan','image_cdr','ocr'/);
    assert.match(migration, /CREATE TABLE meal\.media_variant_bindings/);
    assert.match(migration, /CREATE TABLE meal\.media_variant_evidence/);
    assert.match(migration, /CREATE TABLE meal\.recognition_review_snapshots/);
    assert.match(migration, /CREATE TABLE meal\.media_reconciliation_attempts/);
    assert.match(grants, /every migration listed in database\/manifest\.json/);
    assert.match(grants, /GRANT INSERT\(id,intake_id,asset_id,slot,position\) ON meal\.media_intake_sources/);
    assert.match(grants, /GRANT INSERT\(id,position,slot,asset_id,diary_entry_id,support_message_id,avatar_user_id\)/);
    assert.doesNotMatch(grants, /GRANT DELETE ON meal\.media_/);
    assert.match(generated, /media_intakes:/);
    assert.match(generated, /inventory_source/);
    assert.match(generated, /media_processing_jobs:/);
    assert.match(generated, /recognition_review_snapshots:/);
});
