-- Production Web Push subscriptions, policy and durable fan-out queue. Feature remains opt-in.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE meal.push_subscriptions
  ADD COLUMN endpoint_hash char(64),
  ADD COLUMN expiration_time timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE meal.push_subscriptions SET endpoint_hash=encode(digest(endpoint_encrypted,'sha256'),'hex') WHERE endpoint_hash IS NULL;
ALTER TABLE meal.push_subscriptions ALTER COLUMN endpoint_hash SET NOT NULL;
ALTER TABLE meal.push_subscriptions ADD CONSTRAINT ck_push_endpoint_hash CHECK (endpoint_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX uq_push_active_endpoint ON meal.push_subscriptions(endpoint_hash) WHERE revoked_at IS NULL;
CREATE INDEX ix_push_session_active ON meal.push_subscriptions(session_id,id) WHERE revoked_at IS NULL;

CREATE TABLE meal.web_push_policies (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id=1),
  quiet_start time NOT NULL DEFAULT '22:00', quiet_end time NOT NULL DEFAULT '08:00',
  critical_ttl integer NOT NULL DEFAULT 300 CHECK (critical_ttl BETWEEN 0 AND 86400),
  important_ttl integer NOT NULL DEFAULT 14400 CHECK (important_ttl BETWEEN 0 AND 86400),
  informational_ttl integer NOT NULL DEFAULT 86400 CHECK (informational_ttl BETWEEN 0 AND 86400),
  marketing_ttl integer NOT NULL DEFAULT 21600 CHECK (marketing_ttl BETWEEN 0 AND 86400),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES meal.users(id) ON DELETE RESTRICT,
  version bigint NOT NULL DEFAULT 1 CHECK (version>0), CHECK (quiet_start<>quiet_end)
);
INSERT INTO meal.web_push_policies(id) VALUES(1);

CREATE TABLE meal.runtime_setting_previews (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES meal.users(id) ON DELETE RESTRICT,
  actor_session_id uuid NOT NULL REFERENCES meal.sessions(id) ON DELETE RESTRICT,
  setting_key varchar(80) NOT NULL CHECK (setting_key='web_push.policy'),
  expected_version bigint NOT NULL CHECK (expected_version>0), payload jsonb NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_runtime_preview_expiry ON meal.runtime_setting_previews(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE meal.web_push_jobs (
  id uuid PRIMARY KEY, notification_id uuid NOT NULL REFERENCES meal.notifications(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES meal.push_subscriptions(id) ON DELETE RESTRICT,
  state varchar(16) NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','deferred','accepted','unknown','gone','failed')),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8), next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid, lease_until timestamptz, topic varchar(32) NOT NULL CHECK (topic ~ '^[A-Za-z0-9_-]{1,32}$'),
  ttl_seconds integer NOT NULL CHECK (ttl_seconds BETWEEN 0 AND 86400), urgency varchar(12) NOT NULL CHECK (urgency IN ('very-low','low','normal','high')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(notification_id,subscription_id), CHECK ((state='processing')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX ix_web_push_due ON meal.web_push_jobs(next_attempt_at,id) WHERE state IN ('queued','deferred');
CREATE INDEX ix_web_push_expired_lease ON meal.web_push_jobs(lease_until,id) WHERE state='processing';

CREATE TABLE meal.web_push_attempts (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES meal.web_push_jobs(id) ON DELETE RESTRICT,
  attempt smallint NOT NULL CHECK(attempt BETWEEN 1 AND 8), outcome varchar(16) NOT NULL CHECK(outcome IN ('accepted','deferred','unknown','gone','failed')),
  http_status smallint, error_code varchar(64), retry_at timestamptz, occurred_at timestamptz NOT NULL DEFAULT now(), UNIQUE(job_id,attempt),
  CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9._-]{1,64}$')
);

CREATE FUNCTION meal.protect_web_push_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'web push attempts are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER protect_web_push_attempt BEFORE UPDATE OR DELETE ON meal.web_push_attempts FOR EACH ROW EXECUTE FUNCTION meal.protect_web_push_attempt();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.web_push_policies FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.runtime_setting_previews FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.web_push_jobs FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();

REVOKE ALL ON meal.web_push_policies,meal.runtime_setting_previews,meal.web_push_jobs,meal.web_push_attempts FROM PUBLIC;
