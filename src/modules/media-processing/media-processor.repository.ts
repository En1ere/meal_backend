import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { imageCdrPolicy, type ImageCdrResult } from './image-cdr.js';

export type ImageCdrJob = Readonly<{
    id: string;
    assetId: string;
    sourceChecksum: string;
    attemptCount: number;
    leaseToken: string;
    objectKey: string;
    mime: string;
    sizeBytes: number;
    purpose: string;
    keyVersion: number;
    nonce: string;
    authenticationTag: string;
}>;

export class MediaProcessorFenceLost extends Error {
    constructor() {
        super('media_processor_fence_lost');
    }
}

export class MediaProcessorRepository {
    constructor(
        private readonly db: Kysely<DatabaseSchema>,
        private readonly ownerId: string,
        private readonly leaseSeconds: number,
        private readonly maxAttempts: number,
    ) {}

    async recoverExpired(): Promise<number> {
        return this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                const result = await sql`
          update meal.media_processing_jobs
          set status='manual_review',lease_owner=null,lease_token=null,lease_until=null,
              result_code='reconciliation_required',result_evidence=${JSON.stringify({ reason: 'lease_expired' })}::jsonb,
              completed_at=now(),updated_at=now(),version=version+1
          where kind='image_cdr' and policy_version=${imageCdrPolicy.version} and status='processing'
            and lease_until<now()
        `.execute(tx);
                return Number(result.numAffectedRows ?? 0);
            });
    }

    async claim(): Promise<ImageCdrJob | null> {
        return this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                const leaseToken = randomUUID();
                const claimed = await sql<{
                    id: string;
                    assetId: string;
                    sourceChecksum: string;
                    attemptCount: number;
                }>`
              with candidate as (
                select id from meal.media_processing_jobs
                where kind='image_cdr' and policy_version=${imageCdrPolicy.version}
                  and status='queued' and available_at<=now()
                order by available_at,id for update skip locked limit 1
              )
              update meal.media_processing_jobs j
              set status='processing',attempt_count=attempt_count+1,lease_owner=${this.ownerId},
                  lease_token=${leaseToken}::uuid,lease_until=now()+(${this.leaseSeconds}*interval '1 second'),
                  result_code=null,result_evidence=null,updated_at=now(),version=version+1
              from candidate where j.id=candidate.id
              returning j.id,j.asset_id "assetId",j.source_checksum "sourceChecksum",j.attempt_count "attemptCount"
            `.execute(tx);
                const job = claimed.rows[0];
                if (!job) return null;
                const source = await sql<{
                    objectKey: string;
                    mime: string;
                    sizeBytes: string;
                    purpose: string;
                    keyVersion: number;
                    nonce: string;
                    authenticationTag: string;
                }>`
              select a.object_key "objectKey",a.mime,a.size_bytes::text "sizeBytes",b.purpose,
                b.key_version "keyVersion",b.nonce,b.authentication_tag "authenticationTag"
              from meal.media_assets a join meal.media_asset_bindings b on b.asset_id=a.id
              where a.id=${job.assetId}::uuid and a.checksum=${job.sourceChecksum}
                and a.status in ('quarantined','scanning')
            `.execute(tx);
                const evidence = source.rows[0];
                if (!evidence) {
                    await sql`update meal.media_processing_jobs set status='failed',lease_owner=null,lease_token=null,
                  lease_until=null,result_code='source_evidence_invalid',result_evidence=null,completed_at=now(),
                  updated_at=now(),version=version+1 where id=${job.id}::uuid and lease_token=${leaseToken}::uuid`.execute(
                        tx,
                    );
                    return null;
                }
                return {
                    ...job,
                    leaseToken,
                    ...evidence,
                    sizeBytes: Number(evidence.sizeBytes),
                };
            });
    }

    async complete(
        job: ImageCdrJob,
        variant: Readonly<{
            id: string;
            objectKey: string;
            result: ImageCdrResult;
            keyReference: string;
            keyVersion: number;
            nonce: string;
            authenticationTag: string;
        }>,
    ): Promise<void> {
        await this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                const fenced = await sql<{ id: string }>`
              update meal.media_processing_jobs set status='succeeded',lease_owner=null,lease_token=null,lease_until=null,
                result_code='cdr_reencoded',result_evidence=${JSON.stringify({
                    variantId: variant.id,
                    checksum: variant.result.checksum,
                    policyVersion: variant.result.policyVersion,
                    safetyEvidence: variant.result.safetyEvidence,
                })}::jsonb,completed_at=now(),updated_at=now(),version=version+1
              where id=${job.id}::uuid and status='processing' and lease_owner=${this.ownerId}
                and lease_token=${job.leaseToken}::uuid
              returning id
            `.execute(tx);
                if (!fenced.rows[0]) throw new MediaProcessorFenceLost();
                await sql`insert into meal.media_variants(id,kind,object_key,mime,size_bytes,width,height,duration,asset_id)
              values(${variant.id}::uuid,'cdr_sanitized',${variant.objectKey},${variant.result.mimeType},
                ${variant.result.bytes.length},${variant.result.width},${variant.result.height},null,${job.assetId}::uuid)`.execute(
                    tx,
                );
                await sql`insert into meal.media_variant_bindings(variant_id,processing_job_id,source_checksum,
              variant_checksum,key_reference,key_version,algorithm,nonce,authentication_tag,transformation_policy)
              values(${variant.id}::uuid,${job.id}::uuid,${job.sourceChecksum},${variant.result.checksum},
                ${variant.keyReference},${variant.keyVersion},'aes-256-gcm',${variant.nonce},
                ${variant.authenticationTag},${variant.result.policyVersion})`.execute(tx);
                for (const kind of ['decode', 'metadata_strip', 'sanitize', 'encode'] as const)
                    await sql`insert into meal.media_variant_evidence(id,variant_id,processing_job_id,kind,outcome,
                  policy_version,evidence) values(${randomUUID()}::uuid,${variant.id}::uuid,${job.id}::uuid,
                  ${kind},'passed',${variant.result.policyVersion},${JSON.stringify({ safetyEvidence: 'cdr_reencoded' })}::jsonb)`.execute(
                        tx,
                    );
            });
    }

    async failOrRetry(job: ImageCdrJob, code: string): Promise<void> {
        const terminal = job.attemptCount >= this.maxAttempts;
        await this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                const result = await sql<{ id: string }>`
          update meal.media_processing_jobs
          set status=${terminal ? 'failed' : 'queued'},available_at=now()+(${Math.min(60, 2 ** job.attemptCount)}*interval '1 second'),
            lease_owner=null,lease_token=null,lease_until=null,result_code=${code},result_evidence=null,
            completed_at=${terminal ? sql`now()` : null},updated_at=now(),version=version+1
          where id=${job.id}::uuid and status='processing' and lease_owner=${this.ownerId}
            and lease_token=${job.leaseToken}::uuid returning id
        `.execute(tx);
                if (!result.rows[0]) throw new MediaProcessorFenceLost();
            });
    }

    async manualReview(job: ImageCdrJob, reason: string): Promise<void> {
        await this.db
            .transaction()
            .setIsolationLevel('serializable')
            .execute(async (tx) => {
                const result = await sql<{ id: string }>`
                  update meal.media_processing_jobs
                  set status='manual_review',lease_owner=null,lease_token=null,lease_until=null,
                    result_code='reconciliation_required',result_evidence=${JSON.stringify({ reason })}::jsonb,
                    completed_at=now(),updated_at=now(),version=version+1
                  where id=${job.id}::uuid and status='processing' and lease_owner=${this.ownerId}
                    and lease_token=${job.leaseToken}::uuid returning id
                `.execute(tx);
                if (!result.rows[0]) throw new MediaProcessorFenceLost();
            });
    }
}
