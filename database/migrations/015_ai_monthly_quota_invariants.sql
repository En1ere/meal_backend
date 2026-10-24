CREATE UNIQUE INDEX uq_ai_quota_periods_subscription_window
  ON meal.ai_quota_periods(subscription_id, starts_at, ends_at)
  WHERE subscription_id IS NOT NULL;

CREATE UNIQUE INDEX uq_ai_quota_periods_family_window
  ON meal.ai_quota_periods(family_coverage_id, starts_at, ends_at)
  WHERE family_coverage_id IS NOT NULL;

CREATE UNIQUE INDEX uq_ai_buckets_period_user_kind
  ON meal.ai_buckets(quota_period_id, user_id, kind)
  WHERE quota_period_id IS NOT NULL AND user_id IS NOT NULL;

CREATE UNIQUE INDEX uq_ai_buckets_period_family_kind
  ON meal.ai_buckets(quota_period_id, family_id, kind)
  WHERE quota_period_id IS NOT NULL AND family_id IS NOT NULL;

COMMENT ON INDEX meal.uq_ai_quota_periods_subscription_window IS 'Не более одного месячного окна AI-квоты на период личной подписки';
COMMENT ON INDEX meal.uq_ai_quota_periods_family_window IS 'Не более одного месячного окна AI-квоты на активное семейное покрытие';
