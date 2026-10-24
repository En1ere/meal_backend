import assert from 'node:assert/strict';
import test from 'node:test';
import {
    nutritionProfileUpdateSchema,
    nutritionTargetCreateSchema,
    nutritionTargetSchema,
} from '../src/modules/nutrition/nutrition.contracts.js';
import { projectNutritionAnalytics, projectNutritionTarget } from '../src/modules/nutrition/nutrition.service.js';

const id = '10000000-0000-4000-8000-000000000001';
const access = { mode: 'active' as const, reason: null, source: 'personal' as const, periodEndsAt: null };

void test('nutrition profile and manual targets reject automatic or empty goal payloads', () => {
    assert.equal(
        nutritionProfileUpdateSchema.safeParse({ goal: 'maintain', expectedVersion: null, idempotencyKey: id }).success,
        true,
    );
    const target = {
        effectiveFrom: '2026-10-08',
        energyKcal: '2100',
        proteinG: null,
        fatG: null,
        carbohydrateG: null,
        fiberG: null,
        expectedProfileVersion: 1,
        idempotencyKey: id,
    };
    assert.equal(nutritionTargetCreateSchema.safeParse(target).success, true);
    assert.equal(nutritionTargetCreateSchema.safeParse({ ...target, energyKcal: null }).success, false);
    assert.equal(nutritionTargetCreateSchema.safeParse({ ...target, formula: 'mifflin' }).success, false);
});

void test('target projection accepts stored snake case and keeps missing nutrients null', () => {
    const target = projectNutritionTarget({
        id,
        startsOn: '2026-10-01',
        endsOn: null,
        targets: { energy_kcal: '2000', protein_g: '90', fat_g: null },
        source: 'manual',
        version: 1,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    assert.equal(nutritionTargetSchema.safeParse(target).success, true);
    assert.deepEqual(target.values, {
        energyKcal: '2000',
        proteinG: '90',
        fatG: null,
        carbohydrateG: null,
        fiberG: null,
    });
});

void test('analytics never replaces unknown nutrition with zero and only compares known pairs', () => {
    const target = nutritionTargetSchema.parse({
        id,
        effectiveFrom: '2026-10-01',
        effectiveTo: null,
        values: {
            energyKcal: '2000',
            proteinG: '100',
            fatG: '70',
            carbohydrateG: '250',
            fiberG: null,
        },
        source: 'manual',
        version: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
    });
    const analytics = projectNutritionAnalytics(
        [
            {
                date: '2026-10-08',
                nutrition: {
                    energy_kcal: '1000',
                    protein_g: '50',
                    fat_g: '20',
                    carbohydrate_g: '110',
                    fiber_g: null,
                },
            },
        ],
        [target],
        access,
        '2026-10-02',
        '2026-10-08',
    );
    assert.equal(analytics.days[0]?.nutrition.fiberG, null);
    assert.equal(analytics.days[0]?.completeness, 'partial');
    assert.equal(analytics.days[0]?.progressPercent.energyKcal, 50);
    assert.equal(analytics.days[0]?.progressPercent.fiberG, null);
});

void test('former Pro analytics is capped by the saved subscription boundary', () => {
    const analytics = projectNutritionAnalytics(
        [
            { date: '2026-10-05', nutrition: { energyKcal: '500' } },
            { date: '2026-10-07', nutrition: { energyKcal: '900' } },
        ],
        [],
        {
            mode: 'read_only',
            reason: 'pro_expired',
            source: 'history',
            periodEndsAt: '2026-10-06T20:00:00.000Z',
        },
        '2026-10-01',
        '2026-10-08',
    );
    assert.equal(analytics.period.dataThrough, '2026-10-06');
    assert.deepEqual(
        analytics.days.map((day) => day.date),
        ['2026-10-05'],
    );
});
