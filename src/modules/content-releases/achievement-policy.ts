import { z } from 'zod';

export type AchievementMetrics = {
    cookCount: number;
    distinctRecipes: number;
    breakfastCount: number;
    soupCount: number;
    bakingCount: number;
    dessertCount: number;
    vegetableCount: number;
    fishCount: number;
    plantCount: number;
    cuisineCount: number;
    leftoverCount: number;
    earlyCount: number;
    nightCount: number;
    preciseCount: number;
    seasonalCount: number;
    seasonalMonthCount: number;
    batchCount: number;
    locatedBatchCount: number;
    activeBatchCount: number;
    activeInventoryDays: number;
    preserveCount: number;
    planCount: number;
    maxPlanDays: number;
    shoppingCount: number;
    familyShoppingCount: number;
    receiptCount: number;
    publishedCount: number;
    completeRecipeCount: number;
    maxIndependentCooks: number;
    seriesCount: number;
    helpfulCount: number;
    followerCount: number;
    followingCount: number;
    correctionCount: number;
    allergenCount: number;
    sourceCount: number;
    photoCount: number;
    bookmarkCount: number;
    familyCookCount: number;
    familyWeeklyCooks: number;
    familyPlanDays: number;
    holidayCount: number;
    everythingUsedCount: number;
    expiredActiveCount: number;
};

const achievementMetricSchema = z.enum([
    'cookCount',
    'distinctRecipes',
    'breakfastCount',
    'soupCount',
    'bakingCount',
    'dessertCount',
    'vegetableCount',
    'fishCount',
    'plantCount',
    'cuisineCount',
    'leftoverCount',
    'earlyCount',
    'nightCount',
    'preciseCount',
    'seasonalCount',
    'seasonalMonthCount',
    'batchCount',
    'locatedBatchCount',
    'activeBatchCount',
    'activeInventoryDays',
    'preserveCount',
    'planCount',
    'maxPlanDays',
    'shoppingCount',
    'familyShoppingCount',
    'receiptCount',
    'publishedCount',
    'completeRecipeCount',
    'maxIndependentCooks',
    'seriesCount',
    'helpfulCount',
    'followerCount',
    'followingCount',
    'correctionCount',
    'allergenCount',
    'sourceCount',
    'photoCount',
    'bookmarkCount',
    'familyCookCount',
    'familyWeeklyCooks',
    'familyPlanDays',
    'holidayCount',
    'everythingUsedCount',
    'expiredActiveCount',
]);
const aggregateClauseSchema = z.strictObject({
    metric: achievementMetricSchema,
    operator: z.enum(['gte', 'eq']),
    threshold: z.number().int().nonnegative(),
});
export const achievementAggregateConditionSchema = z.union([
    aggregateClauseSchema,
    z.strictObject({ all: z.array(aggregateClauseSchema).min(1).max(10) }),
]);
type AggregateCondition = z.infer<typeof achievementAggregateConditionSchema>;
type AggregateClause = z.infer<typeof aggregateClauseSchema>;

const condition = (metric: AggregateClause['metric'], threshold: number): AggregateClause => ({
    metric,
    operator: 'gte',
    threshold,
});
const legacyAchievementConditions: Record<string, AggregateCondition> = {
    'first-dish': condition('cookCount', 1),
    'home-cook': condition('cookCount', 10),
    'confident-cook': condition('cookCount', 50),
    'hundred-dishes': condition('cookCount', 100),
    'new-flavors': condition('distinctRecipes', 10),
    'culinary-outlook': condition('distinctRecipes', 25),
    'breakfast-ready': condition('breakfastCount', 7),
    'soup-week': condition('soupCount', 5),
    'home-baking': condition('bakingCount', 5),
    'sweet-collection': condition('dessertCount', 5),
    'vegetable-season': condition('vegetableCount', 10),
    'fish-day': condition('fishCount', 5),
    'plant-menu': condition('plantCount', 10),
    'world-cuisines': condition('cuisineCount', 5),
    'no-extra-waste': condition('leftoverCount', 5),
    'first-batch': condition('batchCount', 1),
    'kitchen-order': condition('locatedBatchCount', 10),
    'full-pantry': condition('activeBatchCount', 50),
    'week-without-expiry': {
        all: [
            condition('activeBatchCount', 1),
            condition('activeInventoryDays', 7),
            { metric: 'expiredActiveCount', operator: 'eq', threshold: 0 },
        ],
    },
    'weekly-plan': condition('maxPlanDays', 7),
    'month-by-plan': condition('planCount', 4),
    'shopping-by-list': condition('shoppingCount', 1),
    'ten-lists': condition('shoppingCount', 10),
    'receipt-accepted': condition('receiptCount', 1),
    'homemade-preserve': condition('preserveCount', 1),
    'first-recipe': condition('publishedCount', 1),
    'five-recipes': condition('publishedCount', 5),
    'author-ten': condition('publishedCount', 10),
    'big-book': condition('publishedCount', 25),
    'complete-card': condition('completeRecipeCount', 1),
    'first-reader': condition('maxIndependentCooks', 1),
    'kitchen-tested': condition('maxIndependentCooks', 5),
    'peoples-recipe': condition('maxIndependentCooks', 25),
    'hundred-home-kitchens': condition('maxIndependentCooks', 100),
    'own-series': condition('seriesCount', 5),
    'good-advice': condition('helpfulCount', 1),
    'ten-good-tips': condition('helpfulCount', 10),
    'first-follower': condition('followerCount', 1),
    'readers-circle': condition('followerCount', 25),
    'useful-clarification': condition('correctionCount', 1),
    'catalog-helper': condition('correctionCount', 10),
    'catalog-expert': condition('correctionCount', 50),
    'allergen-noticed': condition('allergenCount', 1),
    'reliable-source': condition('sourceCount', 5),
    'good-photo': condition('photoCount', 1),
    'first-find': condition('bookmarkCount', 1),
    'personal-ten': condition('bookmarkCount', 10),
    'big-collection': condition('bookmarkCount', 50),
    'favorite-authors': condition('followingCount', 10),
    'shared-list': condition('familyShoppingCount', 1),
    'family-dinner': condition('familyCookCount', 1),
    'week-together': condition('familyPlanDays', 7),
    'team-kitchen': condition('familyWeeklyCooks', 3),
    'seasonal-table': condition('seasonalCount', 5),
    'holiday-table': condition('holidayCount', 1),
    'harvest-month': condition('seasonalMonthCount', 10),
    'early-breakfast': condition('earlyCount', 1),
    'night-cook': condition('nightCount', 1),
    'precise-calculation': condition('preciseCount', 1),
    'everything-used': condition('everythingUsedCount', 1),
};

export function normalizeAchievementCondition(code: string, value: unknown): unknown {
    const typed = achievementAggregateConditionSchema.safeParse(value);
    if (typed.success) return typed.data;
    return legacyAchievementConditions[code] ?? value;
}

export function achievementReached(conditionValue: AggregateCondition, metrics: AchievementMetrics) {
    const reached = (clause: AggregateClause) => {
        const actual = Number(metrics[clause.metric]);
        return clause.operator === 'gte' ? actual >= clause.threshold : actual === clause.threshold;
    };
    return 'all' in conditionValue ? conditionValue.all.every(reached) : reached(conditionValue);
}

export function categoryTitle(id: string) {
    return (
        (
            {
                culinary: 'Кулинария',
                inventory: 'Запасы',
                planning: 'Планирование',
                author: 'Авторство',
                community: 'Сообщество',
                catalog: 'Каталог',
                collections: 'Коллекции',
                family: 'Семья',
                seasonal: 'Сезонные',
                secret: 'Секретные',
            } as Record<string, string>
        )[id] ?? id
    );
}
