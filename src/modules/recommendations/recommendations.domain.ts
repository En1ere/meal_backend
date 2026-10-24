import type { RecommendationReasonCode } from './recommendations.contracts.js';

export type RecipeCandidate = {
    id: string;
    category: string | null;
    tags: string[];
    durationMinutes: number | null;
    rating: number | null;
    ratingCount: number;
    requiredCount: number;
    presentCount: number;
    expiringCount: number;
    completedCount: number;
    daysSinceCooked: number | null;
    collaborativeSupport: number;
    collaborativeScore: number;
};

export type RecommendationPreferences = { diets: string[]; goals: string[] };
export type AllergenEvidence = { complete: boolean; statuses: Array<'contains' | 'may_contain' | 'unknown'> };

export const RECOMMENDATION_SCORING_POLICY = Object.freeze({
    algorithm: 'personalized-v1' as const,
    version: 1 as const,
    weights: Object.freeze({
        inventory: 35,
        expiry: 15,
        diet: 20,
        quickGoal: 8,
        lessWasteGoal: 7,
        quality: 10,
        novelty: 5,
        collaborative: 10,
        recentRepeatPenalty: 10,
    }),
    thresholds: Object.freeze({
        quickMinutes: 30,
        qualityReasonMinimum: 4,
        noveltyReasonMinimum: 3,
        collaborativeMinimumSupport: 20,
        recentRepeatDays: 7,
    }),
});

export function evaluateRecipeSafety(mode: 'warn' | 'hide', evidence: AllergenEvidence) {
    const exclude = mode === 'hide' && evidence.statuses.includes('contains');
    const warnings: Array<{
        code: 'allergens_incomplete' | 'allergen_contains' | 'allergen_may_contain' | 'allergen_unknown';
        text: string;
    }> = [];
    if (!evidence.complete)
        warnings.push({
            code: 'allergens_incomplete',
            text: 'Данные об аллергенах неполные — проверьте состав самостоятельно',
        });
    if (mode === 'warn' && evidence.statuses.includes('contains'))
        warnings.push({ code: 'allergen_contains', text: 'Рецепт содержит выбранный аллерген' });
    if (evidence.statuses.includes('may_contain'))
        warnings.push({ code: 'allergen_may_contain', text: 'В составе возможно присутствие выбранного аллергена' });
    if (evidence.statuses.includes('unknown'))
        warnings.push({ code: 'allergen_unknown', text: 'Наличие выбранного аллергена не подтверждено' });
    return { exclude, warnings: warnings.slice(0, 3) };
}

const round = (value: number) => Math.round(value * 100) / 100;

export function scoreRecipe(candidate: RecipeCandidate, preferences: RecommendationPreferences) {
    const { weights, thresholds } = RECOMMENDATION_SCORING_POLICY;
    const reasons: Array<{ code: RecommendationReasonCode; text: string; value: number }> = [];
    const availability = candidate.requiredCount === 0 ? 1 : candidate.presentCount / candidate.requiredCount;
    const inventory = weights.inventory * Math.min(1, availability);
    if (inventory > 0)
        reasons.push({
            code: 'inventory_match',
            text: availability === 1 ? 'Все основные продукты уже есть' : 'Часть продуктов уже есть в запасах',
            value: inventory,
        });

    const expiry = weights.expiry * Math.min(1, candidate.expiringCount / Math.max(1, candidate.requiredCount));
    if (expiry > 0)
        reasons.push({ code: 'expiring_ingredients', text: 'Использует продукты с ближайшим сроком', value: expiry });

    const dietMatches = preferences.diets.filter((diet) => candidate.tags.includes(diet)).length;
    const diet =
        preferences.diets.length === 0 ? 0 : weights.diet * Math.min(1, dietMatches / preferences.diets.length);
    if (diet > 0) reasons.push({ code: 'diet_match', text: 'Соответствует выбранному рациону', value: diet });

    let goal = 0;
    if (
        preferences.goals.includes('quick') &&
        candidate.durationMinutes !== null &&
        candidate.durationMinutes <= thresholds.quickMinutes
    ) {
        goal += weights.quickGoal;
        reasons.push({
            code: 'quick_goal',
            text: 'Подходит для быстрого приготовления',
            value: weights.quickGoal,
        });
    }
    if (preferences.goals.includes('less_waste') && candidate.expiringCount > 0) goal += weights.lessWasteGoal;

    const quality =
        candidate.rating === null
            ? 0
            : weights.quality * ((candidate.rating - 1) / 4) * Math.min(1, candidate.ratingCount / 10);
    if (quality >= thresholds.qualityReasonMinimum)
        reasons.push({ code: 'high_rating', text: 'Хорошо оценён сообществом', value: quality });

    const novelty =
        candidate.completedCount === 0
            ? weights.novelty
            : Math.min(weights.novelty, (candidate.daysSinceCooked ?? 0) / 30);
    if (novelty >= thresholds.noveltyReasonMinimum)
        reasons.push({
            code: candidate.completedCount === 0 ? 'new_recipe' : 'variety',
            text: candidate.completedCount === 0 ? 'Новый для вас рецепт' : 'Вы давно не готовили это блюдо',
            value: novelty,
        });

    const collaborative =
        candidate.collaborativeSupport >= thresholds.collaborativeMinimumSupport
            ? Math.min(weights.collaborative, candidate.collaborativeScore * weights.collaborative)
            : 0;
    if (collaborative > 0)
        reasons.push({
            code: 'similar_tastes',
            text: 'Нравится людям с похожими предпочтениями',
            value: collaborative,
        });

    const repeatPenalty =
        candidate.daysSinceCooked !== null && candidate.daysSinceCooked < thresholds.recentRepeatDays
            ? weights.recentRepeatPenalty
            : 0;
    const score = Math.max(
        0,
        Math.min(100, inventory + expiry + diet + goal + quality + novelty + collaborative - repeatPenalty),
    );
    return {
        score: round(score),
        reasons: reasons
            .sort((a, b) => b.value - a.value || a.code.localeCompare(b.code))
            .slice(0, 3)
            .map((reason) => ({ code: reason.code, text: reason.text })),
    };
}

export function diversifyRecipes<T extends { recipe: RecipeCandidate; score: number }>(items: T[], limit: number): T[] {
    const selected: T[] = [];
    const categories = new Map<string, number>();
    for (const item of items.sort((a, b) => b.score - a.score || a.recipe.id.localeCompare(b.recipe.id))) {
        const category = item.recipe.category ?? 'unknown';
        if ((categories.get(category) ?? 0) >= 2 && items.length > limit) continue;
        selected.push(item);
        categories.set(category, (categories.get(category) ?? 0) + 1);
        if (selected.length === limit) break;
    }
    return selected;
}
