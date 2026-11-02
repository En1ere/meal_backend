import {
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import { encryptMediaStream, decryptMediaStream, encryptedMediaHeaderBytes } from './media-encryption.js';
import { MediaMimeVerifier } from './media-mime.js';
import { MEDIA_OBJECT_STORE, MediaObjectStoreError, type MediaObjectStore } from './media-object-store.js';
import {
    mediaReservationResultSchema,
    type MediaReservationRequest,
    type MediaStorageState,
} from './media-storage.contracts.js';
import { mediaPurposePolicy } from './media-storage.policy.js';
import { MediaStorageTokenSigner, type MediaStorageTokenPayload } from './media-storage.token.js';

const uploadTtlMs = 15 * 60_000;
const downloadTtlMs = 5 * 60_000;
type ReservationRow = {
    assetId: string;
    uploaderId: string;
    purpose: MediaReservationRequest['purpose'];
    mimeType: string;
    sizeBytes: string;
    state: MediaStorageState;
    checksum: string | null;
    failureCode: string | null;
    objectKey: string;
    requestHash: string;
    accessKeyId: string;
    tokenNonce: string;
    expiresAt: Date;
    version: string;
};

@Injectable()
export class MediaStorageService {
    private readonly signer: MediaStorageTokenSigner | null;
    private readonly encryptionKey: Buffer | null;
    constructor(
        private readonly database: DatabaseService,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
        @Inject(MEDIA_OBJECT_STORE) private readonly objects: MediaObjectStore,
    ) {
        this.signer =
            config.MEDIA_STORAGE_ENABLED && config.MEDIA_STORAGE_SIGNING_KEY && config.MEDIA_STORAGE_ACCESS_KEY_ID
                ? new MediaStorageTokenSigner(config.MEDIA_STORAGE_SIGNING_KEY, config.MEDIA_STORAGE_ACCESS_KEY_ID)
                : null;
        this.encryptionKey = config.MEDIA_STORAGE_ENCRYPTION_KEY
            ? Buffer.from(config.MEDIA_STORAGE_ENCRYPTION_KEY, 'base64')
            : null;
    }
    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    private runtime() {
        if (
            !this.config.MEDIA_STORAGE_ENABLED ||
            !this.signer ||
            !this.encryptionKey ||
            !this.objects.status().configured
        )
            throw new ServiceUnavailableException('Media storage provider is not available');
        return { signer: this.signer, key: this.encryptionKey };
    }
    private requestHash(input: MediaReservationRequest): string {
        return createHash('sha256')
            .update(
                JSON.stringify([input.purpose, input.fileName, input.mimeType, input.sizeBytes, input.idempotencyKey]),
            )
            .digest('hex');
    }
    private verifyToken(token: string, action: MediaStorageTokenPayload['action']): MediaStorageTokenPayload {
        try {
            return this.runtime().signer.verify(token, action);
        } catch (error) {
            if (error instanceof ServiceUnavailableException) throw error;
            throw new UnauthorizedException();
        }
    }
    private upload(assetId: string, userId: string, nonce: string, expiresAt: Date) {
        const token = this.runtime().signer.sign({
            action: 'upload',
            assetId,
            userId,
            nonce,
            expiresAt: expiresAt.getTime(),
        });
        return {
            method: 'PUT' as const,
            uploadUrl: `${this.config.MEDIA_STORAGE_PUBLIC_ORIGIN}/api/v1/media/assets/${assetId}/content`,
            expiresAt: expiresAt.toISOString(),
            fieldName: 'file' as const,
            requiredHeaders: [{ name: 'X-Media-Upload-Token', value: token }],
        };
    }
    private result(row: ReservationRow, upload: ReturnType<MediaStorageService['upload']> | null = null) {
        return mediaReservationResultSchema.parse({
            asset: {
                assetId: row.assetId,
                purpose: row.purpose,
                state: row.state,
                mimeType: row.mimeType,
                sizeBytes: Number(row.sizeBytes),
                checksum: row.checksum,
                failureCode: row.failureCode,
                publicationAllowed: false,
                downloadAllowed: row.state === 'ready',
                upload,
            },
        });
    }
    private async assertActive(
        userId: string,
        executor?: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    ): Promise<void> {
        const db = executor ?? (await this.db());
        const access = await sql<{ allowed: boolean }>`select exists(
          select 1 from meal.users u where u.id=${userId}::uuid and u.status='active' and u.archived_at is null
          and not exists(select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account'
            and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))
        ) allowed`.execute(db);
        if (!access.rows[0]?.allowed) throw new ForbiddenException();
    }
    async reserve(userId: string, input: MediaReservationRequest) {
        this.runtime();
        const policy = mediaPurposePolicy(input.purpose, input.mimeType, input.sizeBytes);
        if (!policy.userReservable) throw new ForbiddenException('Это назначение доступно только внутреннему процессу');
        await this.assertActive(userId);
        const hash = this.requestHash(input);
        const row = await this.database.transaction(async (tx) => {
            await sql`select pg_advisory_xact_lock(hashtextextended(${`media:${userId}:${input.idempotencyKey}`},0))`.execute(
                tx,
            );
            await sql`update meal.media_upload_reservations set state='expired',updated_at=now(),version=version+1
              where uploader_id=${userId}::uuid and idempotency_key=${input.idempotencyKey}::uuid
                and state='reserved' and expires_at<=now()`.execute(tx);
            const replay = await sql<ReservationRow>`select r.asset_id "assetId",r.uploader_id "uploaderId",r.purpose,
              r.declared_mime "mimeType",r.declared_size::text "sizeBytes",r.state,a.checksum,r.failure_code "failureCode",
              r.object_key "objectKey",r.request_hash "requestHash",r.access_key_id "accessKeyId",r.token_nonce "tokenNonce",
              r.expires_at "expiresAt",r.version::text version from meal.media_upload_reservations r left join meal.media_assets a on a.id=r.asset_id
              where r.uploader_id=${userId}::uuid and r.idempotency_key=${input.idempotencyKey}::uuid limit 1`.execute(
                tx,
            );
            if (replay.rows[0]) {
                if (replay.rows[0].requestHash !== hash) throw new ConflictException('Idempotency key reused');
                return replay.rows[0];
            }
            const assetId = randomUUID();
            const nonce = randomBytes(16).toString('base64url');
            const expiresAt = new Date(Date.now() + uploadTtlMs);
            const prefix = this.config.MEDIA_STORAGE_PREFIX!;
            const objectKey = `${prefix}/quarantine/${input.purpose}/${assetId}`;
            await sql`insert into meal.media_upload_reservations(asset_id,uploader_id,purpose,file_name,declared_mime,
              declared_size,retention_class,object_key,state,request_hash,idempotency_key,access_key_id,token_nonce,expires_at)
              values(${assetId}::uuid,${userId}::uuid,${input.purpose},${input.fileName},${input.mimeType},${input.sizeBytes},
              ${policy.retentionClass},${objectKey},'reserved',${hash},${input.idempotencyKey}::uuid,
              ${this.config.MEDIA_STORAGE_ACCESS_KEY_ID!},${nonce},${expiresAt})`.execute(tx);
            return {
                assetId,
                uploaderId: userId,
                purpose: input.purpose,
                mimeType: input.mimeType,
                sizeBytes: String(input.sizeBytes),
                state: 'reserved' as const,
                checksum: null,
                failureCode: null,
                objectKey,
                requestHash: hash,
                accessKeyId: this.config.MEDIA_STORAGE_ACCESS_KEY_ID!,
                tokenNonce: nonce,
                expiresAt,
                version: '1',
            };
        });
        const upload =
            row.state === 'reserved' && row.expiresAt.getTime() > Date.now()
                ? this.upload(row.assetId, userId, row.tokenNonce, row.expiresAt)
                : null;
        return this.result(row, upload);
    }
    private async owned(assetId: string, userId: string): Promise<ReservationRow> {
        await this.db();
        return this.database.transaction(async (tx) => {
            await sql`update meal.media_upload_reservations set state='expired',updated_at=now(),version=version+1
              where asset_id=${assetId}::uuid and uploader_id=${userId}::uuid and state='reserved'
                and expires_at<=now()`.execute(tx);
            const result = await sql<ReservationRow>`select r.asset_id "assetId",r.uploader_id "uploaderId",r.purpose,
              r.declared_mime "mimeType",r.declared_size::text "sizeBytes",coalesce(a.status,r.state) state,a.checksum,
              r.failure_code "failureCode",r.object_key "objectKey",r.request_hash "requestHash",r.access_key_id "accessKeyId",
              r.token_nonce "tokenNonce",r.expires_at "expiresAt",r.version::text version from meal.media_upload_reservations r
              left join meal.media_assets a on a.id=r.asset_id where r.asset_id=${assetId}::uuid
                and r.uploader_id=${userId}::uuid limit 1`.execute(tx);
            if (!result.rows[0]) throw new NotFoundException();
            return result.rows[0];
        });
    }
    async status(assetId: string, userId: string) {
        const row = await this.owned(assetId, userId);
        return this.result(row, null);
    }
    private async claimUpload(row: ReservationRow, userId: string): Promise<void> {
        await this.database.transaction(async (tx) => {
            await this.assertActive(userId, tx);
            const claimed = await sql<{ version: string }>`update meal.media_upload_reservations
              set state='uploading',failure_code=null,updated_at=now(),version=version+1
              where asset_id=${row.assetId}::uuid and uploader_id=${userId}::uuid and state='reserved'
                and version=${row.version}::bigint and expires_at>now()
              returning version::text version`.execute(tx);
            if (!claimed.rows[0]) throw new ConflictException('Upload reservation was already claimed');
        });
    }
    private async hasBinding(assetId: string): Promise<boolean> {
        const db = await this.db();
        const result = await sql<{ exists: boolean }>`select exists(
          select 1 from meal.media_asset_bindings where asset_id=${assetId}::uuid
        ) exists`.execute(db);
        return result.rows[0]?.exists === true;
    }
    private async markUpload(assetId: string, state: 'failed' | 'uploading', failureCode: string): Promise<void> {
        await this.database.transaction(async (tx) => {
            await sql`update meal.media_upload_reservations set state=${state},failure_code=${failureCode},
              updated_at=now(),version=version+1 where asset_id=${assetId}::uuid and state='uploading'`.execute(tx);
        });
    }
    async complete(
        assetId: string,
        userId: string,
        token: string,
        file: Readable,
        mime: string,
        isTruncated: () => boolean,
    ) {
        const { key } = this.runtime();
        const payload = this.verifyToken(token, 'upload');
        if (payload.assetId !== assetId || payload.userId !== userId) throw new UnauthorizedException();
        const row = await this.owned(assetId, userId);
        if (row.tokenNonce !== payload.nonce || row.accessKeyId !== payload.accessKeyId)
            throw new UnauthorizedException();
        if (row.state !== 'reserved' || row.expiresAt.getTime() <= Date.now())
            throw new ConflictException('Upload reservation is not active');
        if (mime !== row.mimeType) throw new ConflictException('Upload metadata mismatch');
        await this.claimUpload(row, userId);
        try {
            await this.assertActive(userId);
        } catch (error) {
            try {
                if (!(await this.hasBinding(assetId))) await this.markUpload(assetId, 'failed', 'access_revoked');
            } catch {
                // Preserve the authorization failure; no object write has started.
            }
            throw error;
        }
        const nonce = randomBytes(12);
        const context = { assetId, purpose: row.purpose, keyVersion: this.config.MEDIA_STORAGE_KEY_VERSION! };
        const encrypted = encryptMediaStream(
            file,
            key,
            nonce,
            Number(row.sizeBytes),
            context,
            new MediaMimeVerifier(row.mimeType),
        );
        const abort = new AbortController();
        let putStarted = false;
        try {
            putStarted = true;
            const put = this.objects.put({
                location: 'quarantine',
                objectKey: row.objectKey,
                body: encrypted.body,
                contentLength: Number(row.sizeBytes) + encryptedMediaHeaderBytes,
                contentType: 'application/octet-stream',
                metadata: { assetId, purpose: row.purpose, keyVersion: String(this.config.MEDIA_STORAGE_KEY_VERSION) },
                signal: abort.signal,
            });
            let completed;
            try {
                [, completed] = await Promise.all([put, encrypted.completion]);
            } catch (error) {
                abort.abort();
                encrypted.cancel(error instanceof Error ? error : new Error('Media upload cancelled'));
                await Promise.allSettled([put, encrypted.completion]);
                throw error;
            }
            if (isTruncated() || completed.sizeBytes !== Number(row.sizeBytes))
                throw new ConflictException('Upload size mismatch');
            await this.database.transaction(async (tx) => {
                await sql`insert into meal.media_assets(id,object_key,mime,size_bytes,checksum,status,retention_class,uploader_id)
                  select asset_id,object_key,declared_mime,declared_size,${completed.checksum},'quarantined',retention_class,uploader_id
                  from meal.media_upload_reservations where asset_id=${assetId}::uuid`.execute(tx);
                await sql`insert into meal.media_asset_bindings(asset_id,purpose,storage_provider,key_reference,key_version,
                  algorithm,nonce,authentication_tag) values(${assetId}::uuid,${row.purpose},'s3-compatible',
                  ${`app-media-v${this.config.MEDIA_STORAGE_KEY_VERSION}`},${this.config.MEDIA_STORAGE_KEY_VERSION!},
                  'aes-256-gcm',${completed.nonce},${completed.authenticationTag})`.execute(tx);
                await sql`insert into meal.media_processing_runs(id,kind,status,provider,policy_version,result,asset_id)
                  values(${randomUUID()}::uuid,'malware_scan','pending',null,'scanner-required-v1',
                  ${JSON.stringify({ publicationAllowed: false })}::jsonb,${assetId}::uuid)`.execute(tx);
                await sql`update meal.media_upload_reservations set state='quarantined',completed_at=now(),updated_at=now(),
                  version=version+1 where asset_id=${assetId}::uuid and state='uploading'`.execute(tx);
            });
        } catch (error) {
            try {
                const readback = await this.owned(assetId, userId);
                if (readback.state === 'quarantined') return this.result(readback, null);
                const confirmedAbsent =
                    !putStarted || (error instanceof MediaObjectStoreError && error.outcome === 'not_committed');
                if (confirmedAbsent && !(await this.hasBinding(assetId)))
                    await this.markUpload(assetId, 'failed', 'upload_failed');
                else await this.markUpload(assetId, 'uploading', 'reconciliation_required');
            } catch {
                // Unknown storage/commit outcome stays uploading for later reconciliation.
            }
            throw error;
        }
        return this.status(assetId, userId);
    }
    async createDownloadTarget(assetId: string, userId: string) {
        const row = await this.owned(assetId, userId);
        await this.assertActive(userId);
        if (row.state !== 'ready') throw new ConflictException('Media is not ready');
        const expiresAt = new Date(Date.now() + downloadTtlMs);
        const token = this.runtime().signer.sign({
            action: 'download',
            assetId,
            userId,
            nonce: row.tokenNonce,
            expiresAt: expiresAt.getTime(),
        });
        return {
            assetId,
            target: {
                method: 'GET' as const,
                downloadUrl: `${this.config.MEDIA_STORAGE_PUBLIC_ORIGIN}/api/v1/media/assets/${assetId}/content`,
                expiresAt: expiresAt.toISOString(),
                requiredHeaders: [{ name: 'X-Media-Download-Token', value: token }],
            },
        };
    }
    async download(assetId: string, userId: string, token: string) {
        const payload = this.verifyToken(token, 'download');
        if (payload.assetId !== assetId || payload.userId !== userId) throw new UnauthorizedException();
        const row = await this.owned(assetId, userId);
        if (row.state !== 'ready' || row.tokenNonce !== payload.nonce)
            throw new ConflictException('Media is not ready');
        await this.assertActive(userId);
        const db = await this.db();
        const binding = await sql<{
            keyVersion: number;
            purpose: string;
            nonce: string;
            authenticationTag: string;
        }>`select key_version "keyVersion",purpose,
          nonce,authentication_tag "authenticationTag" from meal.media_asset_bindings where asset_id=${assetId}::uuid limit 1`.execute(
            db,
        );
        if (!binding.rows[0] || binding.rows[0].keyVersion !== this.config.MEDIA_STORAGE_KEY_VERSION)
            throw new ServiceUnavailableException('Media key version is unavailable');
        const stored = await this.objects.read('ready', row.objectKey);
        const decrypted = decryptMediaStream(
            stored.body,
            this.encryptionKey!,
            Buffer.from(binding.rows[0].nonce, 'base64url'),
            Buffer.from(binding.rows[0].authenticationTag, 'base64url'),
            { assetId, purpose: binding.rows[0].purpose, keyVersion: binding.rows[0].keyVersion },
            row.checksum!,
        );
        return {
            body: decrypted.body,
            completion: decrypted.completion,
            mimeType: row.mimeType,
            sizeBytes: Number(row.sizeBytes),
        };
    }
}
