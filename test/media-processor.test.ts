import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { encryptMediaStream, encryptedMediaHeaderBytes } from '../src/modules/media-storage/media-encryption.js';
import { readMediaProcessorConfig } from '../src/modules/media-processing/media-processor.config.js';
import { MediaProcessor } from '../src/modules/media-processing/media-processor.js';
import type { ImageCdrJob } from '../src/modules/media-processing/media-processor.repository.js';

void test('media processor is disabled by default and rejects unsafe runtime configuration', () => {
    const disabled = readMediaProcessorConfig({ NODE_ENV: 'production' });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.MEDIA_PROCESSOR_CONCURRENCY, 1);
    assert.throws(
        () => readMediaProcessorConfig({ NODE_ENV: 'production', MEDIA_PROCESSOR_CONCURRENCY: '2' }),
        /MEDIA_PROCESSOR_CONCURRENCY/,
    );
    assert.throws(
        () => readMediaProcessorConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://inline' }),
        /dedicated \*_FILE/,
    );
    assert.throws(
        () => readMediaProcessorConfig({ NODE_ENV: 'production', MEDIA_PROCESSOR_ENABLED: 'true' }),
        /MEDIA_PROCESSOR_DATABASE_URL_FILE/,
    );
});

void test('media processor queue uses image-only claims, skip-locked leasing, fencing and expired recovery', () => {
    const repository = readFileSync('src/modules/media-processing/media-processor.repository.ts', 'utf8');
    assert.match(repository, /kind='image_cdr'/);
    assert.match(repository, /policy_version=\$\{imageCdrPolicy\.version\}/);
    assert.match(repository, /for update skip locked limit 1/);
    assert.match(repository, /lease_token=\$\{leaseToken\}::uuid/);
    assert.match(repository, /lease_until<now\(\)/);
    assert.match(repository, /lease_token=\$\{job\.leaseToken\}::uuid/);
    assert.doesNotMatch(repository, /kind='ocr'/);
});

void test('a ready PUT error is ambiguous and moves the fenced job to manual review without retry', async () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const source = Buffer.from('bounded source bytes');
    const checksum = `sha256:${createHash('sha256').update(source).digest('hex')}`;
    const job: ImageCdrJob = {
        id: 'c9cc69e6-430f-4ef8-b6fe-335647a248d0',
        assetId: '19f15f6b-4e74-4d3e-9781-965d57aff62b',
        sourceChecksum: checksum,
        attemptCount: 1,
        leaseToken: '988f0dab-5708-426c-a404-6ab18a8e4b80',
        objectKey: 'meal/quarantine/source',
        mime: 'image/jpeg',
        sizeBytes: source.length,
        purpose: 'inventory_source',
        keyVersion: 1,
        nonce: nonce.toString('base64url'),
        authenticationTag: '',
    };
    const encrypted = encryptMediaStream(Readable.from(source), key, nonce, source.length, {
        assetId: job.assetId,
        purpose: job.purpose,
        keyVersion: 1,
    });
    const chunks: Buffer[] = [];
    for await (const value of encrypted.body) {
        if (!Buffer.isBuffer(value)) throw new Error('Expected encrypted Buffer chunk');
        chunks.push(value);
    }
    const encryption = await encrypted.completion;
    const ciphertext = Buffer.concat(chunks);
    const claimed = { ...job, authenticationTag: encryption.authenticationTag };
    let manualReviewReason: string | null = null;
    let retries = 0;
    const repository = {
        recoverExpired: () => Promise.resolve(0),
        claim: () => Promise.resolve(claimed),
        complete: () => Promise.resolve(),
        failOrRetry: () => {
            retries++;
            return Promise.resolve();
        },
        manualReview: (_job: ImageCdrJob, reason: string) => {
            manualReviewReason = reason;
            return Promise.resolve();
        },
    };
    const storage = {
        readQuarantine: () =>
            Promise.resolve({
                body: Readable.from(ciphertext),
                contentLength: source.length + encryptedMediaHeaderBytes,
            }),
        putReady: async ({ body }: { body: Readable }) => {
            for await (const _chunk of body) void _chunk;
            throw new Error('unknown provider outcome');
        },
        headReady: () => Promise.reject(new Error('must not be reached')),
    };
    const workRoot = resolve('..', '..', 'tempFiles', 'media-processor-ambiguity-test');
    await rm(workRoot, { recursive: true, force: true });
    await mkdir(workRoot, { recursive: true });
    try {
        const processor = new MediaProcessor(
            {
                keyVersion: 1,
                encryptionKey: key,
                storagePrefix: 'meal',
                MEDIA_PROCESSOR_CDR_TIMEOUT_MS: 1_000,
                MEDIA_PROCESSOR_KILL_GRACE_MS: 100,
            } as never,
            repository,
            storage,
            'unused-child-script',
            async ({ outputPath }) => {
                const bytes = Buffer.from('sanitized');
                await writeFile(outputPath, bytes, { flag: 'wx' });
                return {
                    mimeType: 'image/jpeg',
                    width: 1,
                    height: 1,
                    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                    policyVersion: 'image-cdr-v1',
                    safetyEvidence: 'cdr_reencoded',
                };
            },
            workRoot,
        );
        assert.equal(await processor.runOnce(), true);
        assert.equal(manualReviewReason, 'ambiguous_put');
        assert.equal(retries, 0);
    } finally {
        await rm(workRoot, { recursive: true, force: true });
    }
});

void test('CDR child and compose overlay preserve the isolated disabled-by-default boundary', () => {
    const runner = readFileSync('src/modules/media-processing/image-cdr-runner.ts', 'utf8');
    const compose = readFileSync('deploy/compose.media-processor.yml', 'utf8');
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    const provision = readFileSync('deploy/provision-media-processor-runtime.sh', 'utf8');
    const grants = readFileSync('database/application-grants.sql', 'utf8');
    const repository = readFileSync('src/modules/media-processing/media-processor.repository.ts', 'utf8');
    const deploy = readFileSync('deploy/deploy.sh', 'utf8');
    const restore = readFileSync('deploy/bootstrap-restore.sh', 'utf8');
    const grantStatements = grants.split(';').map((statement) => statement.replace(/\s+/g, ' ').trim());
    assert.match(runner, /spawn\(\s*process\.execPath/);
    assert.match(runner, /shell: false/);
    assert.match(runner, /child\.kill\('SIGTERM'\)/);
    assert.match(runner, /child\.kill\('SIGKILL'\)/);
    assert.match(compose, /profiles: \[media-processor\]/);
    assert.match(compose, /MEDIA_PROCESSOR_ENABLED: \$\{MEDIA_PROCESSOR_ENABLED:-false\}/);
    assert.match(compose, /MEDIA_PROCESSOR_CONCURRENCY: '1'/);
    assert.match(compose, /read_only: true/);
    assert.match(compose, /cap_drop: \[ALL\]/);
    assert.match(compose, /no-new-privileges:true/);
    assert.match(compose, /pids_limit: 64/);
    assert.match(compose, /mem_limit: 384m/);
    assert.match(compose, /mem_reservation: 256m/);
    assert.match(compose, /cpus: 0\.75/);
    assert.match(compose, /networks: \[meal-db, meal-media\]/);
    assert.doesNotMatch(compose, /ports:/);
    assert.doesNotMatch(compose, /meal-egress/);
    assert.match(compose, /MEDIA_PROCESSOR_DATABASE_URL_FILE: \/run\/secrets\/media_processor_database_url/);
    assert.match(dockerfile, /scripts\/run-media-processor\.mjs/);
    assert.match(dockerfile, /scripts\/run-image-cdr-child\.mjs/);
    assert.match(provision, /meal_media_worker nologin noinherit/);
    assert.match(provision, /meal_media_runtime login noinherit/);
    assert.match(provision, /docker exec -i --user postgres/);
    assert.match(provision, /role%%3Dmeal_media_worker/);
    assert.match(provision, /granted\.rolname in \('meal_app','meal_mail_worker'\)/);
    assert.match(grants, /GRANT USAGE ON SCHEMA meal TO meal_media_worker/);
    assert.doesNotMatch(grants, /DO \$\$[\s\S]*CREATE ROLE meal_media_worker/);
    assert.equal(
        grantStatements.some(
            (statement) =>
                statement.startsWith('GRANT UPDATE(') &&
                statement.includes('ON meal.media_processing_jobs TO meal_app'),
        ),
        false,
    );
    assert.doesNotMatch(
        grants,
        /GRANT INSERT ON meal\.media_variants,meal\.media_variant_bindings,meal\.media_variant_evidence TO meal_app/,
    );
    assert.match(grants, /GRANT SELECT ON meal\.media_assets,meal\.media_asset_bindings,meal\.media_intake_sources/);
    assert.match(
        grants,
        /GRANT INSERT ON meal\.media_variants,meal\.media_variant_bindings,meal\.media_variant_evidence/,
    );
    const processor = readFileSync('src/modules/media-processing/media-processor.ts', 'utf8');
    const storage = readFileSync('src/modules/media-processing/media-processor.storage.ts', 'utf8');
    assert.match(processor, /MediaProcessorAmbiguousSideEffect/);
    assert.match(processor, /repository\.manualReview\(job/);
    assert.match(processor, /storage\.headReady\(objectKey\)/);
    assert.match(processor, /readback\.contentLength !== encryptedLength/);
    assert.match(storage, /new HeadObjectCommand/);
    assert.match(repository, /status='manual_review'/);
    assert.match(repository, /result_code='reconciliation_required'/);
    assert.match(deploy, /create role meal_media_worker nologin noinherit/);
    assert.match(restore, /create role meal_media_worker nologin noinherit/);
});
