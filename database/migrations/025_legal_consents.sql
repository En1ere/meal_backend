-- Prepared only. Apply after 001-024 during the separately approved transfer procedure.
-- No legal text, real URL, retention period or production evidence is seeded here.
CREATE TABLE meal.legal_document_publications (
 document_id uuid PRIMARY KEY REFERENCES meal.legal_documents(id),
 content_release_id uuid NOT NULL REFERENCES meal.content_releases(id),
 publish_event_id uuid NOT NULL REFERENCES meal.content_release_events(id),
 public_url text NOT NULL CHECK(public_url ~ '^https://[^/?#]+(?:/[^?#]*)?$'),
 locale text NOT NULL CHECK(locale ~ '^[a-z]{2}(?:-[A-Z]{2})?$'),
 jurisdiction text NOT NULL CHECK(jurisdiction ~ '^[a-z][a-z0-9._-]{2,79}$'),
 approved_at timestamptz,
 retired_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK(retired_at IS NULL OR approved_at IS NOT NULL),
 CHECK(retired_at IS NULL OR retired_at>=approved_at)
);
CREATE UNIQUE INDEX legal_document_publications_release_event ON meal.legal_document_publications(publish_event_id,document_id);

CREATE TABLE meal.agreement_acceptance_events (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES meal.users(id),
 agreement_kind text NOT NULL CHECK(agreement_kind='offer'), action text NOT NULL CHECK(action='accepted'),
 document_id uuid NOT NULL, document_version bigint NOT NULL CHECK(document_version>0),
 body_hash text NOT NULL CHECK(body_hash ~ '^sha256:[a-f0-9]{64}$'),
 content_release_id uuid NOT NULL, publish_event_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL, request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 200),
 evidence_mode text NOT NULL CHECK(evidence_mode IN('approved','demonstration')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agreement_acceptance_events_user_time ON meal.agreement_acceptance_events(user_id,occurred_at DESC,id DESC);

CREATE TABLE meal.legal_acknowledgement_events (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES meal.users(id),
 document_kind text NOT NULL CHECK(document_kind='privacy_notice'), action text NOT NULL CHECK(action='acknowledged'),
 document_id uuid NOT NULL, document_version bigint NOT NULL CHECK(document_version>0),
 body_hash text NOT NULL CHECK(body_hash ~ '^sha256:[a-f0-9]{64}$'),
 content_release_id uuid NOT NULL, publish_event_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL, request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 200),
 evidence_mode text NOT NULL CHECK(evidence_mode IN('approved','demonstration')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legal_acknowledgement_events_user_time ON meal.legal_acknowledgement_events(user_id,occurred_at DESC,id DESC);

CREATE TABLE meal.legal_consent_events (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES meal.users(id),
 kind text NOT NULL CHECK(kind IN('ai_data_access','special_category','dissemination','marketing')),
 action text NOT NULL CHECK(action IN('accepted','revoked')), revision bigint NOT NULL CHECK(revision>0),
 document_snapshot jsonb, occurred_at timestamptz NOT NULL,
 request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 200), idempotency_key uuid NOT NULL,
 evidence_mode text NOT NULL CHECK(evidence_mode IN('approved','demonstration')), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((action='accepted' AND document_snapshot IS NOT NULL) OR (action='revoked' AND document_snapshot IS NULL)),
 UNIQUE(user_id,kind,revision), UNIQUE(user_id,idempotency_key)
);
CREATE INDEX legal_consent_events_user_time ON meal.legal_consent_events(user_id,occurred_at DESC,id DESC);

CREATE FUNCTION meal.reject_immutable_legal_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'legal evidence events are append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER agreement_acceptance_events_immutable BEFORE UPDATE OR DELETE ON meal.agreement_acceptance_events
 FOR EACH ROW EXECUTE FUNCTION meal.reject_immutable_legal_event_mutation();
CREATE TRIGGER legal_acknowledgement_events_immutable BEFORE UPDATE OR DELETE ON meal.legal_acknowledgement_events
 FOR EACH ROW EXECUTE FUNCTION meal.reject_immutable_legal_event_mutation();
CREATE TRIGGER legal_consent_events_immutable BEFORE UPDATE OR DELETE ON meal.legal_consent_events
 FOR EACH ROW EXECUTE FUNCTION meal.reject_immutable_legal_event_mutation();
CREATE TRIGGER legal_document_publications_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.legal_document_publications
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER agreement_acceptance_events_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.agreement_acceptance_events
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER legal_acknowledgement_events_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.legal_acknowledgement_events
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER legal_consent_events_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.legal_consent_events
 FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
