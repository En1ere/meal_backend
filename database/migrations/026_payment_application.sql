-- Prepared only. Apply after 001-025 during the separately approved transfer procedure.
-- Provider credentials, endpoints and webhook secrets are intentionally absent.
ALTER TABLE meal.payment_attempts
 ADD COLUMN request_hash text,
 ADD COLUMN checkout_url text,
 ADD COLUMN provider_occurred_at timestamptz;

ALTER TABLE meal.payment_attempts
 ADD CONSTRAINT ck_payment_attempts_request_hash
 CHECK(request_hash IS NULL OR request_hash ~ '^sha256:[a-f0-9]{64}$'),
 ADD CONSTRAINT ck_payment_attempts_checkout_url
 CHECK(checkout_url IS NULL OR checkout_url ~ '^https://');

ALTER TABLE meal.payment_refunds
 ADD COLUMN idempotency_key text,
 ADD COLUMN request_hash text,
 ADD COLUMN access_effect text NOT NULL DEFAULT 'preserve',
 ADD COLUMN access_target_kind text,
 ADD COLUMN access_target_id uuid,
 ADD COLUMN provider_event_id text,
 ADD COLUMN consequence_applied_at timestamptz;

ALTER TABLE meal.payment_refunds
 ADD CONSTRAINT ck_payment_refunds_idempotency_key
 CHECK(idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
 ADD CONSTRAINT ck_payment_refunds_request_hash
 CHECK(request_hash IS NULL OR request_hash ~ '^sha256:[a-f0-9]{64}$'),
 ADD CONSTRAINT ck_payment_refunds_access_effect
 CHECK(access_effect IN('preserve','terminate')),
 ADD CONSTRAINT ck_payment_refunds_access_target
 CHECK(
   (access_effect='preserve' AND access_target_kind IS NULL AND access_target_id IS NULL)
   OR
   (access_effect='terminate' AND access_target_kind IN('subscription_period','ai_package') AND access_target_id IS NOT NULL)
 ),
 ADD CONSTRAINT ck_payment_refunds_consequence
 CHECK(consequence_applied_at IS NULL OR status='succeeded');

CREATE UNIQUE INDEX uq_payment_refunds_attempt_id_idempotency_key
 ON meal.payment_refunds(attempt_id,idempotency_key)
 WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_payment_refunds_provider_event_id
 ON meal.payment_refunds(provider_event_id)
 WHERE provider_event_id IS NOT NULL;

COMMENT ON COLUMN meal.payment_attempts.request_hash IS 'Полный fingerprint checkout-команды для защиты idempotency replay';
COMMENT ON COLUMN meal.payment_refunds.request_hash IS 'Полный fingerprint refund-команды; изменение параметров под тем же ключом запрещено';
COMMENT ON COLUMN meal.payment_refunds.consequence_applied_at IS 'Маркер ровно одного атомарного применения прекращения доступа';
