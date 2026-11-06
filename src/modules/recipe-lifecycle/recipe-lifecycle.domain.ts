export type RecipeReviewStatus = 'draft' | 'pending' | 'rejected' | 'published' | 'hidden' | 'unpublished';

export type RecipeLifecycleProjection = {
    review: { revisionId: string; status: RecipeReviewStatus; publicReason: string | null };
    publication: { revisionId: string; publishedAt: string } | null;
};

export function sanitizePublicReviewReason(
    value: string | null | undefined,
    status: RecipeReviewStatus,
): string | null {
    const normalized = value
        ?.replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 500);
    if (normalized) return normalized;
    if (status === 'rejected') return 'Рецепт требует исправлений перед повторной отправкой.';
    if (status === 'hidden') return 'Рецепт скрыт из публичного доступа после проверки.';
    if (status === 'unpublished') return 'Публикация рецепта снята после проверки.';
    return null;
}

export function projectRecipeLifecycle(input: {
    currentRevisionId: string;
    fallbackStatus: string;
    review?: { revisionId: string; status: string; publicReason: string | null } | undefined;
    publication: { revisionId: string; publishedAt: string } | null;
}): RecipeLifecycleProjection {
    const effective =
        input.fallbackStatus === 'hidden'
            ? 'hidden'
            : ['hidden', 'unpublished'].includes(input.review?.status ?? '')
              ? input.review?.status
              : input.review?.status === 'published'
                ? 'published'
                : ['queued', 'pending', 'in_review', 'approved'].includes(input.review?.status ?? '')
                  ? 'pending'
                  : input.review?.status === 'rejected'
                    ? 'rejected'
                    : input.fallbackStatus === 'published'
                      ? 'published'
                      : 'draft';
    const status = effective as RecipeReviewStatus;
    return {
        review: {
            revisionId: input.review?.revisionId ?? input.currentRevisionId,
            status,
            publicReason: sanitizePublicReviewReason(input.review?.publicReason, status),
        },
        publication: input.publication,
    };
}
