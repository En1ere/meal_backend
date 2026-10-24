ALTER TABLE meal.author_follows ADD COLUMN removed_at timestamptz;

CREATE TABLE meal.recommendation_issuances (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  recommendation_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('recipe','author')),
  entity_key text NOT NULL,
  algorithm text NOT NULL CHECK (algorithm = 'personalized-v1'),
  surface text NOT NULL CHECK (surface IN ('home','recipes','authors')),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 999),
  reason_codes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT uq_recommendation_issuances_user_recommendation UNIQUE(user_id,recommendation_id),
  CONSTRAINT ck_recommendation_issuances_expiry CHECK(expires_at>created_at)
);

COMMENT ON TABLE meal.recommendation_issuances IS 'Короткоживущая серверная привязка recommendationId к пользователю и безопасной метаинформации выдачи';
CREATE INDEX ix_recommendation_issuances_expiry ON meal.recommendation_issuances(expires_at);
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.recommendation_issuances FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER protect_identity BEFORE UPDATE ON meal.recommendation_issuances FOR EACH ROW EXECUTE FUNCTION meal.protect_scope_and_identity();

CREATE TABLE meal.recommendation_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  recommendation_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('impression','open','not_interested','not_suitable')),
  entity_type text NOT NULL CHECK (entity_type IN ('recipe','author')),
  entity_key text NOT NULL,
  algorithm text NOT NULL CHECK (algorithm = 'personalized-v1'),
  surface text NOT NULL CHECK (surface IN ('home','recipes','authors')),
  position integer CHECK (position BETWEEN 0 AND 999),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload_hash text NOT NULL,
  idempotency_key uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT uq_recommendation_events_user_key UNIQUE(user_id,idempotency_key)
);

COMMENT ON TABLE meal.recommendation_events IS 'Минимальные события выдачи рекомендаций без запасов, аллергенов, предпочтений и иных sensitive context';
CREATE INDEX ix_recommendation_events_user_time ON meal.recommendation_events(user_id,occurred_at DESC);
CREATE INDEX ix_recommendation_events_entity ON meal.recommendation_events(entity_type,entity_key,event_kind);
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.recommendation_events FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER protect_identity BEFORE UPDATE ON meal.recommendation_events FOR EACH ROW EXECUTE FUNCTION meal.protect_scope_and_identity();
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON meal.recommendation_events FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
