-- Prepared only. Apply after 001-023 during the separately approved transfer procedure.
-- The lease contains no credentials, payloads or user identifiers. PostgreSQL time is authoritative.
CREATE TABLE meal.worker_leases (
 task text PRIMARY KEY CHECK(task IN(
  'scheduled-news','incident-ignore-expiry','retention-inspection','scheduled-sanctions','diary-portions',
  'email-changes','exports','account-retention','ai-reconciliation','cooking-lifecycle'
 )),
 owner_id text NOT NULL CHECK(owner_id ~ '^[a-z][a-z0-9-]{2,63}$'),
 lease_id uuid NOT NULL,
 fencing_token bigint NOT NULL CHECK(fencing_token>0),
 acquired_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at>acquired_at),
 updated_at timestamptz NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0)
);
COMMENT ON TABLE meal.worker_leases IS 'Shared worker single-flight leases. No job payload, credentials or user identifiers.';
CREATE INDEX worker_leases_expiry ON meal.worker_leases(expires_at,task);
CREATE TRIGGER worker_leases_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.worker_leases
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
