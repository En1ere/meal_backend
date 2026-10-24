-- Prepared only. Apply after 001-011 during the separately approved Linux transfer.
-- The migration runner owns the SERIALIZABLE transaction and checksum verification.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE meal.admin_notification_settings (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL UNIQUE REFERENCES meal.users(id) DEFERRABLE INITIALLY DEFERRED,
 settings jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 version bigint NOT NULL DEFAULT 1 CHECK(version >= 1),
 CHECK(jsonb_typeof(settings) = 'object')
);
COMMENT ON TABLE meal.admin_notification_settings IS 'Per-admin delivery and aggregation preferences. Channels default off; provider delivery is configured separately.';

CREATE TABLE meal.admin_incident_states (
 id uuid PRIMARY KEY,
 event_id uuid NOT NULL UNIQUE REFERENCES meal.admin_error_events(id) DEFERRABLE INITIALLY DEFERRED,
 status text NOT NULL CHECK(status IN ('new','in_progress','resolved','ignored')),
 ignored_until timestamptz,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 assigned_to uuid REFERENCES meal.users(id) DEFERRABLE INITIALLY DEFERRED,
 updated_at timestamptz NOT NULL DEFAULT now(),
 version bigint NOT NULL DEFAULT 1 CHECK(version >= 1),
 CHECK((status = 'ignored') = (ignored_until IS NOT NULL))
);
COMMENT ON TABLE meal.admin_incident_states IS 'Mutable lifecycle metadata for append-only sanitized admin_error_events.';
CREATE INDEX admin_incident_states_status ON meal.admin_incident_states(status,updated_at,id);

CREATE TRIGGER admin_notification_settings_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.admin_notification_settings
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER admin_incident_states_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.admin_incident_states
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();

-- Application-role privileges are applied after all migrations from database/application-grants.sql.
