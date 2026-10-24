CREATE TABLE meal.announcement_versions (
  id uuid PRIMARY KEY,
  announcement_id uuid NOT NULL REFERENCES meal.announcements(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  revision integer NOT NULL CHECK(revision > 0),
  content jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  CONSTRAINT uq_announcement_versions_revision UNIQUE(announcement_id, revision),
  CONSTRAINT uq_announcement_versions_identity UNIQUE(id, announcement_id)
);

CREATE TABLE meal.announcement_reads (
  id uuid PRIMARY KEY,
  announcement_id uuid NOT NULL REFERENCES meal.announcements(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  announcement_version_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  idempotency_key uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  CONSTRAINT fk_announcement_reads_version FOREIGN KEY(announcement_version_id, announcement_id)
    REFERENCES meal.announcement_versions(id, announcement_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT uq_announcement_reads_user_version UNIQUE(user_id, announcement_version_id),
  CONSTRAINT uq_announcement_reads_user_key UNIQUE(user_id, idempotency_key)
);

CREATE INDEX ix_announcement_versions_announcement ON meal.announcement_versions(announcement_id, revision DESC);
CREATE INDEX ix_announcement_reads_announcement ON meal.announcement_reads(announcement_id, read_at, id);
COMMENT ON TABLE meal.announcement_versions IS 'Immutable admin-authored news revisions including content, audience and selected channels';
COMMENT ON TABLE meal.announcement_reads IS 'Explicit authenticated display/read audit; closing an important reader is not consent or acknowledgement';
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.announcement_versions FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.announcement_reads FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON meal.announcement_versions FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON meal.announcement_reads FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
