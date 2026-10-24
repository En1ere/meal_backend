-- Prepared only. Applying this migration requires the separately approved transfer procedure.
CREATE TABLE meal.user_critical_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  session_id uuid NOT NULL REFERENCES meal.sessions(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT ck_user_critical_grants_purpose CHECK (purpose IN ('export','account_lifecycle')),
  CONSTRAINT ck_user_critical_grants_version CHECK (version > 0)
);

CREATE TABLE meal.export_previews (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  scope_id uuid REFERENCES meal.data_scopes(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  selection jsonb NOT NULL,
  manifest jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT ck_export_previews_version CHECK (version > 0)
);

ALTER TABLE meal.legal_requests
  ADD COLUMN idempotency_key uuid,
  ADD COLUMN requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN cancel_until timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN finalization_not_before timestamptz,
  ADD COLUMN policy_version text,
  ADD COLUMN blocker_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE meal.export_jobs ADD COLUMN idempotency_key uuid;
CREATE UNIQUE INDEX uq_export_jobs_user_idempotency ON meal.export_jobs(user_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE meal.account_devices ADD COLUMN expires_at timestamptz;
UPDATE meal.account_devices SET expires_at=created_at+interval '30 days' WHERE expires_at IS NULL;
ALTER TABLE meal.account_devices ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE meal.account_devices ADD CONSTRAINT ck_account_devices_expiry CHECK(expires_at>created_at);

CREATE OR REPLACE FUNCTION meal.protect_account_login() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.login IS DISTINCT FROM OLD.login AND NOT (NEW.status='deleted' AND NEW.login=('deleted-'||OLD.id::text))
 THEN RAISE EXCEPTION 'Username is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE UNIQUE INDEX uq_legal_requests_user_delete_idempotency
  ON meal.legal_requests(user_id,idempotency_key)
  WHERE kind='account_deletion' AND idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_legal_requests_one_open_delete
  ON meal.legal_requests(user_id)
  WHERE kind='account_deletion' AND status IN ('requested','retention_wait','ready','blocked');
CREATE INDEX ix_user_critical_grants_expiry ON meal.user_critical_grants(expires_at) WHERE used_at IS NULL;
CREATE INDEX ix_export_previews_expiry ON meal.export_previews(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX ix_export_jobs_status_requested ON meal.export_jobs(status,requested_at,id);
CREATE INDEX ix_legal_requests_finalize ON meal.legal_requests(finalization_not_before,id)
  WHERE kind='account_deletion' AND status IN ('retention_wait','ready');

CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.user_critical_grants FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.export_previews FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();

COMMENT ON TABLE meal.user_critical_grants IS 'Single-use recent user reauthentication grants bound to a session and purpose.';
COMMENT ON TABLE meal.export_previews IS 'Short-lived server-owned export manifests; client cannot alter the selected ACL snapshot.';
COMMENT ON COLUMN meal.legal_requests.blocker_snapshot IS 'Fail-closed retention, hold, shared-data, billing, audit and backup exclusions captured at request time.';
