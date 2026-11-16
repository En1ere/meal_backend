import { z } from 'zod';
import { aiV2PersonalRecommendationReasonCodeSchema } from './ai-v2.contracts.js';

export const AI_V2_WEEKLY_RECOMMENDATION_LIMIT = 7 as const;

export const aiV2WeeklyRecommendationCandidateSchema = z.strictObject({
    recipeId: z.uuid(),
    recipeVersion: z.number().int().positive(),
    revisionId: z.uuid(),
    revisionVersion: z.number().int().positive(),
    publicationId: z.uuid(),
    publicationVersion: z.number().int().positive(),
    category: z.string().trim().min(1).max(120).nullable(),
    tags: z.array(z.string().trim().min(1).max(80)).max(30),
    durationMinutes: z.number().int().nonnegative().nullable(),
    rating: z.number().min(1).max(5).nullable(),
    ratingCount: z.number().int().nonnegative(),
    requiredCount: z.number().int().nonnegative(),
    presentCount: z.number().int().nonnegative(),
    expiringCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    daysSinceCooked: z.number().int().nonnegative().nullable(),
});

export type AiV2WeeklyRecommendationCandidate = z.infer<typeof aiV2WeeklyRecommendationCandidateSchema>;
export type AiV2WeeklyRecommendationPreferences = { diets: string[]; goals: string[] };

export function assertWeeklyRecommendationMonday(value: string) {
    const date = new Date(`${z.iso.date().parse(value)}T12:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.getUTCDay() !== 1) throw new Error('weekStartsOn must be a Monday');
    return value;
}

type Ranked = {
    candidate: AiV2WeeklyRecommendationCandidate;
    score: number;
    reasonCodes: Array<z.infer<typeof aiV2PersonalRecommendationReasonCodeSchema>>;
};

function rankCandidate(
    candidate: AiV2WeeklyRecommendationCandidate,
    preferences: AiV2WeeklyRecommendationPreferences,
): Ranked {
    const reasons: Array<{ code: Ranked['reasonCodes'][number]; value: number }> = [];
    const availability = candidate.requiredCount === 0 ? 1 : candidate.presentCount / candidate.requiredCount;
    if (availability > 0) reasons.push({ code: 'inventory_match', value: 40 * Math.min(1, availability) });
    const expiring = 15 * Math.min(1, candidate.expiringCount / Math.max(1, candidate.requiredCount));
    if (expiring > 0) reasons.push({ code: 'expiring_ingredients', value: expiring });
    const dietMatches = preferences.diets.filter((diet) => candidate.tags.includes(diet)).length;
    const diet = preferences.diets.length === 0 ? 0 : 20 * Math.min(1, dietMatches / preferences.diets.length);
    if (diet > 0) reasons.push({ code: 'diet_match', value: diet });
    if (preferences.goals.includes('quick') && candidate.durationMinutes !== null && candidate.durationMinutes <= 30)
        reasons.push({ code: 'quick_goal', value: 8 });
    const quality =
        candidate.rating === null ? 0 : 10 * ((candidate.rating - 1) / 4) * Math.min(1, candidate.ratingCount / 10);
    if (quality >= 4) reasons.push({ code: 'high_rating', value: quality });
    const novelty = candidate.completedCount === 0 ? 5 : Math.min(5, Math.max(0, candidate.daysSinceCooked ?? 0) / 30);
    if (novelty >= 3) reasons.push({ code: candidate.completedCount === 0 ? 'new_recipe' : 'variety', value: novelty });
    const selected = reasons.sort((left, right) => right.value - left.value || left.code.localeCompare(right.code));
    return {
        candidate,
        score: selected.reduce((sum, reason) => sum + reason.value, 0),
        reasonCodes: (selected.length ? selected : [{ code: 'new_recipe' as const, value: 0 }])
            .slice(0, 3)
            .map((reason) => reason.code),
    };
}

export function rankWeeklyRecommendations(
    rawCandidates: readonly AiV2WeeklyRecommendationCandidate[],
    preferences: AiV2WeeklyRecommendationPreferences,
) {
    const diets = [...new Set(preferences.diets.map((value) => value.trim()).filter(Boolean))].slice(0, 20);
    const goals = [...new Set(preferences.goals.map((value) => value.trim()).filter(Boolean))].slice(0, 20);
    const eligible = rawCandidates
        .map((candidate) => aiV2WeeklyRecommendationCandidateSchema.parse(candidate))
        .filter((candidate) => diets.length === 0 || diets.some((diet) => candidate.tags.includes(diet)))
        .map((candidate) => rankCandidate(candidate, { diets, goals }))
        .sort(
            (left, right) =>
                right.score - left.score || left.candidate.recipeId.localeCompare(right.candidate.recipeId),
        );
    const selected: Ranked[] = [];
    const categories = new Map<string, number>();
    for (const item of eligible) {
        const category = item.candidate.category ?? 'unknown';
        if ((categories.get(category) ?? 0) >= 2 && eligible.length > AI_V2_WEEKLY_RECOMMENDATION_LIMIT) continue;
        selected.push(item);
        categories.set(category, (categories.get(category) ?? 0) + 1);
        if (selected.length === AI_V2_WEEKLY_RECOMMENDATION_LIMIT) break;
    }
    return selected.map((item) => ({
        recipeId: item.candidate.recipeId,
        revisionId: item.candidate.revisionId,
        reasonCodes: item.reasonCodes,
    }));
}
