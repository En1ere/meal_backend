-- Versioned, auditable manual acceptance-test runs for the administrator portal.
-- The migration runner owns the SERIALIZABLE transaction and checksum verification.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE meal.acceptance_test_runs (
  id uuid PRIMARY KEY,
  catalog_version varchar(80) NOT NULL UNIQUE,
  catalog_published_on date NOT NULL,
  created_by uuid NOT NULL REFERENCES meal.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE meal.acceptance_test_results (
  run_id uuid NOT NULL REFERENCES meal.acceptance_test_runs(id) ON DELETE RESTRICT,
  case_id varchar(32) NOT NULL,
  source_checksum char(64) NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  status varchar(20) NOT NULL CHECK (status IN ('not_tested','passed','partial','failed')),
  comment varchar(1000) NOT NULL DEFAULT '',
  checked_by uuid REFERENCES meal.users(id) ON DELETE RESTRICT,
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (run_id, case_id),
  CHECK ((status = 'not_tested') OR (checked_by IS NOT NULL AND checked_at IS NOT NULL))
);

CREATE TABLE meal.acceptance_test_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES meal.acceptance_test_runs(id) ON DELETE RESTRICT,
  case_id varchar(32) NOT NULL,
  source_checksum char(64) NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  action varchar(20) NOT NULL CHECK (action IN ('updated','reset')),
  before_status varchar(20) NOT NULL CHECK (before_status IN ('not_tested','passed','partial','failed')),
  after_status varchar(20) NOT NULL CHECK (after_status IN ('not_tested','passed','partial','failed')),
  before_comment_hash char(64) NOT NULL CHECK (before_comment_hash ~ '^[0-9a-f]{64}$'),
  after_comment_hash char(64) NOT NULL CHECK (after_comment_hash ~ '^[0-9a-f]{64}$'),
  result_version bigint NOT NULL CHECK (result_version > 0),
  actor_id uuid NOT NULL REFERENCES meal.users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  UNIQUE (run_id, case_id, result_version),
  UNIQUE (actor_id, action, run_id, case_id, idempotency_key)
);

CREATE INDEX ix_acceptance_test_results_run_status
  ON meal.acceptance_test_results(run_id, status, case_id);
CREATE INDEX ix_acceptance_test_events_run_case
  ON meal.acceptance_test_events(run_id, case_id, occurred_at DESC, id);

CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.acceptance_test_runs
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.acceptance_test_results
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.acceptance_test_events
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();

CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON meal.acceptance_test_runs
  FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE OR REPLACE FUNCTION meal.protect_acceptance_result_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, meal
AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.case_id IS DISTINCT FROM OLD.case_id THEN
    RAISE EXCEPTION 'acceptance test result identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_identity BEFORE UPDATE ON meal.acceptance_test_results
  FOR EACH ROW EXECUTE FUNCTION meal.protect_acceptance_result_identity();
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON meal.acceptance_test_events
  FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();

COMMENT ON TABLE meal.acceptance_test_runs IS 'One immutable acceptance run identity per versioned manual-test catalog.';
COMMENT ON TABLE meal.acceptance_test_results IS 'Current CAS-protected acceptance result for a case in a catalog run.';
COMMENT ON TABLE meal.acceptance_test_events IS 'Append-only acceptance result history without raw comment payloads.';
