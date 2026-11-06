-- Canonical durable AI operation lifecycle. Legacy status remains a compatibility projection.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

ALTER TABLE meal.ai_operations
  ADD COLUMN user_id uuid,
  ADD COLUMN task_id uuid,
  ADD COLUMN contract_version smallint NOT NULL DEFAULT 0,
  ADD COLUMN command_kind varchar(24),
  ADD COLUMN request_hash char(64),
  ADD COLUMN lifecycle_state varchar(24),
  ADD COLUMN financial_state varchar(24),
  ADD COLUMN failure_category varchar(64),
  ADD COLUMN failure_retryable boolean,
  ADD COLUMN queued_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN lease_owner varchar(64),
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN attempt_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN provider_client_request_id uuid,
  ADD COLUMN provider_request_id varchar(128),
  ADD COLUMN requested_model varchar(128),
  ADD COLUMN actual_model varchar(128),
  ADD COLUMN token_usage jsonb,
  ADD COLUMN service_tier varchar(64),
  ADD COLUMN task_policy_version varchar(64),
  ADD COLUMN context_manifest_version varchar(64),
  ADD COLUMN provider_profile_version varchar(64),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN expires_at timestamptz;

UPDATE meal.ai_operations o
SET user_id=c.user_id,
    task_id=t.id,
    command_kind=CASE WHEN coalesce((o.result_snapshot->>'continuation')::boolean,false) THEN 'continuation' ELSE 'initial' END,
    request_hash=encode(public.digest('legacy:'||o.interval_id::text||':'||o.idempotency_key,'sha256'),'hex'),
    lifecycle_state=CASE o.status WHEN 'succeeded' THEN 'succeeded' WHEN 'failed' THEN 'failed' ELSE 'unknown' END,
    financial_state=CASE
      WHEN coalesce((o.result_snapshot->>'charged')::boolean,true)=false THEN 'none'
      WHEN o.status='succeeded' THEN 'captured'
      WHEN o.status='failed' THEN 'released'
      ELSE 'reconciliation_hold'
    END,
    failure_category=CASE
      WHEN o.status='succeeded' THEN NULL
      WHEN o.result_snapshot->>'failure' IN ('provider_error','provider_outcome_unknown','process_interrupted')
        THEN o.result_snapshot->>'failure'
      WHEN o.status='failed' THEN 'provider_error'
      ELSE 'process_interrupted'
    END,
    failure_retryable=false,
    queued_at=coalesce(o.started_at,o.created_at),
    next_attempt_at=coalesce(o.started_at,o.created_at),
    task_policy_version='ai-task-policy-v3',
    context_manifest_version='ai-context-v1',
    provider_profile_version='openai-text-v1',
    updated_at=coalesce(o.finished_at,o.started_at,o.created_at),
    expires_at=coalesce(o.finished_at,o.created_at)+interval '30 days',
    status=CASE WHEN o.status IN ('succeeded','failed') THEN o.status ELSE 'unknown' END
FROM meal.ai_intervals i
JOIN meal.ai_tasks t ON t.id=i.task_id
JOIN meal.ai_conversations c ON c.id=t.conversation_id
WHERE i.id=o.interval_id;

ALTER TABLE meal.ai_operations
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN task_id SET NOT NULL,
  ALTER COLUMN command_kind SET NOT NULL,
  ALTER COLUMN request_hash SET NOT NULL,
  ALTER COLUMN lifecycle_state SET NOT NULL,
  ALTER COLUMN financial_state SET NOT NULL,
  ALTER COLUMN queued_at SET NOT NULL,
  ALTER COLUMN next_attempt_at SET NOT NULL,
  ALTER COLUMN task_policy_version SET NOT NULL,
  ALTER COLUMN context_manifest_version SET NOT NULL,
  ALTER COLUMN provider_profile_version SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL;

ALTER TABLE meal.ai_operations
  ADD CONSTRAINT fk_ai_operations_user_id FOREIGN KEY(user_id) REFERENCES meal.users(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_ai_operations_task_id FOREIGN KEY(task_id) REFERENCES meal.ai_tasks(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT ck_ai_operations_request_hash CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ck_ai_operations_contract_version CHECK(contract_version IN (0,1)),
  ADD CONSTRAINT ck_ai_operations_command_kind CHECK(command_kind IN ('initial','continuation')),
  ADD CONSTRAINT ck_ai_operations_lifecycle CHECK(lifecycle_state IN ('accepted','queued','running','succeeded','failed','cancelled','unknown')),
  ADD CONSTRAINT ck_ai_operations_financial CHECK(financial_state IN ('none','reserved','captured','released','reconciliation_hold')),
  ADD CONSTRAINT ck_ai_operations_failure CHECK(
    (failure_category IS NULL AND failure_retryable IS NULL)
    OR (failure_category IN ('provider_error','provider_outcome_unknown','process_interrupted','access_revoked','schema_invalid','refused','safety_rejected') AND failure_retryable IS NOT NULL)
  ),
  ADD CONSTRAINT ck_ai_operations_failure_state CHECK(
    (lifecycle_state IN ('failed','unknown') AND failure_category IS NOT NULL)
    OR (lifecycle_state='succeeded' AND failure_category IS NULL)
    OR lifecycle_state IN ('accepted','queued','running','cancelled')
  ),
  ADD CONSTRAINT ck_ai_operations_attempt_count CHECK(attempt_count BETWEEN 0 AND 10),
  ADD CONSTRAINT ck_ai_operations_lease_owner CHECK(lease_owner IS NULL OR lease_owner ~ '^[a-z][a-z0-9-]{2,63}$'),
  ADD CONSTRAINT ck_ai_operations_lease_tuple CHECK(
    (lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL)
    OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  ),
  ADD CONSTRAINT ck_ai_operations_running_lease CHECK(
    (lifecycle_state='running')=(lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  ),
  ADD CONSTRAINT ck_ai_operations_terminal_time CHECK(
    lifecycle_state NOT IN ('succeeded','failed','cancelled') OR finished_at IS NOT NULL
  ),
  ADD CONSTRAINT ck_ai_operations_financial_state CHECK(
    (lifecycle_state IN ('accepted','queued','running') AND financial_state IN ('none','reserved'))
    OR (lifecycle_state='unknown' AND financial_state IN ('none','reconciliation_hold'))
    OR (lifecycle_state='succeeded' AND financial_state IN ('none','captured'))
    OR (lifecycle_state IN ('failed','cancelled') AND financial_state IN ('none','released'))
  ),
  ADD CONSTRAINT ck_ai_operations_provider_ids CHECK(
    (provider_request_id IS NULL OR btrim(provider_request_id)<>'')
    AND (requested_model IS NULL OR btrim(requested_model)<>'')
    AND (actual_model IS NULL OR btrim(actual_model)<>'')
    AND (service_tier IS NULL OR btrim(service_tier)<>'')
  ),
  ADD CONSTRAINT ck_ai_operations_token_usage CHECK(
    token_usage IS NULL OR (jsonb_typeof(token_usage)='object' AND pg_column_size(token_usage)<=4096)
  ),
  ADD CONSTRAINT ck_ai_operations_policy_versions CHECK(
    btrim(task_policy_version)<>'' AND btrim(context_manifest_version)<>'' AND btrim(provider_profile_version)<>''
  ),
  ADD CONSTRAINT ck_ai_operations_expiry CHECK(expires_at>=created_at AND expires_at<=created_at+interval '31 days');

CREATE UNIQUE INDEX uq_ai_operations_user_idempotency_v1
  ON meal.ai_operations(user_id,idempotency_key)
  WHERE contract_version=1;
CREATE INDEX ix_ai_operations_due
  ON meal.ai_operations(next_attempt_at,created_at,id)
  WHERE lifecycle_state='queued';
CREATE INDEX ix_ai_operations_expired_lease
  ON meal.ai_operations(lease_until,id)
  WHERE lifecycle_state='running';
CREATE INDEX ix_ai_operations_reconciliation
  ON meal.ai_operations(updated_at,id)
  WHERE lifecycle_state='unknown';
CREATE INDEX ix_ai_operations_user
  ON meal.ai_operations(user_id,created_at DESC,id);
CREATE INDEX ix_ai_operations_task
  ON meal.ai_operations(task_id,created_at,id);

CREATE TABLE meal.ai_operation_attempts (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES meal.ai_operations(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  attempt_no smallint NOT NULL CHECK(attempt_no BETWEEN 1 AND 10),
  state varchar(24) NOT NULL CHECK(state IN ('prepared','submitted','polling','succeeded','failed','unknown','reconciled')),
  client_request_id uuid NOT NULL UNIQUE,
  lease_token uuid NOT NULL,
  provider_request_id varchar(128),
  requested_model varchar(128) NOT NULL CHECK(btrim(requested_model)<>''),
  actual_model varchar(128),
  service_tier varchar(64),
  input_tokens integer CHECK(input_tokens IS NULL OR input_tokens>=0),
  output_tokens integer CHECK(output_tokens IS NULL OR output_tokens>=0),
  reasoning_tokens integer CHECK(reasoning_tokens IS NULL OR reasoning_tokens>=0),
  estimated_cost numeric(24,8) CHECK(estimated_cost IS NULL OR estimated_cost>=0),
  actual_cost numeric(24,8) CHECK(actual_cost IS NULL OR actual_cost>=0),
  error_category varchar(64),
  error_code varchar(128),
  started_at timestamptz NOT NULL,
  submitted_at timestamptz,
  finished_at timestamptz,
  latency_ms integer CHECK(latency_ms IS NULL OR latency_ms BETWEEN 0 AND 3600000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id,attempt_no),
  CHECK(provider_request_id IS NULL OR btrim(provider_request_id)<>''),
  CHECK(actual_model IS NULL OR btrim(actual_model)<>''),
  CHECK(service_tier IS NULL OR btrim(service_tier)<>''),
  CHECK(error_category IS NULL OR error_category IN ('provider_error','provider_outcome_unknown','schema_invalid','refused','safety_rejected','process_interrupted')),
  CHECK(error_code IS NULL OR btrim(error_code)<>''),
  CHECK(submitted_at IS NULL OR submitted_at>=started_at),
  CHECK(finished_at IS NULL OR finished_at>=started_at),
  CHECK((state IN ('succeeded','failed','unknown','reconciled'))=(finished_at IS NOT NULL)),
  CHECK(state NOT IN ('submitted','polling','succeeded','failed','unknown','reconciled') OR submitted_at IS NOT NULL),
  CHECK(state<>'succeeded' OR (provider_request_id IS NOT NULL AND error_category IS NULL)),
  CHECK(state NOT IN ('failed','unknown') OR error_category IS NOT NULL)
);

CREATE UNIQUE INDEX uq_ai_operation_attempts_provider_request
  ON meal.ai_operation_attempts(provider_request_id)
  WHERE provider_request_id IS NOT NULL;

CREATE INDEX ix_ai_operation_attempts_operation
  ON meal.ai_operation_attempts(operation_id,attempt_no DESC);

CREATE FUNCTION meal.prepare_ai_operation_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  derived_user_id uuid;
  derived_task_id uuid;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT c.user_id,t.id INTO derived_user_id,derived_task_id
    FROM meal.ai_intervals i
    JOIN meal.ai_tasks t ON t.id=i.task_id
    JOIN meal.ai_conversations c ON c.id=t.conversation_id
    WHERE i.id=NEW.interval_id;
    IF derived_user_id IS NULL THEN
      RAISE EXCEPTION 'AI operation interval ownership is unavailable' USING ERRCODE='23514';
    END IF;
    NEW.user_id:=coalesce(NEW.user_id,derived_user_id);
    NEW.task_id:=coalesce(NEW.task_id,derived_task_id);
    NEW.command_kind:=coalesce(NEW.command_kind,CASE WHEN coalesce((NEW.result_snapshot->>'continuation')::boolean,false) THEN 'continuation' ELSE 'initial' END);
    NEW.request_hash:=coalesce(NEW.request_hash,encode(public.digest('legacy:'||NEW.interval_id::text||':'||NEW.idempotency_key,'sha256'),'hex'));
    NEW.lifecycle_state:=coalesce(NEW.lifecycle_state,CASE NEW.status WHEN 'succeeded' THEN 'succeeded' WHEN 'failed' THEN 'failed' WHEN 'unknown' THEN 'unknown' ELSE 'queued' END);
    NEW.financial_state:=coalesce(NEW.financial_state,CASE WHEN coalesce((NEW.result_snapshot->>'charged')::boolean,true)=false THEN 'none' WHEN NEW.lifecycle_state='succeeded' THEN 'captured' WHEN NEW.lifecycle_state IN ('failed','cancelled') THEN 'released' WHEN NEW.lifecycle_state='unknown' THEN 'reconciliation_hold' ELSE 'reserved' END);
    NEW.queued_at:=coalesce(NEW.queued_at,NEW.started_at,NEW.created_at,now());
    NEW.next_attempt_at:=coalesce(NEW.next_attempt_at,NEW.queued_at);
    NEW.task_policy_version:=coalesce(NEW.task_policy_version,'ai-task-policy-v3');
    NEW.context_manifest_version:=coalesce(NEW.context_manifest_version,'ai-context-v1');
    NEW.provider_profile_version:=coalesce(NEW.provider_profile_version,'openai-text-v1');
    NEW.updated_at:=coalesce(NEW.updated_at,NEW.created_at,now());
    NEW.expires_at:=coalesce(NEW.expires_at,coalesce(NEW.created_at,now())+interval '30 days');
  ELSE
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.task_id IS DISTINCT FROM OLD.task_id
       OR NEW.contract_version IS DISTINCT FROM OLD.contract_version OR NEW.command_kind IS DISTINCT FROM OLD.command_kind
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.task_policy_version IS DISTINCT FROM OLD.task_policy_version
       OR NEW.context_manifest_version IS DISTINCT FROM OLD.context_manifest_version
       OR NEW.provider_profile_version IS DISTINCT FROM OLD.provider_profile_version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'AI operation identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.lifecycle_state=OLD.lifecycle_state AND NEW.status IS DISTINCT FROM OLD.status THEN
      NEW.lifecycle_state:=CASE NEW.status WHEN 'succeeded' THEN 'succeeded' WHEN 'failed' THEN 'failed' WHEN 'unknown' THEN 'unknown' ELSE NEW.lifecycle_state END;
    ELSIF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
      NEW.status:=CASE NEW.lifecycle_state WHEN 'succeeded' THEN 'succeeded' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'failed' WHEN 'unknown' THEN 'unknown' ELSE 'processing' END;
    END IF;
    IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
      IF coalesce((NEW.result_snapshot->>'charged')::boolean,true)=false THEN
        NEW.financial_state:='none';
      ELSIF NEW.lifecycle_state='succeeded' THEN
        NEW.financial_state:='captured';
      ELSIF NEW.lifecycle_state IN ('failed','cancelled') THEN
        NEW.financial_state:='released';
      ELSIF NEW.lifecycle_state='unknown' THEN
        NEW.financial_state:='reconciliation_hold';
      ELSE
        NEW.financial_state:='reserved';
      END IF;
      IF NEW.lifecycle_state='succeeded' THEN
        NEW.failure_category:=NULL; NEW.failure_retryable:=NULL;
      ELSIF NEW.lifecycle_state IN ('failed','unknown') THEN
        NEW.failure_category:=coalesce(NULLIF(NEW.result_snapshot->>'failure',''),CASE WHEN NEW.lifecycle_state='unknown' THEN 'provider_outcome_unknown' ELSE 'provider_error' END);
        NEW.failure_retryable:=false;
      END IF;
    END IF;
    IF NEW.lifecycle_state<>'running' THEN
      NEW.lease_owner:=NULL; NEW.lease_token:=NULL; NEW.lease_until:=NULL;
    END IF;
    NEW.updated_at:=now();
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION meal.protect_ai_operation_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
     OR NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.requested_model IS DISTINCT FROM OLD.requested_model
     OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'AI operation attempt identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT (NEW.state=OLD.state
    OR (OLD.state='prepared' AND NEW.state IN ('submitted','failed','unknown'))
    OR (OLD.state='submitted' AND NEW.state IN ('polling','succeeded','failed','unknown'))
    OR (OLD.state='polling' AND NEW.state IN ('polling','succeeded','failed','unknown'))
    OR (OLD.state='unknown' AND NEW.state IN ('reconciled','succeeded','failed'))) THEN
    RAISE EXCEPTION 'invalid AI attempt transition % -> %',OLD.state,NEW.state USING ERRCODE='23514';
  END IF;
  IF OLD.state IN ('succeeded','failed','reconciled') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal AI attempt is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER prepare_lifecycle BEFORE INSERT OR UPDATE ON meal.ai_operations
  FOR EACH ROW EXECUTE FUNCTION meal.prepare_ai_operation_lifecycle();
CREATE TRIGGER protect_attempt BEFORE UPDATE ON meal.ai_operation_attempts
  FOR EACH ROW EXECUTE FUNCTION meal.protect_ai_operation_attempt();
CREATE TRIGGER immutable_rows BEFORE DELETE ON meal.ai_operation_attempts
  FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.ai_operation_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();

COMMENT ON TABLE meal.ai_operation_attempts IS 'Sanitized provider attempt evidence with immutable identity and terminal rows; prompt, personal context, result and raw provider errors are forbidden.';
COMMENT ON COLUMN meal.ai_operations.lifecycle_state IS 'Canonical transport lifecycle; legacy status remains a compatibility projection.';
COMMENT ON COLUMN meal.ai_operations.financial_state IS 'Independent action reservation state; unknown never implies release.';
