import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    RECOMMENDATION_SCORING_POLICY,
    scoreRecipe,
    type RecipeCandidate,
} from '../src/modules/recommendations/recommendations.domain.js';

const candidate: RecipeCandidate = {
    id: 'recipe-1',
    category: 'dinner',
    tags: ['vegetarian'],
    durationMinutes: 25,
    rating: 5,
    ratingCount: 10,
    requiredCount: 4,
    presentCount: 4,
    expiringCount: 4,
    completedCount: 0,
    daysSinceCooked: null,
    collaborativeSupport: 20,
    collaborativeScore: 1,
};

void test('personalized-v1 scoring policy is immutable, versioned and preserves the released score', () => {
    assert.equal(RECOMMENDATION_SCORING_POLICY.algorithm, 'personalized-v1');
    assert.equal(RECOMMENDATION_SCORING_POLICY.version, 1);
    assert.equal(Object.isFrozen(RECOMMENDATION_SCORING_POLICY), true);
    assert.equal(Object.isFrozen(RECOMMENDATION_SCORING_POLICY.weights), true);
    assert.equal(Object.isFrozen(RECOMMENDATION_SCORING_POLICY.thresholds), true);

    const result = scoreRecipe(candidate, { diets: ['vegetarian'], goals: ['quick', 'less_waste'] });
    assert.equal(result.score, 100);
    assert.deepEqual(
        result.reasons.map((reason) => reason.code),
        ['inventory_match', 'diet_match', 'expiring_ingredients'],
    );
});

void test('personalized-v1 keeps the recent-repeat penalty and explanation ordering deterministic', () => {
    const result = scoreRecipe(
        {
            ...candidate,
            presentCount: 2,
            expiringCount: 0,
            completedCount: 2,
            daysSinceCooked: 3,
            collaborativeSupport: 19,
        },
        { diets: [], goals: [] },
    );
    assert.equal(result.score, 17.6);
    assert.deepEqual(
        result.reasons.map((reason) => reason.code),
        ['inventory_match', 'high_rating'],
    );
});
