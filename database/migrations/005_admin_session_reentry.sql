-- Prepared only: apply after Linux restore and separate approval. Migrations 001-004 are immutable.
ALTER TABLE meal.sessions ADD COLUMN admin_critical_until timestamptz;
ALTER TABLE meal.sessions ADD COLUMN admin_mfa_failures integer NOT NULL DEFAULT 0;
ALTER TABLE meal.sessions ADD CONSTRAINT sessions_admin_confirmation_scope CHECK (
 admin_critical_until IS NULL OR
 (kind='staff' AND auth_context IS NOT DISTINCT FROM 'admin' AND admin_critical_until<=expires_at)
);
ALTER TABLE meal.sessions ADD CONSTRAINT sessions_admin_mfa_failures_range
 CHECK(admin_mfa_failures BETWEEN 0 AND 5);

CREATE TABLE meal.admin_session_unlocks (
 id uuid PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES meal.sessions(id) DEFERRABLE INITIALLY DEFERRED,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX admin_session_unlocks_session ON meal.admin_session_unlocks(session_id);
COMMENT ON TABLE meal.admin_session_unlocks IS 'Hashed per-tab admin unlock proofs; remembered cookie alone grants no administrative access. Session revocation invalidates all proofs. No automatic retention cleanup.';
CREATE TRIGGER admin_session_unlocks_serializable BEFORE INSERT OR UPDATE OR DELETE
 ON meal.admin_session_unlocks FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER admin_session_unlocks_append_only BEFORE UPDATE OR DELETE
 ON meal.admin_session_unlocks FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();

CREATE FUNCTION meal.validate_admin_unlock_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM meal.sessions s WHERE s.id=NEW.session_id
   AND s.kind='staff' AND s.auth_context='admin' AND s.revoked_at IS NULL
   AND NEW.expires_at<=s.expires_at AND s.mfa_verified_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Invalid admin unlock scope' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER admin_session_unlocks_scope BEFORE INSERT ON meal.admin_session_unlocks
 FOR EACH ROW EXECUTE FUNCTION meal.validate_admin_unlock_scope();
-- auth_challenges.purpose is unrestricted text in v1: admin_login needs no constraint change.
