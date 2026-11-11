-- Durable contract-v2 provider submit/readback evidence. No provider route is enabled by this migration.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE meal.ai_provider_dispatches (
  operation_id uuid PRIMARY KEY REFERENCES meal.ai_operations(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  client_request_id uuid NOT NULL UNIQUE,
  profile_version varchar(64) NOT NULL CHECK(btrim(profile_version)<>''),
  requested_model varchar(160) NOT NULL CHECK(btrim(requested_model)<>''),
  state varchar(32) NOT NULL CHECK(state IN(
    'prepared','submit_claimed','accepted','read_claimed','queued','running','read_unknown',
    'succeeded','failed','cancelled','incomplete','rejected','unknown_without_identity'
  )),
  submit_outcome varchar(32) CHECK(submit_outcome IN('accepted','rejected','unknown_without_identity')),
  read_outcome varchar(24) CHECK(read_outcome IN('queued','running','succeeded','failed','cancelled','incomplete','unknown')),
  provider_response_id varchar(200),
  estimated_cost_rub numeric(24,8) NOT NULL CHECK(estimated_cost_rub>0),
  actual_cost_rub numeric(24,8) CHECK(actual_cost_rub IS NULL OR actual_cost_rub>=0),
  input_tokens integer CHECK(input_tokens IS NULL OR input_tokens BETWEEN 0 AND 10000000),
  output_tokens integer CHECK(output_tokens IS NULL OR output_tokens BETWEEN 0 AND 10000000),
  cached_input_tokens integer CHECK(cached_input_tokens IS NULL OR cached_input_tokens BETWEEN 0 AND 10000000),
  reasoning_tokens integer CHECK(reasoning_tokens IS NULL OR reasoning_tokens BETWEEN 0 AND 10000000),
  error_category varchar(64) CHECK(error_category IN(
    'authentication_failed','permission_denied','request_invalid','rate_limited','provider_unconfigured',
    'provider_disabled','profile_mismatch','input_limit_exceeded','invalid_structured_result',
    'provider_failed','provider_cancelled','provider_incomplete','provider_outcome_unknown','process_interrupted'
  )),
  lease_owner varchar(64),
  lease_token uuid,
  lease_until timestamptz,
  read_count smallint NOT NULL DEFAULT 0 CHECK(read_count BETWEEN 0 AND 100),
  next_read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  CHECK(provider_response_id IS NULL OR btrim(provider_response_id)<>''),
  CHECK(
    (lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL)
    OR (lease_owner ~ '^[a-z][a-z0-9-]{2,63}$' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  ),
  CHECK((state IN('submit_claimed','read_claimed'))=(lease_token IS NOT NULL)),
  CHECK(
    (state IN('prepared','submit_claimed') AND submit_outcome IS NULL AND read_outcome IS NULL AND provider_response_id IS NULL)
    OR (state='rejected' AND submit_outcome='rejected' AND read_outcome IS NULL AND provider_response_id IS NULL)
    OR (state='unknown_without_identity' AND submit_outcome='unknown_without_identity' AND read_outcome IS NULL AND provider_response_id IS NULL)
    OR (state IN('accepted','read_claimed') AND submit_outcome='accepted' AND read_outcome IS NULL AND provider_response_id IS NOT NULL)
    OR (state='queued' AND submit_outcome='accepted' AND read_outcome='queued' AND provider_response_id IS NOT NULL)
    OR (state='running' AND submit_outcome='accepted' AND read_outcome='running' AND provider_response_id IS NOT NULL)
    OR (state='read_unknown' AND submit_outcome='accepted' AND read_outcome='unknown' AND provider_response_id IS NOT NULL)
    OR (state IN('succeeded','failed','cancelled','incomplete') AND submit_outcome='accepted'
        AND read_outcome=state AND provider_response_id IS NOT NULL)
  ),
  CHECK(
    (state IN('succeeded','failed','cancelled','incomplete','rejected','unknown_without_identity'))=(terminal_at IS NOT NULL)
  ),
  CHECK(actual_cost_rub IS NULL OR state IN('succeeded','failed','cancelled','incomplete')),
  CHECK((input_tokens IS NULL)=(actual_cost_rub IS NULL)),
  CHECK((output_tokens IS NULL)=(actual_cost_rub IS NULL)),
  CHECK((cached_input_tokens IS NULL)=(actual_cost_rub IS NULL)),
  CHECK((reasoning_tokens IS NULL)=(actual_cost_rub IS NULL)),
  CHECK(next_read_at IS NULL OR provider_response_id IS NOT NULL)
);

CREATE UNIQUE INDEX uq_ai_provider_dispatches_response
  ON meal.ai_provider_dispatches(provider_response_id)
  WHERE provider_response_id IS NOT NULL;
CREATE INDEX ix_ai_provider_dispatches_read_due
  ON meal.ai_provider_dispatches(next_read_at,operation_id)
  WHERE state IN('accepted','queued','running','read_unknown');
CREATE INDEX ix_ai_provider_dispatches_expired_lease
  ON meal.ai_provider_dispatches(lease_until,operation_id)
  WHERE state IN('submit_claimed','read_claimed');

CREATE FUNCTION meal.protect_ai_provider_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  operation record;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT o.contract_version,o.execution_route,o.provider_profile_version,o.lifecycle_state,o.financial_state,
           o.provider_cost_state,o.provider_cost_currency,o.provider_cost,o.provider_request_id,
           t.provider_cost_ceiling_minor
      INTO operation
      FROM meal.ai_operations o JOIN meal.ai_tasks t ON t.id=o.task_id
     WHERE o.id=NEW.operation_id FOR SHARE OF o,t;
    IF NOT FOUND OR operation.contract_version<>2 OR operation.execution_route NOT IN('economy','balanced')
       OR operation.provider_profile_version IS DISTINCT FROM NEW.profile_version
       OR operation.lifecycle_state<>'queued' OR operation.financial_state NOT IN('none','reserved')
       OR operation.provider_cost_state<>'none' OR operation.provider_cost_currency<>'RUB'
       OR operation.provider_cost IS NOT NULL OR operation.provider_request_id IS NOT NULL
       OR NEW.estimated_cost_rub>operation.provider_cost_ceiling_minor::numeric/100
       OR NEW.state<>'prepared' OR NEW.submit_outcome IS NOT NULL OR NEW.read_outcome IS NOT NULL
       OR NEW.provider_response_id IS NOT NULL THEN
      RAISE EXCEPTION 'AI v2 provider dispatch is not prepared from a frozen model operation' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
     OR NEW.profile_version IS DISTINCT FROM OLD.profile_version
     OR NEW.requested_model IS DISTINCT FROM OLD.requested_model
     OR NEW.estimated_cost_rub IS DISTINCT FROM OLD.estimated_cost_rub
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'AI v2 provider dispatch identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.provider_response_id IS NOT NULL AND NEW.provider_response_id IS DISTINCT FROM OLD.provider_response_id THEN
    RAISE EXCEPTION 'AI provider response identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.submit_outcome IS NOT NULL AND NEW.submit_outcome IS DISTINCT FROM OLD.submit_outcome THEN
    RAISE EXCEPTION 'AI provider submit outcome is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.version<>OLD.version+1 OR NEW.updated_at<=OLD.updated_at THEN
    RAISE EXCEPTION 'AI provider dispatch update requires CAS version and monotonic time' USING ERRCODE='23514';
  END IF;
  IF NOT (
    (OLD.state='prepared' AND NEW.state='submit_claimed')
    OR (OLD.state='submit_claimed' AND NEW.state IN('accepted','rejected','unknown_without_identity'))
    OR (OLD.state IN('accepted','queued','running','read_unknown') AND NEW.state='read_claimed')
    OR (OLD.state='read_claimed' AND NEW.state IN('queued','running','read_unknown','succeeded','failed','cancelled','incomplete'))
  ) THEN
    RAISE EXCEPTION 'invalid AI provider dispatch transition % -> %',OLD.state,NEW.state USING ERRCODE='23514';
  END IF;
  IF OLD.state IN('succeeded','failed','cancelled','incomplete','rejected','unknown_without_identity') THEN
    RAISE EXCEPTION 'terminal AI provider dispatch is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER protect_dispatch BEFORE INSERT OR UPDATE ON meal.ai_provider_dispatches
  FOR EACH ROW EXECUTE FUNCTION meal.protect_ai_provider_dispatch();
CREATE TRIGGER immutable_rows BEFORE DELETE ON meal.ai_provider_dispatches
  FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.ai_provider_dispatches
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();

-- PostgreSQL runs same-timing triggers by name. Apply the v2 unknown-without-identity
-- financial override after the generic lifecycle projection.
DROP TRIGGER prepare_contract_v2 ON meal.ai_operations;
CREATE TRIGGER zz_prepare_contract_v2 BEFORE INSERT OR UPDATE ON meal.ai_operations
  FOR EACH ROW EXECUTE FUNCTION meal.prepare_ai_operation_contract_v2();

COMMENT ON TABLE meal.ai_provider_dispatches IS 'Sanitized one-submit contract-v2 provider evidence; prompt, context, result and raw provider payload/error are forbidden.';
COMMENT ON COLUMN meal.ai_provider_dispatches.client_request_id IS 'Diagnostic correlation only; it is not provider create idempotency.';
COMMENT ON COLUMN meal.ai_provider_dispatches.provider_response_id IS 'Immutable identity enabling readback only; it never authorizes another submit.';
