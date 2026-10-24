-- Prepared only; apply with v2 after transfer and explicit approval. v1/v2 remain unchanged.
CREATE TABLE meal.account_tokens (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES meal.users(id) DEFERRABLE INITIALLY DEFERRED,
 kind text NOT NULL CHECK(kind IN ('verify','reset','email-confirm','email-cancel')),
 token_hash text NOT NULL UNIQUE, token_ciphertext text NOT NULL, email_target text NOT NULL,
 change_id uuid, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 used_at timestamptz, revoked_at timestamptz, CHECK(expires_at>created_at)
);
CREATE TABLE meal.account_email_changes (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES meal.users(id) DEFERRABLE INITIALLY DEFERRED,
 old_email text NOT NULL, new_email text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz, effective_at timestamptz, cancelled_at timestamptz, applied_at timestamptz,
 CHECK(old_email<>new_email), CHECK((confirmed_at IS NULL)=(effective_at IS NULL)),
 CHECK(effective_at IS NULL OR effective_at=confirmed_at+interval '24 hours')
);
ALTER TABLE meal.account_tokens ADD CONSTRAINT account_token_change_fk FOREIGN KEY(change_id)
 REFERENCES meal.account_email_changes(id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX account_pending_change_user ON meal.account_email_changes(user_id)
 WHERE cancelled_at IS NULL AND applied_at IS NULL;
CREATE UNIQUE INDEX account_pending_change_email ON meal.account_email_changes(new_email)
 WHERE cancelled_at IS NULL AND applied_at IS NULL;
CREATE TABLE meal.account_devices (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES meal.users(id) DEFERRABLE INITIALLY DEFERRED,
 device_hash text NOT NULL UNIQUE, pin_hash text NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE INDEX account_tokens_user_kind ON meal.account_tokens(user_id,kind);
CREATE INDEX account_devices_user ON meal.account_devices(user_id);
CREATE UNIQUE INDEX users_login_normalized_unique ON meal.users(lower(login));
CREATE FUNCTION meal.protect_account_login() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.login IS DISTINCT FROM OLD.login THEN RAISE EXCEPTION 'Username is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER users_login_immutable BEFORE UPDATE ON meal.users FOR EACH ROW EXECUTE FUNCTION meal.protect_account_login();
CREATE TRIGGER account_tokens_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.account_tokens
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER account_email_changes_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.account_email_changes
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER account_devices_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.account_devices
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
