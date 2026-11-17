-- =====================================================================
-- Phase 4: transfers, receipt confirmation, problem reports
-- =====================================================================

-- Snapshot of the asset at the moment the transfer started, so a cancelled
-- transfer can restore it, plus where the receipt actually happened.
ALTER TABLE transfers
  ADD COLUMN from_status         TEXT,
  ADD COLUMN from_custodian_id   UUID REFERENCES users(id),
  ADD COLUMN received_facility_id UUID REFERENCES facilities(id),
  ADD COLUMN investigation_id    UUID REFERENCES investigations(id),
  ADD COLUMN last_reminder_at    TIMESTAMPTZ;
CREATE INDEX transfers_open_deadline_idx ON transfers (accept_by) WHERE status = 'in_transit';

-- Investigations: remember the asset status before the report so it can be
-- restored on resolution, and keep an append-only activity log.
ALTER TABLE investigations
  ADD COLUMN asset_status_before TEXT,
  ADD COLUMN transfer_id UUID REFERENCES transfers(id);

CREATE TABLE investigation_events (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE RESTRICT,
  actor_id         UUID NOT NULL REFERENCES users(id),
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  action           TEXT NOT NULL CHECK (action IN ('reported', 'note', 'status_changed', 'assigned', 'resolved', 'dismissed', 'reopened')),
  from_status      TEXT,
  to_status        TEXT,
  note             TEXT
);
CREATE INDEX investigation_events_idx ON investigation_events (investigation_id, occurred_at);
CREATE TRIGGER investigation_events_immutable BEFORE UPDATE OR DELETE ON investigation_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'transfer_incoming', 'transfer_pending', 'transfer_overdue', 'transfer_update', 'return_overdue', 'asset_missing',
  'unauthorized_movement', 'location_discrepancy', 'audit_discrepancy', 'import_conflict',
  'qr_link_request', 'problem_reported', 'system'));
CREATE INDEX notifications_transfer_idx ON notifications (transfer_id);
