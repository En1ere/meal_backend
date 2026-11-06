import type { RecipePolicy } from './recipe-policy.contracts.js';

export type RecipeAction = 'submission' | 'comment' | 'report';

export const defaultRecipePolicy: RecipePolicy = {
    version: 1,
    submissionDailyLimit: 10,
    commentHourlyLimit: 30,
    reportDailyLimit: 10,
};

export function recipeAllowance(policy: RecipePolicy, kind: RecipeAction) {
    return {
        limit:
            kind === 'submission'
                ? policy.submissionDailyLimit
                : kind === 'comment'
                  ? policy.commentHourlyLimit
                  : policy.reportDailyLimit,
        windowSeconds: kind === 'comment' ? 3600 : 86400,
    };
}
