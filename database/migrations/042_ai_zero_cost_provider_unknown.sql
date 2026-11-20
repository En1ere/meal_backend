-- Preserve zero user cost when a contract-v2 provider outcome is unknown.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE meal.ai_operations DROP CONSTRAINT ck_ai_operations_v2_unknown;
ALTER TABLE meal.ai_operations ADD CONSTRAINT ck_ai_operations_v2_unknown CHECK(
  contract_version<>2 OR lifecycle_state<>'unknown'
  OR (provider_request_id IS NULL AND financial_state IN('none','released') AND provider_cost_state='estimated_hold')
  OR (provider_request_id IS NOT NULL AND financial_state IN('none','reconciliation_hold'))
);

CREATE FUNCTION meal.project_zero_cost_ai_unknown() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_cost integer;
BEGIN
  IF NEW.contract_version=2 AND NEW.lifecycle_state='unknown' THEN
    SELECT accepted_cost::integer INTO task_cost
      FROM meal.ai_tasks WHERE id=NEW.task_id;
    IF task_cost IS NULL THEN
      RAISE EXCEPTION 'AI operation task cost is unavailable' USING ERRCODE='23514';
    END IF;
    IF task_cost=0 THEN
      NEW.financial_state:='none';
    ELSIF NEW.financial_state='none' THEN
      RAISE EXCEPTION 'Paid AI operation cannot have a zero-cost unknown outcome' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION meal.project_zero_cost_ai_unknown() FROM PUBLIC;

-- Same-timing triggers run by name. This projection must run after
-- zz_prepare_contract_v2, which keeps the paid no-identity release rule.
CREATE TRIGGER zzz_project_zero_cost_unknown BEFORE INSERT OR UPDATE ON meal.ai_operations
  FOR EACH ROW EXECUTE FUNCTION meal.project_zero_cost_ai_unknown();

COMMENT ON FUNCTION meal.project_zero_cost_ai_unknown() IS
  'Keeps action-free v2 provider operations at financial none for unknown outcomes without weakening paid reservations.';
