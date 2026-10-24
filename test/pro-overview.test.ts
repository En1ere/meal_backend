import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import {
    DatabaseConnection,
    DummyDriver,
    Kysely,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type CompiledQuery,
    type QueryResult,
} from 'kysely';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../src/infrastructure/database/schema.generated.js';
import type { ProOverview } from '../src/modules/pro-overview/pro-overview.contracts.js';
import { ProOverviewService, projectProOverview } from '../src/modules/pro-overview/pro-overview.service.js';

const userId = '10000000-0000-4000-8000-000000000001';
const ai: ProOverview['ai'] = {
    buckets: [],
    total: 0,
    reserved: 0,
    available: 0,
    debitOrder: ['subscription', 'transferred', 'family_reserve', 'trial', 'purchased'],
    packageOffer: {
        actions: 40 as const,
        amountMinor: 19900 as const,
        currency: 'RUB' as const,
        purchaseMode: 'unavailable' as const,
    },
};

type Row = {
    profileData: unknown;
    targetStartsOn: string | null;
    targetEndsOn: string | null;
    targets: unknown;
    diaryCount: number;
    expenseCount: number;
    historicalPro: boolean;
    historicalEndsAt: Date | null;
};

function harness(row: Row, plan: 'free' | 'pro') {
    const queries: CompiledQuery[] = [];
    class Driver extends DummyDriver {
        override async acquireConnection(): Promise<DatabaseConnection> {
            await Promise.resolve();
            return {
                async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
                    await Promise.resolve();
                    queries.push(query);
                    return { rows: [row] as R[] };
                },
                async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
                    await Promise.resolve();
                    throw new Error('Not used');
                },
            };
        }
    }
    const db = new Kysely<DatabaseSchema>({
        dialect: {
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => new Driver(),
            createIntrospector: (database) => new PostgresIntrospector(database),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
    });
    const database = { db, ready: () => Promise.resolve(true) } as unknown as DatabaseService;
    let balanceCalls = 0;
    const service = new ProOverviewService(
        database,
        {
            resolve: () => {
                if (plan === 'pro')
                    return Promise.resolve({
                        mode: 'active',
                        reason: null,
                        source: 'personal',
                        periodEndsAt: '2026-11-07T00:00:00.000Z',
                    });
                if (row.historicalPro || row.diaryCount > 0 || row.expenseCount > 0 || row.profileData !== null)
                    return Promise.resolve({
                        mode: 'read_only',
                        reason: 'pro_expired',
                        source: 'history',
                        periodEndsAt: row.historicalEndsAt?.toISOString() ?? null,
                    });
                return Promise.reject(new HttpException('Pro access required', 403));
            },
        } as never,
        {
            balance: () => {
                balanceCalls++;
                return Promise.resolve(ai);
            },
        } as never,
    );
    return { db, queries, service, balanceCalls: () => balanceCalls };
}

void test('Pro overview projects stored nutrition values without invented progress', () => {
    const result = projectProOverview(
        {
            profileData: { goal: 'maintain' },
            targetStartsOn: '2026-10-01',
            targetEndsOn: null,
            targets: { energy_kcal: 2100, protein_g: '95.5', fat_g: null },
            diaryCount: 4,
            expenseCount: 2,
        },
        { mode: 'active', reason: null, source: 'personal', periodEndsAt: '2026-11-07T00:00:00.000Z' },
        ai,
    );
    assert.equal(result.goal, 'maintain');
    assert.equal(result.targets?.energyKcal, '2100');
    assert.equal(result.targets?.proteinG, '95.5');
    assert.deepEqual(result.missingFields, ['fat_g', 'carbohydrate_g', 'fiber_g']);
    assert.equal('progress' in result, false);
});

void test('active Pro receives a writable overview from the additive endpoint', async () => {
    const current = harness(
        {
            profileData: null,
            targetStartsOn: null,
            targetEndsOn: null,
            targets: null,
            diaryCount: 0,
            expenseCount: 0,
            historicalPro: false,
            historicalEndsAt: null,
        },
        'pro',
    );
    const result = await current.service.get(userId);
    assert.equal(result.access.mode, 'active');
    assert.equal(result.access.source, 'personal');
    assert.deepEqual(result.missingFields, [
        'nutrition_profile',
        'goal',
        'energy_kcal',
        'protein_g',
        'fat_g',
        'carbohydrate_g',
        'fiber_g',
    ]);
    assert.match(current.queries[0]!.sql, /meal\.nutrition_profiles/);
    await current.db.destroy();
});

void test('former Pro keeps read-only history while a never-Pro account is denied', async () => {
    const former = harness(
        {
            profileData: null,
            targetStartsOn: null,
            targetEndsOn: null,
            targets: null,
            diaryCount: 3,
            expenseCount: 0,
            historicalPro: true,
            historicalEndsAt: new Date('2026-09-30T00:00:00.000Z'),
        },
        'free',
    );
    const result = await former.service.get(userId);
    assert.deepEqual(result.access, {
        mode: 'read_only',
        reason: 'pro_expired',
        source: 'history',
        periodEndsAt: '2026-09-30T00:00:00.000Z',
    });
    await former.db.destroy();

    const never = harness(
        {
            profileData: null,
            targetStartsOn: null,
            targetEndsOn: null,
            targets: null,
            diaryCount: 0,
            expenseCount: 0,
            historicalPro: false,
            historicalEndsAt: null,
        },
        'free',
    );
    await assert.rejects(
        () => never.service.get(userId),
        (error: unknown) => error instanceof HttpException && error.getStatus() === 403,
    );
    assert.equal(never.balanceCalls(), 0);
    await never.db.destroy();
});
