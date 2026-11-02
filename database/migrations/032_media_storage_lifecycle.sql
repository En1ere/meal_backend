-- Provider-neutral encrypted media storage reservations and quarantine metadata.
-- Binary objects remain outside PostgreSQL. Scanner/publication are intentionally not enabled here.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE meal.media_upload_reservations (
  asset_id uuid PRIMARY KEY,
  uploader_id uuid NOT NULL REFERENCES meal.users(id) ON DELETE RESTRICT,
  purpose varchar(32) NOT NULL CHECK (purpose IN (
    'diary_photo','support_attachment','allergen_icon','receipt_source',
    'export_file','billing_document','community_media','profile_avatar'
  )),
  file_name varchar(255) NOT NULL CHECK (btrim(file_name) <> ''),
  declared_mime varchar(200) NOT NULL CHECK (btrim(declared_mime) <> ''),
  declared_size bigint NOT NULL CHECK (declared_size BETWEEN 1 AND 52428800),
  retention_class varchar(64) NOT NULL CHECK (btrim(retention_class) <> ''),
  object_key text NOT NULL UNIQUE CHECK (object_key !~ '(^|/)\.\.(/|$)' AND object_key !~ '[[:cntrl:]]'),
  state varchar(20) NOT NULL CHECK (state IN ('reserved','uploading','quarantined','expired','failed','deleted')),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key uuid NOT NULL,
  access_key_id varchar(128) NOT NULL CHECK (access_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$'),
  token_nonce char(22) NOT NULL CHECK (token_nonce ~ '^[A-Za-z0-9_-]{22}$'),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  failure_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (uploader_id,idempotency_key),
  CHECK (expires_at > created_at),
  CHECK (state <> 'quarantined' OR completed_at IS NOT NULL),
  CHECK (completed_at IS NULL OR state IN ('quarantined','deleted')),
  CHECK (state <> 'failed' OR failure_code IS NOT NULL)
);

CREATE INDEX ix_media_upload_reservations_expiry
  ON meal.media_upload_reservations(expires_at,asset_id)
  WHERE state IN ('reserved','uploading');
CREATE INDEX ix_media_upload_reservations_uploader
  ON meal.media_upload_reservations(uploader_id,created_at DESC,asset_id);

CREATE TABLE meal.media_asset_bindings (
  asset_id uuid PRIMARY KEY REFERENCES meal.media_assets(id) ON DELETE RESTRICT,
  purpose varchar(32) NOT NULL CHECK (purpose IN (
    'diary_photo','support_attachment','allergen_icon','receipt_source',
    'export_file','billing_document','community_media','profile_avatar'
  )),
  storage_provider varchar(32) NOT NULL CHECK (storage_provider = 's3-compatible'),
  key_reference varchar(128) NOT NULL CHECK (key_reference ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$'),
  key_version smallint NOT NULL CHECK (key_version BETWEEN 1 AND 32767),
  algorithm varchar(32) NOT NULL CHECK (algorithm = 'aes-256-gcm'),
  nonce char(16) NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16}$'),
  authentication_tag char(22) NOT NULL CHECK (authentication_tag ~ '^[A-Za-z0-9_-]{22}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE FUNCTION meal.protect_media_upload_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.uploader_id IS DISTINCT FROM OLD.uploader_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.declared_mime IS DISTINCT FROM OLD.declared_mime
     OR NEW.declared_size IS DISTINCT FROM OLD.declared_size
     OR NEW.retention_class IS DISTINCT FROM OLD.retention_class
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.access_key_id IS DISTINCT FROM OLD.access_key_id
     OR NEW.token_nonce IS DISTINCT FROM OLD.token_nonce
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'media upload reservation identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'reserved' AND NEW.state IN ('uploading','expired','failed','deleted'))
    OR (OLD.state = 'uploading' AND NEW.state IN ('quarantined','expired','failed','deleted'))
    OR (OLD.state IN ('quarantined','expired','failed') AND NEW.state = 'deleted')
  ) THEN
    RAISE EXCEPTION 'invalid media upload reservation transition % -> %',OLD.state,NEW.state USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION meal.protect_bound_media_asset_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM meal.media_asset_bindings b WHERE b.asset_id = OLD.id) THEN
    IF NEW.object_key IS DISTINCT FROM OLD.object_key
       OR NEW.mime IS DISTINCT FROM OLD.mime
       OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
       OR NEW.checksum IS DISTINCT FROM OLD.checksum
       OR NEW.retention_class IS DISTINCT FROM OLD.retention_class
       OR NEW.uploader_id IS DISTINCT FROM OLD.uploader_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'bound media asset identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NOT (
       NEW.status = OLD.status
       OR (OLD.status = 'quarantined' AND NEW.status IN ('scanning','failed','deleted'))
       OR (OLD.status = 'scanning' AND NEW.status IN ('quarantined','clean','infected','failed','deleted'))
       OR (OLD.status = 'clean' AND NEW.status IN ('ready','failed','deleted'))
       OR (OLD.status IN ('ready','infected','failed') AND NEW.status = 'deleted')
    ) THEN
      RAISE EXCEPTION 'invalid bound media asset transition % -> %',OLD.status,NEW.status USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION meal.check_media_storage_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_asset uuid := COALESCE(NEW.asset_id,OLD.asset_id);
BEGIN
  IF EXISTS (SELECT 1 FROM meal.media_asset_bindings b WHERE b.asset_id = target_asset) AND NOT EXISTS (
    SELECT 1
    FROM meal.media_upload_reservations r
    JOIN meal.media_assets a ON a.id = r.asset_id
    JOIN meal.media_asset_bindings b ON b.asset_id = a.id
    WHERE r.asset_id = target_asset
      AND r.state IN ('quarantined','deleted')
      AND r.completed_at IS NOT NULL
      AND a.uploader_id = r.uploader_id
      AND a.object_key = r.object_key
      AND a.mime = r.declared_mime
      AND a.size_bytes = r.declared_size
      AND a.status = r.state
      AND a.retention_class = r.retention_class
      AND a.checksum ~ '^sha256:[0-9a-f]{64}$'
      AND b.purpose = r.purpose
  ) THEN
    RAISE EXCEPTION 'media binding does not match completed quarantined reservation' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.media_upload_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.media_asset_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER protect_reservation BEFORE UPDATE ON meal.media_upload_reservations
  FOR EACH ROW EXECUTE FUNCTION meal.protect_media_upload_reservation();
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON meal.media_asset_bindings
  FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE TRIGGER protect_bound_status BEFORE UPDATE ON meal.media_assets
  FOR EACH ROW EXECUTE FUNCTION meal.protect_bound_media_asset_status();
CREATE CONSTRAINT TRIGGER validate_binding_after_reservation
  AFTER INSERT OR UPDATE OR DELETE ON meal.media_upload_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal.check_media_storage_binding();
CREATE CONSTRAINT TRIGGER validate_binding_after_binding
  AFTER INSERT OR UPDATE OR DELETE ON meal.media_asset_bindings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal.check_media_storage_binding();

COMMENT ON TABLE meal.media_upload_reservations IS 'Idempotent owner-bound upload lifecycle; raw token and binary content are never stored in PostgreSQL.';
COMMENT ON TABLE meal.media_asset_bindings IS 'Append-only application-encryption envelope metadata for an external S3-compatible object.';
