-- Prepared only. Applying this migration requires the separately approved transfer procedure.
CREATE TABLE IF NOT EXISTS meal.scheduled_sanction_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sanction_id uuid NOT NULL REFERENCES meal.sanctions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('family_plus_transfer')),
  recipient_user_id uuid REFERENCES meal.users(id),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','applied','skipped','failed')),
  failure_reason text,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT uq_scheduled_sanction_effect UNIQUE (sanction_id, kind)
);

CREATE INDEX IF NOT EXISTS ix_scheduled_sanction_effects_due
  ON meal.scheduled_sanction_effects(status, created_at, id)
  WHERE status = 'scheduled';

COMMENT ON TABLE meal.scheduled_sanction_effects IS
  'Durable effects that must be applied when a future sanction becomes active.';
