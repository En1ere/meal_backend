-- Durable, lease-protected transactional account-mail delivery.
-- Existing pending ciphertext uses the MFA key and is revoked before the dedicated mail-key format is enabled.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE meal.account_tokens
  ADD COLUMN cipher_key_version smallint NOT NULL DEFAULT 1
  CHECK (cipher_key_version IN (1,2));

UPDATE meal.account_tokens
SET revoked_at = now()
WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE meal.account_mail_deliveries (
  id uuid PRIMARY KEY,
  account_token_id uuid NOT NULL UNIQUE REFERENCES meal.account_tokens(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES meal.users(id) ON DELETE RESTRICT,
  recipient varchar(254) NOT NULL,
  kind varchar(20) NOT NULL CHECK (kind IN ('verify','reset','email-confirm','email-cancel')),
  change_id uuid REFERENCES meal.account_email_changes(id) ON DELETE RESTRICT,
  status varchar(24) NOT NULL CHECK (status IN ('queued','processing','accepted','retry_scheduled','unknown','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(64),
  lease_token uuid,
  lease_until timestamptz,
  message_id varchar(320) NOT NULL UNIQUE,
  provider_reference varchar(500),
  last_error_code varchar(64),
  accepted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (message_id = '<' || id::text || '@transactional.meal-planner.invalid>'),
  CHECK ((status = 'processing') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (status = 'processing' OR (lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK (status NOT IN ('accepted','unknown','failed','skipped') OR completed_at IS NOT NULL),
  CHECK (status <> 'accepted' OR (accepted_at IS NOT NULL AND provider_reference IS NOT NULL))
);

CREATE INDEX ix_account_mail_deliveries_due
  ON meal.account_mail_deliveries(available_at,id)
  WHERE status IN ('queued','retry_scheduled');
CREATE INDEX ix_account_mail_deliveries_expired_lease
  ON meal.account_mail_deliveries(lease_until,id)
  WHERE status = 'processing';

CREATE TABLE meal.account_mail_attempts (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES meal.account_mail_deliveries(id) ON DELETE RESTRICT,
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 10),
  outcome varchar(24) NOT NULL CHECK (outcome IN ('accepted','retry_scheduled','unknown','failed','skipped')),
  message_id varchar(320) NOT NULL,
  error_code varchar(64),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id,attempt_no)
);

CREATE FUNCTION meal.check_account_mail_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM meal.account_tokens t
    WHERE t.id = NEW.account_token_id
      AND t.user_id = NEW.user_id
      AND t.kind = NEW.kind
      AND t.email_target = NEW.recipient
      AND t.change_id IS NOT DISTINCT FROM NEW.change_id
      AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()
      AND t.cipher_key_version = 2
  ) THEN
    RAISE EXCEPTION 'account mail delivery does not match an active dedicated-key token' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.account_mail_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.account_mail_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER validate_token BEFORE INSERT ON meal.account_mail_deliveries
  FOR EACH ROW EXECUTE FUNCTION meal.check_account_mail_delivery();
CREATE TRIGGER protect_identity BEFORE UPDATE ON meal.account_mail_deliveries
  FOR EACH ROW EXECUTE FUNCTION meal.protect_scope_and_identity();
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON meal.account_mail_attempts
  FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();

COMMENT ON TABLE meal.account_mail_deliveries IS 'Durable account security mail queue; unknown SMTP acceptance is terminal until explicit reconciliation.';
COMMENT ON TABLE meal.account_mail_attempts IS 'Append-only sanitized mail delivery attempt history without tokens or provider payloads.';
