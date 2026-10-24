-- Prepared only. Apply after restore and separate approval; never edit migrations 001-003.
-- Sanitization happens before ingestion. No arbitrary JSON, email, device endpoint or auth payload.
CREATE TABLE meal.admin_error_events (
 id uuid PRIMARY KEY,
 occurred_at timestamptz NOT NULL,
 source text NOT NULL CHECK(source IN ('frontend','backend','api','worker')),
 severity text NOT NULL CHECK(severity IN ('error','warning','critical')),
 environment text NOT NULL CHECK(environment IN ('development','test','production')),
 app_version text CHECK(length(app_version) BETWEEN 1 AND 64),
 code text NOT NULL CHECK(code ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,99}$'),
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 1000),
 stack_summary text CHECK(length(stack_summary) <= 4000),
 request_id uuid,
 job_id uuid REFERENCES meal.background_jobs(id) DEFERRABLE INITIALLY DEFERRED,
 pseudonymous_id text CHECK(pseudonymous_id ~ '^[a-f0-9]{64}$'),
 version bigint NOT NULL DEFAULT 1 CHECK(version=1)
);
COMMENT ON TABLE meal.admin_error_events IS 'Sanitized append-only operational errors. Retention policy pending; no automatic purge.';
CREATE INDEX admin_error_events_occurred ON meal.admin_error_events(occurred_at,id);
CREATE INDEX admin_error_events_job ON meal.admin_error_events(job_id) WHERE job_id IS NOT NULL;
CREATE TABLE meal.admin_metric_events (
 id uuid PRIMARY KEY,
 occurred_at timestamptz NOT NULL,
 event_name text NOT NULL CHECK(event_name ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,99}$'),
 metric_value numeric(24,8) NOT NULL CHECK(metric_value>=0 AND metric_value<1e16),
 unit text NOT NULL CHECK(unit IN ('count','milliseconds')),
 environment text NOT NULL CHECK(environment IN ('development','test','production')),
 app_version text CHECK(length(app_version) BETWEEN 1 AND 64),
 plan_code text CHECK(plan_code IN ('free','plus','pro')),
 feature_flag text CHECK(feature_flag ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,99}$'),
 version bigint NOT NULL DEFAULT 1 CHECK(version=1)
);
COMMENT ON TABLE meal.admin_metric_events IS 'Primary measurements with explicit units. No user identifier or inferred funnels; retention policy pending.';
CREATE INDEX admin_metric_events_occurred ON meal.admin_metric_events(occurred_at,id);
CREATE TRIGGER admin_error_events_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.admin_error_events
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER admin_metric_events_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.admin_metric_events
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER admin_error_events_append_only BEFORE UPDATE OR DELETE ON meal.admin_error_events
 FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE TRIGGER admin_metric_events_append_only BEFORE UPDATE OR DELETE ON meal.admin_metric_events
 FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
