import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
    Kysely,
    PostgresAdapter,
    PostgresQueryCompiler,
    type CompiledQuery,
    type DatabaseConnection,
    type DatabaseIntrospector,
    type Dialect,
    type Driver,
    type QueryResult,
} from 'kysely';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../src/infrastructure/database/schema.generated.js';
import {
    MediaObjectPutRequest,
    MediaObjectReadResult,
    MediaObjectStore,
    MediaObjectLocation,
    MediaObjectStoreError,
    MediaStorageService,
    MediaStorageTokenSigner,
} from '../src/modules/media-storage/public.js';
import { readConfig } from '../src/app/config.js';

const assetId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const otherUserId = '00000000-0000-4000-8000-000000000003';
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]);

type State = 'reserved' | 'uploading' | 'quarantined' | 'failed';
type Query = Readonly<{ sql: string; parameters: readonly unknown[] }>;

class FakeMediaDatabase {
    state: State = 'reserved';
    version = 1;
    failureCode: string | null = null;
    checksum: string | null = null;
    binding = false;
    allowed = [true, true];
    commitUnknown = false;
    private commitPrepared = false;

    private readonly connection: DatabaseConnection = {
        executeQuery: <R>(query: CompiledQuery): Promise<QueryResult<R>> =>
            Promise.resolve(this.execute(query) as QueryResult<R>),
        streamQuery: async function* <R>(): AsyncIterableIterator<QueryResult<R>> {
            await Promise.resolve();
            yield { rows: [] };
        },
    };
    private readonly driver: Driver = {
        init: () => Promise.resolve(),
        acquireConnection: () => Promise.resolve(this.connection),
        beginTransaction: () => Promise.resolve(),
        commitTransaction: () => Promise.resolve(),
        rollbackTransaction: () => Promise.resolve(),
        releaseConnection: () => Promise.resolve(),
        destroy: () => Promise.resolve(),
    };
    private readonly dialect: Dialect = {
        createDriver: () => this.driver,
        createQueryCompiler: () => new PostgresQueryCompiler(),
        createAdapter: () => new PostgresAdapter(),
        createIntrospector: () => ({}) as DatabaseIntrospector,
    };
    readonly executor = new Kysely<DatabaseSchema>({ dialect: this.dialect });
    readonly service = {
        db: this.executor,
        ready: () => Promise.resolve(true),
        transaction: async <T>(run: (tx: typeof this.executor) => Promise<T>) => {
            const result = await run(this.executor);
            if (this.commitPrepared && this.commitUnknown) {
                this.commitPrepared = false;
                this.commitUnknown = false;
                throw new Error('COMMIT outcome unknown');
            }
            this.commitPrepared = false;
            return result;
        },
    } as unknown as DatabaseService;

    private row() {
        return {
            assetId,
            uploaderId: userId,
            purpose: 'profile_avatar',
            mimeType: 'image/png',
            sizeBytes: String(png.length),
            state: this.state,
            checksum: this.checksum,
            failureCode: this.failureCode,
            objectKey: `meal/quarantine/profile_avatar/${assetId}`,
            requestHash: 'a'.repeat(64),
            accessKeyId: 'meal-backend',
            tokenNonce: 'A'.repeat(22),
            expiresAt: new Date(Date.now() + 60_000),
            version: String(this.version),
            intakeId: null,
            diaryEntryId: null,
            supportMessageId: null,
            avatarUserId: userId,
            targetSlot: 'avatar',
            targetPosition: 0,
        };
    }
    private execute(query: Query) {
        const normalized = query.sql.replace(/\s+/g, ' ').trim();
        if (normalized.includes('select exists( select 1 from meal.users')) {
            return { rows: [{ allowed: this.allowed.shift() ?? true }] };
        }
        if (normalized.includes('select exists( select 1 from meal.media_intakes'))
            return { rows: [{ allowed: true }] };
        if (normalized.startsWith("update meal.media_upload_reservations set state='expired'")) return { rows: [] };
        if (normalized.includes('from meal.media_upload_reservations r') && normalized.includes('r.asset_id=')) {
            return { rows: query.parameters[1] === userId ? [this.row()] : [] };
        }
        if (normalized.startsWith("update meal.media_upload_reservations set state='uploading',failure_code=null")) {
            if (this.state !== 'reserved' || Number(query.parameters[2]) !== this.version) return { rows: [] };
            this.state = 'uploading';
            this.version++;
            return { rows: [{ version: String(this.version) }] };
        }
        if (normalized.includes('select 1 from meal.media_asset_bindings')) {
            return { rows: [{ exists: this.binding }] };
        }
        if (normalized.startsWith('insert into meal.media_assets')) {
            this.checksum = String(query.parameters[0]);
            return { rows: [] };
        }
        if (normalized.startsWith('insert into meal.media_asset_bindings')) {
            this.binding = true;
            return { rows: [] };
        }
        if (normalized.startsWith('insert into meal.media_links')) return { rows: [] };
        if (normalized.startsWith('insert into meal.media_processing_jobs')) return { rows: [] };
        if (normalized.startsWith('insert into meal.media_processing_runs')) return { rows: [] };
        if (normalized.startsWith("update meal.media_upload_reservations set state='quarantined'")) {
            this.state = 'quarantined';
            this.version++;
            this.commitPrepared = true;
            return { rows: [] };
        }
        if (normalized.startsWith('update meal.media_upload_reservations set state=$1')) {
            if (this.state === 'uploading') {
                this.state = query.parameters[0] as State;
                this.failureCode = String(query.parameters[1]);
                this.version++;
            }
            return { rows: [] };
        }
        throw new Error(`Unexpected test query: ${normalized}`);
    }
}

class FakeObjectStore implements MediaObjectStore {
    puts = 0;
    deletes = 0;
    constructor(private readonly behavior: 'success' | 'unknown' | 'not_committed' | 'timeout' = 'success') {}
    status() {
        return { configured: true, provider: 'fake-s3', endpoint: 'http://fake-s3:8333' };
    }
    async put(request: MediaObjectPutRequest): Promise<void> {
        this.puts++;
        if (this.behavior === 'timeout') {
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new MediaObjectStoreError('provider timeout', 'unknown');
        }
        if (this.behavior !== 'success') throw new MediaObjectStoreError('provider outcome', this.behavior);
        for await (const chunk of request.body) {
            void chunk;
            if (request.signal.aborted) throw new MediaObjectStoreError('aborted', 'unknown');
        }
    }
    read(location: MediaObjectLocation, objectKey: string): Promise<MediaObjectReadResult> {
        void location;
        void objectKey;
        throw new Error('not used');
    }
    delete(location: MediaObjectLocation, objectKey: string): Promise<void> {
        void location;
        void objectKey;
        this.deletes++;
        return Promise.resolve();
    }
}

const fixture = (database = new FakeMediaDatabase(), objects = new FakeObjectStore()) => {
    const signingKey = randomBytes(32).toString('base64');
    const config = readConfig({
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
        MEDIA_STORAGE_SIGNING_KEY: signingKey,
        MEDIA_STORAGE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        MEDIA_STORAGE_KEY_VERSION: '1',
    });
    const service = new MediaStorageService(database.service, config, objects);
    const signer = new MediaStorageTokenSigner(signingKey, 'meal-backend');
    const tokenFor = (actor: string) =>
        signer.sign({
            action: 'upload',
            assetId,
            userId: actor,
            nonce: 'A'.repeat(22),
            expiresAt: Date.now() + 60_000,
        });
    const complete = (actor = userId, source: Readable = Readable.from([png])) =>
        service.complete(assetId, actor, tokenFor(actor), source, 'image/png', () => false);
    return { service, database, objects, complete, tokenFor };
};

void test('upload claim is one atomic reserved/version CAS and concurrent replay never writes a second object', async () => {
    const setup = fixture();
    const results = await Promise.allSettled([setup.complete(), setup.complete()]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(setup.objects.puts, 1);
    assert.equal(setup.database.state, 'quarantined');
});

void test('unknown provider outcome remains uploading for reconciliation and never deletes', async () => {
    const database = new FakeMediaDatabase();
    const objects = new FakeObjectStore('unknown');
    const setup = fixture(database, objects);
    await assert.rejects(setup.complete(), MediaObjectStoreError);
    assert.equal(database.state, 'uploading');
    assert.equal(database.failureCode, 'reconciliation_required');
    assert.equal(objects.deletes, 0);
});

void test('provider timeout remains uploading for reconciliation and never deletes', async () => {
    const database = new FakeMediaDatabase();
    const objects = new FakeObjectStore('timeout');
    const setup = fixture(database, objects);
    await assert.rejects(setup.complete(), /provider timeout/);
    assert.equal(database.state, 'uploading');
    assert.equal(database.failureCode, 'reconciliation_required');
    assert.equal(objects.deletes, 0);
});

void test('confirmed not-committed provider failure is terminal only after binding absence readback', async () => {
    const database = new FakeMediaDatabase();
    const setup = fixture(database, new FakeObjectStore('not_committed'));
    await assert.rejects(setup.complete(), MediaObjectStoreError);
    assert.equal(database.state, 'failed');
    assert.equal(database.failureCode, 'upload_failed');
});

void test('unknown DB commit returns committed quarantine after durable readback', async () => {
    const database = new FakeMediaDatabase();
    database.commitUnknown = true;
    const setup = fixture(database);
    const result = await setup.complete();
    assert.equal(result.asset.state, 'quarantined');
    assert.equal(database.binding, true);
    assert.equal(setup.objects.deletes, 0);
});

void test('sanction activated after reservation is rechecked before object PUT', async () => {
    const database = new FakeMediaDatabase();
    database.allowed = [true, false];
    const setup = fixture(database);
    await assert.rejects(setup.complete(), ForbiddenException);
    assert.equal(setup.objects.puts, 0);
    assert.equal(database.state, 'failed');
    assert.equal(database.failureCode, 'access_revoked');
});

void test('wrong owner and malformed token fail before claim or provider effects', async () => {
    const setup = fixture();
    await assert.rejects(setup.complete(otherUserId), NotFoundException);
    await assert.rejects(
        setup.service.complete(assetId, userId, 'malformed', Readable.from([png]), 'image/png', () => false),
        UnauthorizedException,
    );
    assert.equal(setup.objects.puts, 0);
    assert.equal(setup.database.state, 'reserved');
});

void test('client stream disconnect keeps unknown outcome reconcilable and cancels coordinated pipeline', async () => {
    const setup = fixture();
    const disconnected = new Readable({
        read() {
            this.push(png.subarray(0, 16));
            this.destroy(new Error('client disconnected'));
        },
    });
    await assert.rejects(setup.complete(userId, disconnected), /client disconnected/);
    assert.equal(setup.database.state, 'uploading');
    assert.equal(setup.database.failureCode, 'reconciliation_required');
    assert.equal(setup.objects.deletes, 0);
});
