import { MODULE_METADATA } from '@nestjs/common/constants.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AiCapabilityModule } from '../src/contexts/integrations/ai-capability.module.js';
import {
    AI_V2_WEEKLY_RECOMMENDATION_LIMIT,
    aiV2PersonalRecommendationResultSchema,
    assertWeeklyRecommendationMonday,
    parseAiV2PreviewRequest,
    rankWeeklyRecommendations,
    type AiV2WeeklyRecommendationCandidate,
} from '../src/modules/ai/public.js';

const candidate = (
    index: number,
    overrides: Partial<AiV2WeeklyRecommendationCandidate> = {},
): AiV2WeeklyRecommendationCandidate => ({
    recipeId: `00000000-0000-4000-8000-${String(600 + index).padStart(12, '0')}`,
    recipeVersion: 1,
    revisionId: `00000000-0000-4000-8000-${String(700 + index).padStart(12, '0')}`,
    revisionVersion: 1,
    publicationId: `00000000-0000-4000-8000-${String(800 + index).padStart(12, '0')}`,
    publicationVersion: 1,
    category: index < 4 ? 'Ужин' : `Категория ${index}`,
    tags: index === 0 ? ['vegetarian'] : [],
    durationMinutes: index === 0 ? 20 : 50,
    rating: index === 0 ? 5 : 4,
    ratingCount: 10,
    requiredCount: 4,
    presentCount: index === 0 ? 4 : 2,
    expiringCount: index === 0 ? 2 : 0,
    completedCount: index === 0 ? 0 : 1,
    daysSinceCooked: index === 0 ? null : 60,
    ...overrides,
});

void test('weekly recommendation contract is minimal and defaults to personal scope', () => {
    assert.deepEqual(
        parseAiV2PreviewRequest({
            task: 'personal_recommendation',
            mode: 'weekly',
            input: { weekStartsOn: '2026-11-16' },
        }),
        {
            task: 'personal_recommendation',
            mode: 'weekly',
            input: { weekStartsOn: '2026-11-16', inventoryScope: 'personal' },
        },
    );
    assert.throws(() =>
        parseAiV2PreviewRequest({
            task: 'personal_recommendation',
            mode: 'weekly',
            input: { weekStartsOn: '2026-11-16', prompt: 'Подбери что-нибудь' },
        }),
    );
});

void test('weekly artifact accepts only a Monday boundary', () => {
    assert.equal(assertWeeklyRecommendationMonday('2026-11-16'), '2026-11-16');
    assert.throws(() => assertWeeklyRecommendationMonday('2026-11-17'));
});

void test('backend ranking is bounded, deterministic and uses allowlisted reasons', () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(index));
    const first = rankWeeklyRecommendations(candidates, { diets: [], goals: ['quick'] });
    const second = rankWeeklyRecommendations([...candidates].reverse(), { diets: [], goals: ['quick'] });
    assert.deepEqual(first, second);
    assert.equal(first.length, AI_V2_WEEKLY_RECOMMENDATION_LIMIT);
    assert.equal(first[0]?.recipeId, candidates[0]?.recipeId);
    assert.deepEqual(first[0]?.reasonCodes, ['inventory_match', 'high_rating', 'quick_goal']);
});

void test('weekly result contains only versioned recipe references and reason codes', () => {
    const item = rankWeeklyRecommendations([candidate(0)], { diets: ['vegetarian'], goals: ['quick'] })[0]!;
    const result = aiV2PersonalRecommendationResultSchema.parse({
        schemaVersion: 'ai-result-contract-v2:personal_recommendation:weekly',
        weekStartsOn: '2026-11-16',
        inventoryScope: 'personal',
        algorithmVersion: 'weekly-backend-v1',
        items: [item],
        warningCodes: ['allergen_profile_not_applied'],
    });
    assert.deepEqual(result.items[0]?.reasonCodes, ['inventory_match', 'diet_match', 'high_rating']);
    assert.doesNotMatch(JSON.stringify(result), /title|score|prompt|provider|model|allergenMode/u);
});

void test('weekly cache is exact, owner-scoped, versioned and providerless', () => {
    const source = readFileSync(
        fileURLToPath(new URL('../../src/modules/ai/ai-personal-recommendation-internal.service.ts', import.meta.url)),
        'utf8',
    );
    assert.match(source, /pg_advisory_xact_lock/u);
    assert.match(source, /conversation\.user_id=\$\{userId\}::uuid/u);
    assert.match(source, /task\.source_snapshot_hash=\$\{sourceSnapshotHash\}/u);
    assert.match(source, /scope\.version::integer/u);
    assert.match(source, /membership\.version::integer/u);
    assert.match(source, /recipe\.version::integer/u);
    assert.match(source, /revision\.version::integer/u);
    assert.match(source, /batch.*version::integer|select id,version::integer from meal\.inventory_batches/su);
    assert.match(source, /allowsFeatureAccess/u);
    assert.match(source, /preferences->'diets'/u);
    assert.doesNotMatch(source, /preferences->'allergens'|AI_V2_PROVIDER_PORT|quota\.|ai_provider_dispatches/u);
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiCapabilityModule) ?? []) as unknown[];
    assert.equal(
        controllers.some((controller) => String(controller).includes('PersonalRecommendation')),
        false,
    );
});
