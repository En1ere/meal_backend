import assert from 'node:assert/strict';
import test from 'node:test';
import {
    diaryCreateSchema,
    diaryMediaUploadSchema,
    diaryPortionDecisionSchema,
} from '../src/modules/diary/diary.contracts.js';
import {
    aggregateNutrition,
    completeness,
    portionTransition,
    scaleNutrition,
    unknownNutrition,
} from '../src/modules/diary/diary.domain.js';

const id = '10000000-0000-4000-8000-000000000001';

void test('diary create contract requires a private source-first component and rejects unsafe quantities', () => {
    const valid = {
        eatenAt: '2026-10-07T08:30:00.000Z',
        meal: 'breakfast',
        note: null,
        components: [{ id, source: { type: 'manual', name: 'Каша' }, quantity: '250', unit: 'g' }],
        idempotencyKey: id,
    };
    assert.equal(diaryCreateSchema.safeParse(valid).success, true);
    assert.equal(diaryCreateSchema.safeParse({ ...valid, components: [] }).success, false);
    for (const quantity of ['0', '-1', '1e3', '0.000000001'])
        assert.equal(
            diaryCreateSchema.safeParse({ ...valid, components: [{ ...valid.components[0], quantity }] }).success,
            false,
        );
    assert.equal(
        diaryCreateSchema.safeParse({ ...valid, familyId: id }).success,
        false,
        'family scope cannot be injected into the private diary',
    );
});

void test('portion transition allows manual choice before due and only cancellation after timeout', () => {
    assert.deepEqual(portionTransition('pending', 'confirmed', false), {
        effective: 'pending',
        next: 'confirmed',
        method: 'manual',
    });
    assert.deepEqual(portionTransition('pending', 'refused', false), {
        effective: 'pending',
        next: 'refused',
        method: 'refused',
    });
    assert.deepEqual(portionTransition('pending', 'cancelled', true), {
        effective: 'auto_confirmed',
        next: 'cancelled',
        method: 'cancelled',
    });
    assert.equal(portionTransition('confirmed', 'cancelled', false), null);
    assert.equal(portionTransition('refused', 'confirmed', false), null);
    assert.equal(portionTransition('cancelled', 'confirmed', false), null);
});

void test('portion decisions and fail-closed media metadata are strict contracts', () => {
    assert.equal(
        diaryPortionDecisionSchema.safeParse({
            decision: 'confirmed',
            expectedVersion: 1,
            idempotencyKey: id,
        }).success,
        true,
    );
    assert.equal(
        diaryPortionDecisionSchema.safeParse({
            decision: 'confirmed',
            expectedVersion: 1,
            idempotencyKey: id,
            scope: 'family',
        }).success,
        false,
        'private diary decisions cannot inject a family scope',
    );
    assert.equal(
        diaryMediaUploadSchema.safeParse({
            fileName: 'meal.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 10 * 1024 * 1024,
            idempotencyKey: id,
        }).success,
        true,
    );
    assert.equal(
        diaryMediaUploadSchema.safeParse({
            fileName: 'meal.svg',
            mimeType: 'image/svg+xml',
            sizeBytes: 100,
            idempotencyKey: id,
        }).success,
        false,
    );
});

void test('nutrition is scaled with fixed decimals and missing values remain unknown', () => {
    const nutrition = scaleNutrition({ kcal: '120', protein: '3.5', fat: null, carbs: '20' }, '50', '100');
    assert.deepEqual(nutrition, {
        energyKcal: '60',
        proteinG: '1.75',
        fatG: null,
        carbohydrateG: '10',
        fiberG: null,
    });
    assert.equal(completeness(nutrition), 'partial');
    assert.equal(completeness(unknownNutrition()), 'unknown');
});

void test('day aggregate never turns an unknown nutrient into zero', () => {
    const total = aggregateNutrition([
        { nutrition: { energyKcal: '100', proteinG: '4', fatG: '3', carbohydrateG: '15', fiberG: '2' } },
        { nutrition: { energyKcal: null, proteinG: '2', fatG: '1', carbohydrateG: '5', fiberG: null } },
    ]);
    assert.deepEqual(total, {
        energyKcal: null,
        proteinG: '6',
        fatG: '4',
        carbohydrateG: '20',
        fiberG: null,
    });
    assert.equal(completeness(total), 'partial');
});
