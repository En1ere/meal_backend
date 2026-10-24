-- Prepared only. Apply after 002-010 during the separately approved Linux transfer.
-- The migration runner owns the SERIALIZABLE transaction and checksum verification.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

INSERT INTO meal.ai_rule_versions(id,kind,version,config,effective_at)
VALUES(
  '00000000-0000-4000-8000-00000000a111'::uuid,
  'cost',
  1,
  '{"agreementVersion":"ai-usage-v1","previewTtlSeconds":600,"intervalSeconds":600,"costs":{"culinary_question":1,"recipe_from_stock":1,"substitution":1,"storage_advice":1}}'::jsonb,
  '2026-01-01T00:00:00Z'::timestamptz
);

COMMENT ON COLUMN meal.ai_rule_versions.config IS 'Immutable AI pricing and consent snapshot. Add a new version instead of updating a historical row.';
