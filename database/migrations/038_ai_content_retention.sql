-- Destructive AI product-content retention. Operational and financial evidence is retained.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE meal.ai_tasks ADD COLUMN content_purged_at timestamptz;
ALTER TABLE meal.ai_messages ADD COLUMN content_purged_at timestamptz;
ALTER TABLE meal.ai_operations ADD COLUMN content_purged_at timestamptz;

CREATE INDEX ix_ai_tasks_content_retention
  ON meal.ai_tasks(created_at,id) WHERE content_purged_at IS NULL;
CREATE INDEX ix_ai_messages_content_retention
  ON meal.ai_messages(interval_id,id) WHERE content_purged_at IS NULL;
CREATE INDEX ix_ai_operations_content_retention
  ON meal.ai_operations(expires_at,task_id,id) WHERE content_purged_at IS NULL;

ALTER TABLE meal.worker_leases DROP CONSTRAINT worker_leases_task_check;
ALTER TABLE meal.worker_leases ADD CONSTRAINT worker_leases_task_check CHECK(task IN(
  'scheduled-news','incident-ignore-expiry','retention-inspection','scheduled-sanctions','diary-portions',
  'email-changes','exports','account-retention','ai-reconciliation','ai-content-retention','cooking-lifecycle'
));

COMMENT ON COLUMN meal.ai_tasks.content_purged_at IS 'Original AI goal/context was irreversibly removed by the 30-day content policy.';
COMMENT ON COLUMN meal.ai_messages.content_purged_at IS 'Original message body was irreversibly removed by the 30-day content policy.';
COMMENT ON COLUMN meal.ai_operations.content_purged_at IS 'Original result payload was irreversibly removed; operational/financial evidence remains.';

