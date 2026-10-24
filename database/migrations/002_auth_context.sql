-- Additive migration. Existing sessions/challenges with NULL context are rejected by the new backend.
-- Run only with the reviewed migration plan; v1 stays unchanged.
ALTER TABLE meal.sessions ADD COLUMN auth_context text;
ALTER TABLE meal.sessions ADD CONSTRAINT sessions_auth_context_check CHECK (
    auth_context IS NULL OR (kind='user' AND auth_context='user') OR
    (kind='staff' AND auth_context IN ('admin','moderator') AND mfa_verified_at IS NOT NULL)
);
ALTER TABLE meal.auth_challenges ADD COLUMN auth_context text;
ALTER TABLE meal.auth_challenges ADD COLUMN factor_id uuid REFERENCES meal.mfa_factors(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE meal.auth_challenges ADD COLUMN revoked_at timestamptz;
ALTER TABLE meal.auth_challenges ALTER COLUMN attempts SET DEFAULT 0;
ALTER TABLE meal.auth_challenges ADD CONSTRAINT challenge_attempts_nonnegative CHECK (attempts IS NULL OR attempts>=0);
ALTER TABLE meal.auth_challenges ADD CONSTRAINT challenge_context_check CHECK (auth_context IS NULL OR auth_context IN ('admin','moderator'));
CREATE UNIQUE INDEX one_verified_totp_per_user ON meal.mfa_factors(user_id)
    WHERE kind='totp' AND verified_at IS NOT NULL AND revoked_at IS NULL;

CREATE FUNCTION meal.protect_auth_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.auth_context IS DISTINCT FROM OLD.auth_context THEN
  RAISE EXCEPTION 'Authentication context is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sessions_auth_context_immutable BEFORE UPDATE ON meal.sessions
 FOR EACH ROW EXECUTE FUNCTION meal.protect_auth_context();
CREATE TRIGGER challenges_auth_context_immutable BEFORE UPDATE ON meal.auth_challenges
 FOR EACH ROW EXECUTE FUNCTION meal.protect_auth_context();

CREATE TABLE meal.auth_rate_limits (
 key_hash text PRIMARY KEY,
 window_started_at timestamptz NOT NULL,
 attempts integer NOT NULL CHECK(attempts>0)
);
CREATE TRIGGER auth_rate_limits_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.auth_rate_limits
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
