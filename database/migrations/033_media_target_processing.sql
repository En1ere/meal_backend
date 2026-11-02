-- Additive media target binding and durable image-processing groundwork.
-- Runtime feature gates remain unchanged; this migration does not enable user uploads.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE meal.media_intakes (
  id uuid PRIMARY KEY,
  kind varchar(32) NOT NULL CHECK (kind IN ('inventory_scan','receipt_photo')),
  state varchar(24) NOT NULL DEFAULT 'awaiting_upload' CHECK (state IN (
    'awaiting_upload','processing','review_required','completed','failed','cancelled'
  )),
  user_id uuid NOT NULL REFERENCES meal.users(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  scope_id uuid REFERENCES meal.data_scopes(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  idempotency_key uuid NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  failure_code varchar(64),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (user_id,idempotency_key),
  CHECK (state <> 'failed' OR failure_code IS NOT NULL),
  CHECK (completed_at IS NULL OR state IN ('completed','failed','cancelled'))
);

COMMENT ON TABLE meal.media_intakes IS
  'Pre-domain owner/scope-bound image intake. A receipt or inventory mutation is created only after explicit review.';

CREATE FUNCTION meal.protect_media_intake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'media intake identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'awaiting_upload' AND NEW.state IN ('processing','failed','cancelled'))
    OR (OLD.state = 'processing' AND NEW.state IN ('review_required','failed','cancelled'))
    OR (OLD.state = 'review_required' AND NEW.state IN ('processing','completed','failed','cancelled'))
  ) THEN
    RAISE EXCEPTION 'invalid media intake transition % -> %',OLD.state,NEW.state USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE meal.media_upload_reservations
  DROP CONSTRAINT IF EXISTS media_upload_reservations_purpose_check;
ALTER TABLE meal.media_upload_reservations
  ADD CONSTRAINT media_upload_reservations_purpose_check CHECK (purpose IN (
    'diary_photo','support_attachment','allergen_icon','receipt_source','inventory_source',
    'export_file','billing_document','community_media','profile_avatar'
  ));

ALTER TABLE meal.media_asset_bindings
  DROP CONSTRAINT IF EXISTS media_asset_bindings_purpose_check;
ALTER TABLE meal.media_asset_bindings
  ADD CONSTRAINT media_asset_bindings_purpose_check CHECK (purpose IN (
    'diary_photo','support_attachment','allergen_icon','receipt_source','inventory_source',
    'export_file','billing_document','community_media','profile_avatar'
  ));

ALTER TABLE meal.media_upload_reservations
  ADD COLUMN target_binding_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN intake_id uuid,
  ADD COLUMN diary_entry_id uuid,
  ADD COLUMN support_message_id uuid,
  ADD COLUMN avatar_user_id uuid,
  ADD COLUMN target_slot varchar(32),
  ADD COLUMN target_position smallint;

-- Preserve any v32 rows without pretending that they were domain-authorized. New rows use v1 by default.
UPDATE meal.media_upload_reservations SET target_binding_version=0;

ALTER TABLE meal.media_upload_reservations
  ADD CONSTRAINT fk_media_reservation_intake FOREIGN KEY (intake_id)
    REFERENCES meal.media_intakes(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_media_reservation_diary_entry FOREIGN KEY (diary_entry_id)
    REFERENCES meal.diary_entries(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_media_reservation_support_message FOREIGN KEY (support_message_id)
    REFERENCES meal.support_messages(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_media_reservation_avatar_user FOREIGN KEY (avatar_user_id)
    REFERENCES meal.users(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT ck_media_reservation_target_binding CHECK (
    (target_binding_version=0
      AND num_nonnulls(intake_id,diary_entry_id,support_message_id,avatar_user_id)=0
      AND target_slot IS NULL AND target_position IS NULL)
    OR
    (target_binding_version=1 AND (
      (purpose IN ('receipt_source','inventory_source') AND intake_id IS NOT NULL
        AND num_nonnulls(diary_entry_id,support_message_id,avatar_user_id)=0)
      OR (purpose='diary_photo' AND diary_entry_id IS NOT NULL
        AND num_nonnulls(intake_id,support_message_id,avatar_user_id)=0)
      OR (purpose='support_attachment' AND support_message_id IS NOT NULL
        AND num_nonnulls(intake_id,diary_entry_id,avatar_user_id)=0)
      OR (purpose='profile_avatar' AND avatar_user_id IS NOT NULL
        AND num_nonnulls(intake_id,diary_entry_id,support_message_id)=0)
      OR (purpose IN ('allergen_icon','export_file','billing_document','community_media')
        AND num_nonnulls(intake_id,diary_entry_id,support_message_id,avatar_user_id)=0)
    ) AND (
      (num_nonnulls(intake_id,diary_entry_id,support_message_id,avatar_user_id)=1
        AND target_slot IS NOT NULL AND btrim(target_slot)<>'' AND target_position BETWEEN 0 AND 99)
      OR (num_nonnulls(intake_id,diary_entry_id,support_message_id,avatar_user_id)=0
        AND target_slot IS NULL AND target_position IS NULL)
    ))
  ),
  ADD CONSTRAINT ck_media_reservation_bound_images CHECK (
    target_binding_version=0
    OR num_nonnulls(intake_id,diary_entry_id,support_message_id,avatar_user_id)=0
    OR (declared_mime IN ('image/jpeg','image/png','image/webp')
      AND declared_size <= CASE WHEN purpose='profile_avatar' THEN 5242880 ELSE 10485760 END)
  );

CREATE OR REPLACE FUNCTION meal.protect_media_upload_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.target_binding_version IS DISTINCT FROM OLD.target_binding_version
     OR NEW.intake_id IS DISTINCT FROM OLD.intake_id
     OR NEW.diary_entry_id IS DISTINCT FROM OLD.diary_entry_id
     OR NEW.support_message_id IS DISTINCT FROM OLD.support_message_id
     OR NEW.avatar_user_id IS DISTINCT FROM OLD.avatar_user_id
     OR NEW.target_slot IS DISTINCT FROM OLD.target_slot
     OR NEW.target_position IS DISTINCT FROM OLD.target_position THEN
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

CREATE FUNCTION meal.check_media_reservation_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reservation meal.media_upload_reservations%ROWTYPE;
  target_asset uuid := COALESCE(NEW.asset_id,OLD.asset_id);
  matching_links integer;
  all_links integer;
  matching_sources integer;
  all_sources integer;
BEGIN
  SELECT * INTO reservation FROM meal.media_upload_reservations WHERE asset_id=target_asset;
  IF NOT FOUND OR reservation.target_binding_version=0 THEN RETURN NULL; END IF;

  IF reservation.intake_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM meal.media_intakes i WHERE i.id=reservation.intake_id
      AND i.user_id=reservation.uploader_id
      AND ((reservation.purpose='receipt_source' AND i.kind='receipt_photo')
        OR (reservation.purpose='inventory_source' AND i.kind='inventory_scan'))
  ) THEN RAISE EXCEPTION 'media intake target does not match reservation' USING ERRCODE='23514'; END IF;

  IF reservation.diary_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM meal.diary_entries d WHERE d.id=reservation.diary_entry_id
      AND d.owner_id=reservation.uploader_id
  ) THEN RAISE EXCEPTION 'media diary target does not match reservation' USING ERRCODE='23514'; END IF;

  IF reservation.support_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM meal.support_messages m JOIN meal.support_tickets t ON t.id=m.ticket_id
    WHERE m.id=reservation.support_message_id AND m.author_id=reservation.uploader_id
      AND m.internal=false AND t.requester_id=reservation.uploader_id
  ) THEN RAISE EXCEPTION 'media support target does not match reservation' USING ERRCODE='23514'; END IF;

  IF reservation.avatar_user_id IS NOT NULL AND reservation.avatar_user_id<>reservation.uploader_id THEN
    RAISE EXCEPTION 'media avatar target does not match reservation' USING ERRCODE='23514';
  END IF;

  SELECT count(*)::integer INTO all_links FROM meal.media_links WHERE asset_id=target_asset;
  SELECT count(*)::integer INTO matching_links FROM meal.media_links l WHERE l.asset_id=target_asset
    AND l.slot=reservation.target_slot AND l.position=reservation.target_position
    AND l.receipt_id IS NULL AND l.note_id IS NULL AND l.recipe_revision_id IS NULL
    AND l.chat_message_id IS NULL AND l.comment_id IS NULL AND l.catalog_proposal_id IS NULL
    AND l.announcement_id IS NULL AND l.product_id IS NULL AND l.batch_id IS NULL
    AND l.diary_entry_id IS NOT DISTINCT FROM reservation.diary_entry_id
    AND l.support_message_id IS NOT DISTINCT FROM reservation.support_message_id
    AND l.avatar_user_id IS NOT DISTINCT FROM reservation.avatar_user_id;

  SELECT count(*)::integer INTO all_sources FROM meal.media_intake_sources s WHERE s.asset_id=target_asset;
  SELECT count(*)::integer INTO matching_sources FROM meal.media_intake_sources s
    WHERE s.asset_id=target_asset AND s.intake_id=reservation.intake_id
      AND s.slot=reservation.target_slot AND s.position=reservation.target_position;

  IF reservation.intake_id IS NOT NULL THEN
    IF all_links<>0 THEN RAISE EXCEPTION 'intake media must bind through its intake, not media_links' USING ERRCODE='23514'; END IF;
    IF reservation.state IN ('quarantined','deleted') THEN
      IF all_sources<>1 OR matching_sources<>1 THEN
        RAISE EXCEPTION 'completed intake reservation requires one exact intake source' USING ERRCODE='23514';
      END IF;
    ELSIF all_sources<>0 THEN
      RAISE EXCEPTION 'media intake source exists before durable upload completion' USING ERRCODE='23514';
    END IF;
  ELSIF reservation.diary_entry_id IS NOT NULL OR reservation.support_message_id IS NOT NULL
     OR reservation.avatar_user_id IS NOT NULL THEN
    IF reservation.state IN ('quarantined','deleted') THEN
      IF all_links<>1 OR matching_links<>1 THEN
        RAISE EXCEPTION 'completed media reservation requires one exact domain link' USING ERRCODE='23514';
      END IF;
    ELSIF all_links<>0 THEN
      RAISE EXCEPTION 'media link exists before durable upload completion' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION meal.protect_bound_media_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_asset uuid := COALESCE(NEW.asset_id,OLD.asset_id);
BEGIN
  IF EXISTS (SELECT 1 FROM meal.media_upload_reservations r
             WHERE r.asset_id=target_asset AND r.target_binding_version=1
               AND num_nonnulls(r.diary_entry_id,r.support_message_id,r.avatar_user_id)=1) THEN
    RAISE EXCEPTION 'bound media link is append-only' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE INDEX ix_media_reservation_active_user
  ON meal.media_upload_reservations(uploader_id,state,expires_at,asset_id)
  WHERE state IN ('reserved','uploading');
CREATE INDEX ix_media_reservation_reconcile
  ON meal.media_upload_reservations(updated_at,asset_id)
  WHERE state='uploading' AND failure_code='reconciliation_required';
CREATE INDEX ix_media_reservation_intake ON meal.media_upload_reservations(intake_id) WHERE intake_id IS NOT NULL;
CREATE INDEX ix_media_reservation_diary ON meal.media_upload_reservations(diary_entry_id) WHERE diary_entry_id IS NOT NULL;
CREATE INDEX ix_media_reservation_support ON meal.media_upload_reservations(support_message_id) WHERE support_message_id IS NOT NULL;
CREATE INDEX ix_media_reservation_avatar ON meal.media_upload_reservations(avatar_user_id) WHERE avatar_user_id IS NOT NULL;
CREATE INDEX ix_media_intakes_user_created ON meal.media_intakes(user_id,created_at DESC,id);
CREATE INDEX ix_media_intakes_scope_state ON meal.media_intakes(scope_id,state,created_at,id) WHERE scope_id IS NOT NULL;
CREATE INDEX ix_media_links_diary ON meal.media_links(diary_entry_id,position,id) WHERE diary_entry_id IS NOT NULL;
CREATE INDEX ix_media_links_support ON meal.media_links(support_message_id,position,id) WHERE support_message_id IS NOT NULL;
CREATE INDEX ix_media_links_avatar ON meal.media_links(avatar_user_id,position,id) WHERE avatar_user_id IS NOT NULL;

CREATE TABLE meal.media_intake_sources (
  id uuid PRIMARY KEY,
  intake_id uuid NOT NULL REFERENCES meal.media_intakes(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  asset_id uuid NOT NULL UNIQUE REFERENCES meal.media_assets(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  slot varchar(32) NOT NULL CHECK (btrim(slot)<>''),
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 99),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(intake_id,slot,position)
);
CREATE INDEX ix_media_intake_sources_intake ON meal.media_intake_sources(intake_id,position,id);

CREATE TABLE meal.media_processing_jobs (
  id uuid PRIMARY KEY,
  kind varchar(32) NOT NULL CHECK (kind IN ('malware_scan','image_cdr','ocr')),
  status varchar(24) NOT NULL CHECK (status IN ('queued','processing','succeeded','failed','manual_review','cancelled')),
  asset_id uuid NOT NULL REFERENCES meal.media_assets(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  intake_id uuid REFERENCES meal.media_intakes(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  policy_version varchar(64) NOT NULL CHECK (btrim(policy_version)<>''),
  source_checksum varchar(71) NOT NULL CHECK (source_checksum ~ '^sha256:[0-9a-f]{64}$'),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(64),
  lease_token uuid,
  lease_until timestamptz,
  result_code varchar(64),
  result_evidence jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  UNIQUE(asset_id,kind,policy_version),
  CHECK (lease_owner IS NULL OR lease_owner ~ '^[a-z][a-z0-9-]{2,63}$'),
  CHECK ((lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL)
      OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (status='processing' OR (lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK (kind<>'ocr' OR intake_id IS NOT NULL),
  CHECK ((completed_at IS NOT NULL) = (status IN ('succeeded','failed','manual_review','cancelled'))),
  CHECK (result_evidence IS NULL OR (jsonb_typeof(result_evidence)='object' AND pg_column_size(result_evidence)<=262144))
);

CREATE FUNCTION meal.protect_media_processing_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.intake_id IS DISTINCT FROM OLD.intake_id
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.source_checksum IS DISTINCT FROM OLD.source_checksum OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'media processing job identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT (NEW.status=OLD.status
    OR (OLD.status='queued' AND NEW.status IN ('processing','cancelled'))
    OR (OLD.status='processing' AND NEW.status IN ('queued','succeeded','failed','manual_review','cancelled'))
    OR (OLD.status='manual_review' AND NEW.status IN ('queued','succeeded','failed','cancelled'))) THEN
    RAISE EXCEPTION 'invalid media processing transition % -> %',OLD.status,NEW.status USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION meal.check_media_processing_job_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM meal.media_processing_jobs j JOIN meal.media_assets a ON a.id=j.asset_id
    WHERE j.id=COALESCE(NEW.id,OLD.id) AND a.checksum=j.source_checksum
      AND (j.intake_id IS NULL OR EXISTS (
        SELECT 1 FROM meal.media_intake_sources s WHERE s.intake_id=j.intake_id AND s.asset_id=j.asset_id
      ))
  ) THEN RAISE EXCEPTION 'media processing job source evidence is inconsistent' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

CREATE INDEX ix_media_processing_jobs_due ON meal.media_processing_jobs(available_at,id)
  WHERE status='queued';
CREATE INDEX ix_media_processing_jobs_lease ON meal.media_processing_jobs(lease_until,id)
  WHERE status='processing';
CREATE INDEX ix_media_processing_jobs_intake ON meal.media_processing_jobs(intake_id,created_at,id)
  WHERE intake_id IS NOT NULL;

CREATE TABLE meal.media_variant_bindings (
  variant_id uuid PRIMARY KEY REFERENCES meal.media_variants(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  processing_job_id uuid NOT NULL UNIQUE REFERENCES meal.media_processing_jobs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  source_checksum varchar(71) NOT NULL CHECK (source_checksum ~ '^sha256:[0-9a-f]{64}$'),
  variant_checksum varchar(71) NOT NULL CHECK (variant_checksum ~ '^sha256:[0-9a-f]{64}$'),
  key_reference varchar(128) NOT NULL CHECK (key_reference ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$'),
  key_version smallint NOT NULL CHECK (key_version BETWEEN 1 AND 32767),
  algorithm varchar(32) NOT NULL CHECK (algorithm='aes-256-gcm'),
  nonce char(16) NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16}$'),
  authentication_tag char(22) NOT NULL CHECK (authentication_tag ~ '^[A-Za-z0-9_-]{22}$'),
  transformation_policy varchar(64) NOT NULL CHECK (btrim(transformation_policy)<>''),
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0)
);

CREATE TABLE meal.media_variant_evidence (
  id uuid PRIMARY KEY,
  variant_id uuid NOT NULL REFERENCES meal.media_variants(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  processing_job_id uuid NOT NULL REFERENCES meal.media_processing_jobs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  kind varchar(32) NOT NULL CHECK (kind IN ('decode','metadata_strip','sanitize','encode')),
  outcome varchar(20) NOT NULL CHECK (outcome IN ('passed','failed','manual_review')),
  policy_version varchar(64) NOT NULL CHECK (btrim(policy_version)<>''),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND pg_column_size(evidence)<=262144),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION meal.check_media_variant_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM meal.media_variant_bindings b
    JOIN meal.media_variants v ON v.id=b.variant_id
    JOIN meal.media_assets a ON a.id=v.asset_id
    JOIN meal.media_processing_jobs j ON j.id=b.processing_job_id
    WHERE b.variant_id=COALESCE(NEW.variant_id,OLD.variant_id)
      AND j.asset_id=v.asset_id AND j.status='succeeded'
      AND j.kind='image_cdr' AND j.source_checksum=b.source_checksum
      AND a.checksum=b.source_checksum AND v.mime IN ('image/jpeg','image/png','image/webp')
      AND v.size_bytes>0 AND v.object_key<>a.object_key
  ) THEN
    RAISE EXCEPTION 'derived media variant binding evidence is inconsistent' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION meal.check_media_variant_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM meal.media_variant_bindings b WHERE b.variant_id=NEW.variant_id
      AND b.processing_job_id=NEW.processing_job_id
  ) THEN RAISE EXCEPTION 'media variant evidence is not bound to its processing job' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

ALTER TABLE meal.recognition_jobs ADD COLUMN intake_id uuid;
ALTER TABLE meal.recognition_jobs ADD CONSTRAINT fk_recognition_jobs_intake FOREIGN KEY (intake_id)
  REFERENCES meal.media_intakes(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX uq_recognition_jobs_intake ON meal.recognition_jobs(intake_id) WHERE intake_id IS NOT NULL;

CREATE FUNCTION meal.protect_recognition_job_intake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intake_id IS DISTINCT FROM OLD.intake_id THEN
    RAISE EXCEPTION 'recognition job intake is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE meal.recognition_review_snapshots (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES meal.recognition_jobs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  revision integer NOT NULL CHECK (revision>0),
  decision varchar(20) NOT NULL CHECK (decision IN ('confirmed','rejected','applied')),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields)='object' AND pg_column_size(fields)<=1048576),
  source_checksum varchar(71) NOT NULL CHECK (source_checksum ~ '^sha256:[0-9a-f]{64}$'),
  reviewed_by uuid NOT NULL REFERENCES meal.users(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  reviewed_at timestamptz NOT NULL,
  idempotency_key uuid NOT NULL,
  previous_snapshot_id uuid REFERENCES meal.recognition_review_snapshots(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,revision),
  UNIQUE(reviewed_by,idempotency_key),
  CHECK ((revision=1 AND previous_snapshot_id IS NULL) OR (revision>1 AND previous_snapshot_id IS NOT NULL))
);

CREATE FUNCTION meal.check_recognition_review_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.previous_snapshot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM meal.recognition_review_snapshots p
    WHERE p.id=NEW.previous_snapshot_id AND p.job_id=NEW.job_id AND p.revision=NEW.revision-1
  ) THEN RAISE EXCEPTION 'recognition review snapshot chain is invalid' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM meal.recognition_jobs j JOIN meal.media_intakes i ON i.id=j.intake_id
    WHERE j.id=NEW.job_id AND i.user_id=NEW.reviewed_by
  ) THEN RAISE EXCEPTION 'recognition review actor does not own the intake' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM meal.recognition_sources s JOIN meal.media_assets a ON a.id=s.asset_id
    WHERE s.job_id=NEW.job_id AND a.checksum=NEW.source_checksum
  ) THEN RAISE EXCEPTION 'recognition review source checksum is not durable' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

CREATE TABLE meal.media_reconciliation_attempts (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES meal.media_upload_reservations(asset_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  provider_outcome varchar(16) NOT NULL CHECK (provider_outcome IN ('present','missing','unknown')),
  database_outcome varchar(24) NOT NULL CHECK (database_outcome IN ('absent','complete','partial','mismatch')),
  action varchar(24) NOT NULL CHECK (action IN ('confirm_quarantined','confirm_failed','defer','manual_review')),
  reason varchar(64) NOT NULL CHECK (btrim(reason)<>''),
  observed_content_length bigint CHECK (observed_content_length IS NULL OR observed_content_length>=0),
  evidence_hash char(64) CHECK (evidence_hash IS NULL OR evidence_hash ~ '^[0-9a-f]{64}$'),
  policy_version varchar(64) NOT NULL CHECK (btrim(policy_version)<>''),
  worker_owner varchar(64) NOT NULL CHECK (worker_owner ~ '^[a-z][a-z0-9-]{2,63}$'),
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_media_reconciliation_asset ON meal.media_reconciliation_attempts(asset_id,attempted_at DESC,id);

CREATE TRIGGER media_intakes_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.media_intakes
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER media_intakes_protect BEFORE UPDATE ON meal.media_intakes
  FOR EACH ROW EXECUTE FUNCTION meal.protect_media_intake();
CREATE TRIGGER media_intake_sources_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.media_intake_sources
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER media_intake_sources_immutable BEFORE UPDATE OR DELETE ON meal.media_intake_sources
  FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE TRIGGER media_processing_jobs_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.media_processing_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER media_processing_jobs_protect BEFORE UPDATE ON meal.media_processing_jobs
  FOR EACH ROW EXECUTE FUNCTION meal.protect_media_processing_job();
CREATE TRIGGER media_processing_jobs_no_delete BEFORE DELETE ON meal.media_processing_jobs
  FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE TRIGGER recognition_job_intake_protect BEFORE UPDATE ON meal.recognition_jobs
  FOR EACH ROW EXECUTE FUNCTION meal.protect_recognition_job_intake();
CREATE TRIGGER media_variant_bindings_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.media_variant_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER media_variant_bindings_immutable BEFORE UPDATE OR DELETE ON meal.media_variant_bindings
  FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE TRIGGER media_variant_evidence_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.media_variant_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER media_variant_evidence_immutable BEFORE UPDATE OR DELETE ON meal.media_variant_evidence
  FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE TRIGGER recognition_review_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.recognition_review_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER recognition_review_immutable BEFORE UPDATE OR DELETE ON meal.recognition_review_snapshots
  FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE TRIGGER media_reconciliation_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.media_reconciliation_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER media_reconciliation_immutable BEFORE UPDATE OR DELETE ON meal.media_reconciliation_attempts
  FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE TRIGGER protect_bound_media_link BEFORE UPDATE OR DELETE ON meal.media_links
  FOR EACH ROW EXECUTE FUNCTION meal.protect_bound_media_link();

CREATE CONSTRAINT TRIGGER validate_media_target_after_reservation
  AFTER INSERT OR UPDATE OR DELETE ON meal.media_upload_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal.check_media_reservation_target();
CREATE CONSTRAINT TRIGGER validate_media_target_after_link
  AFTER INSERT OR UPDATE OR DELETE ON meal.media_links
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal.check_media_reservation_target();
CREATE CONSTRAINT TRIGGER validate_media_target_after_intake_source
  AFTER INSERT OR UPDATE OR DELETE ON meal.media_intake_sources
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal.check_media_reservation_target();
CREATE CONSTRAINT TRIGGER validate_media_variant_binding
  AFTER INSERT OR UPDATE OR DELETE ON meal.media_variant_bindings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal.check_media_variant_binding();
CREATE CONSTRAINT TRIGGER validate_media_processing_job_source
  AFTER INSERT OR UPDATE OR DELETE ON meal.media_processing_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal.check_media_processing_job_source();
CREATE CONSTRAINT TRIGGER validate_media_variant_evidence
  AFTER INSERT ON meal.media_variant_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal.check_media_variant_evidence();
CREATE CONSTRAINT TRIGGER validate_recognition_review_snapshot
  AFTER INSERT ON meal.recognition_review_snapshots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal.check_recognition_review_snapshot();

COMMENT ON TABLE meal.media_processing_jobs IS 'Durable bounded scanner/sanitizer/OCR work queue; raw provider payloads and credentials are forbidden.';
COMMENT ON TABLE meal.media_intake_sources IS 'Append-only exact binding from a pre-domain intake slot to one encrypted source asset.';
COMMENT ON TABLE meal.media_variant_bindings IS 'Append-only encryption envelope and checksum binding for a sanitized derived object.';
COMMENT ON TABLE meal.media_variant_evidence IS 'Append-only categorical evidence for image decode, metadata stripping, sanitization and encoding.';
COMMENT ON TABLE meal.recognition_review_snapshots IS 'Append-only human-reviewed OCR snapshot chain; applying a snapshot is a separate domain transaction.';
COMMENT ON TABLE meal.media_reconciliation_attempts IS 'Append-only exact-key provider/database reconciliation evidence; it never authorizes publication.';
