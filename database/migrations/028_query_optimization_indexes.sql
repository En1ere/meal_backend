-- Additive indexes for bounded list, family-note and staff queue reads.
-- The migration runner owns the SERIALIZABLE transaction and checksum verification.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX ix_family_notes_active_list
  ON meal.family_notes (family_id, created_at DESC, id)
  WHERE archived_at IS NULL;

CREATE INDEX ix_family_notes_archived_list
  ON meal.family_notes (family_id, created_at DESC, id)
  WHERE archived_at IS NOT NULL;

CREATE INDEX ix_moderation_cases_queue_order
  ON meal.moderation_cases (kind, queue_priority DESC, submitted_at, id);

CREATE INDEX ix_moderation_cases_kind_status
  ON meal.moderation_cases (kind, status);

CREATE INDEX ix_moderation_cases_assigned_queue
  ON meal.moderation_cases (assigned_to, queue_priority DESC, submitted_at, id)
  WHERE assigned_to IS NOT NULL;

CREATE INDEX ix_moderation_cases_sla
  ON meal.moderation_cases (submitted_at, id)
  WHERE status NOT IN ('closed', 'resolved', 'published', 'rejected');

CREATE INDEX ix_moderation_cases_admin_cursor
  ON meal.moderation_cases (kind, id);

CREATE INDEX ix_support_tickets_moderator_queue
  ON meal.support_tickets (created_at, id)
  WHERE category NOT IN ('billing', 'payment', 'refund', 'subscription', 'finance');

CREATE INDEX ix_support_tickets_status_queue
  ON meal.support_tickets (status, created_at, id)
  WHERE category NOT IN ('billing', 'payment', 'refund', 'subscription', 'finance');

CREATE INDEX ix_support_tickets_assignee_queue
  ON meal.support_tickets (assignee_id, created_at, id)
  WHERE category NOT IN ('billing', 'payment', 'refund', 'subscription', 'finance')
    AND assignee_id IS NOT NULL;
