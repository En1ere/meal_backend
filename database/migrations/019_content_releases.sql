-- Prepared only. Applying this migration requires the separately approved transfer procedure.
ALTER TABLE meal.achievement_rules
  ADD COLUMN title text,
  ADD COLUMN description text,
  ADD COLUMN icon_metadata jsonb,
  ADD COLUMN reputation_delta integer NOT NULL DEFAULT 0,
  ADD COLUMN secret boolean NOT NULL DEFAULT false,
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN published_release_id uuid;

CREATE TABLE meal.content_releases (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  source_release_id uuid,
  rolled_back_from_event_id uuid,
  client_revision bigint,
  client_checksum text,
  created_by uuid NOT NULL REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  published_by uuid REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT ck_content_releases_status CHECK (status IN ('draft','published')),
  CONSTRAINT ck_content_releases_version CHECK (version > 0),
  CONSTRAINT ck_content_releases_revision CHECK (revision > 0)
);

CREATE TABLE meal.content_release_patches (
  id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES meal.content_releases(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ordinal integer NOT NULL,
  resource_type text NOT NULL,
  action text NOT NULL,
  resource_key text NOT NULL,
  expected_version bigint NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT ck_content_release_patches_type CHECK (resource_type IN ('achievement','reputation_title','legal_text','product_description')),
  CONSTRAINT ck_content_release_patches_action CHECK (action IN ('create','update','retire')),
  CONSTRAINT ck_content_release_patches_expected CHECK (expected_version >= 0),
  CONSTRAINT ck_content_release_patches_version CHECK (version > 0),
  UNIQUE(release_id,ordinal),
  UNIQUE(release_id,id)
);

CREATE TABLE meal.content_release_events (
  id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES meal.content_releases(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  kind text NOT NULL,
  snapshot jsonb NOT NULL,
  inverse_snapshot jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT ck_content_release_events_kind CHECK (kind IN ('published','rolled_back')),
  CONSTRAINT ck_content_release_events_version CHECK (version > 0)
);

CREATE TABLE meal.content_resource_heads (
  resource_type text NOT NULL,
  resource_key text NOT NULL,
  payload jsonb,
  retired boolean NOT NULL DEFAULT false,
  published_release_id uuid NOT NULL REFERENCES meal.content_releases(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY(resource_type,resource_key),
  CONSTRAINT ck_content_resource_heads_type CHECK (resource_type IN ('achievement','reputation_title','legal_text','product_description')),
  CONSTRAINT ck_content_resource_heads_version CHECK (version > 0)
);

CREATE TABLE meal.reputation_titles (
  id uuid PRIMARY KEY,
  level integer NOT NULL,
  threshold bigint NOT NULL,
  title text NOT NULL,
  published_release_id uuid NOT NULL REFERENCES meal.content_releases(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT ck_reputation_titles_level CHECK (level BETWEEN 1 AND 10),
  CONSTRAINT ck_reputation_titles_threshold CHECK (threshold >= 0),
  CONSTRAINT ck_reputation_titles_version CHECK (version > 0),
  UNIQUE(level),
  UNIQUE(threshold)
);

CREATE TABLE meal.product_descriptions (
  product_id uuid PRIMARY KEY REFERENCES meal.brand_products(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  description text NOT NULL,
  published_release_id uuid NOT NULL REFERENCES meal.content_releases(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT ck_product_descriptions_version CHECK (version > 0)
);

CREATE TABLE meal.reputation_rule_versions (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  revision integer NOT NULL,
  points integer NOT NULL,
  per_subject_cap integer,
  condition jsonb NOT NULL,
  enabled boolean NOT NULL,
  published_release_id uuid NOT NULL REFERENCES meal.content_releases(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT ck_reputation_rule_versions_revision CHECK (revision > 0),
  CONSTRAINT ck_reputation_rule_versions_points CHECK (points >= 0),
  CONSTRAINT ck_reputation_rule_versions_cap CHECK (per_subject_cap IS NULL OR per_subject_cap > 0),
  CONSTRAINT ck_reputation_rule_versions_version CHECK (version > 0),
  UNIQUE(code,revision)
);

ALTER TABLE meal.content_releases ADD CONSTRAINT fk_content_releases_source FOREIGN KEY(source_release_id) REFERENCES meal.content_releases(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE meal.content_releases ADD CONSTRAINT fk_content_releases_rollback_event FOREIGN KEY(rolled_back_from_event_id) REFERENCES meal.content_release_events(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE meal.achievement_rules ADD CONSTRAINT fk_achievement_rules_release FOREIGN KEY(published_release_id) REFERENCES meal.content_releases(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX ix_content_release_events_release ON meal.content_release_events(release_id,created_at,id);
CREATE INDEX ix_content_release_patches_release ON meal.content_release_patches(release_id,ordinal);
CREATE INDEX ix_achievement_rules_active_code ON meal.achievement_rules(code,revision DESC) WHERE enabled AND retired_at IS NULL;
CREATE INDEX ix_achievement_awards_user_awarded ON meal.achievement_awards(user_id,awarded_at DESC,id);
CREATE INDEX ix_reputation_events_user_recorded ON meal.reputation_events(user_id,recorded_at DESC,id);
CREATE UNIQUE INDEX uq_reputation_events_qualifying ON meal.reputation_events(user_id,(evidence->>'qualifyingEventKey')) WHERE reverses_id IS NULL;
CREATE UNIQUE INDEX uq_reputation_events_reversal ON meal.reputation_events(reverses_id) WHERE reverses_id IS NOT NULL;

ALTER TABLE meal.achievement_awards ADD COLUMN achievement_key text;
WITH ranked AS (
  SELECT aa.id,ar.code,row_number() OVER(PARTITION BY aa.user_id,ar.code ORDER BY aa.awarded_at,aa.id) ordinal
  FROM meal.achievement_awards aa JOIN meal.achievement_rules ar ON ar.id=aa.rule_id
)
UPDATE meal.achievement_awards aa SET achievement_key=CASE WHEN ranked.ordinal=1 THEN ranked.code ELSE ranked.code||':legacy:'||aa.id::text END
FROM ranked WHERE ranked.id=aa.id;
ALTER TABLE meal.achievement_awards ALTER COLUMN achievement_key SET NOT NULL;
CREATE UNIQUE INDEX uq_achievement_awards_user_key ON meal.achievement_awards(user_id,achievement_key);

CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.content_releases FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.content_release_patches FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.content_release_events FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.content_resource_heads FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.reputation_titles FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.product_descriptions FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.reputation_rule_versions FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON meal.content_release_events FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON meal.reputation_rule_versions FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();

COMMENT ON TABLE meal.content_releases IS 'Server-owned atomic content release draft. Operational moderation never uses this lock.';
COMMENT ON TABLE meal.content_release_events IS 'Immutable publish and rollback snapshots; history is never erased.';
COMMENT ON TABLE meal.reputation_rule_versions IS 'Versioned reputation formula; publishing a new rule never silently recalculates old ledger entries.';
