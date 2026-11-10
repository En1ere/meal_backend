-- Cost-zero backend AI operations and immutable resolved-source identity.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE meal.ai_tasks
  ADD COLUMN source_snapshot_hash char(64),
  ADD CONSTRAINT ck_ai_tasks_source_snapshot_hash CHECK(
    (contract_version=1 AND source_snapshot_hash IS NULL)
    OR (contract_version=2 AND source_snapshot_hash ~ '^[0-9a-f]{64}$')
  );

CREATE FUNCTION meal.protect_ai_task_source_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_snapshot_hash IS DISTINCT FROM OLD.source_snapshot_hash THEN
    RAISE EXCEPTION 'AI task source snapshot is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER protect_source_snapshot BEFORE UPDATE ON meal.ai_tasks
  FOR EACH ROW EXECUTE FUNCTION meal.protect_ai_task_source_snapshot();

ALTER TABLE meal.ai_intervals DROP CONSTRAINT ck_ai_intervals_43;
ALTER TABLE meal.ai_intervals ADD CONSTRAINT ck_ai_intervals_43 CHECK(
  ends_at=starts_at+interval '10 minutes'
  AND clarifications_used BETWEEN 0 AND 2
  AND cost BETWEEN 0 AND 5
);

CREATE FUNCTION meal.validate_ai_interval_zero_cost() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cost=0 AND NOT EXISTS(
    SELECT 1 FROM meal.ai_tasks task
     WHERE task.id=NEW.task_id AND task.contract_version=2 AND task.accepted_cost=0
  ) THEN
    RAISE EXCEPTION 'Zero-cost AI interval requires a zero-cost contract-v2 task' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER validate_zero_cost BEFORE INSERT OR UPDATE ON meal.ai_intervals
  FOR EACH ROW EXECUTE FUNCTION meal.validate_ai_interval_zero_cost();

COMMENT ON COLUMN meal.ai_tasks.source_snapshot_hash IS 'Immutable hash of server-resolved source evidence included in the v2 request identity.';
