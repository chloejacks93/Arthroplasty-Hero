-- =====================================================================
-- Phase 3: existing-QR scanning and linking
-- =====================================================================

-- Every scan, including codes that are not linked to any asset yet.
-- Append-only, like the asset event ledger.
CREATE TABLE scan_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  qr_value    TEXT NOT NULL,
  asset_id    UUID REFERENCES assets(id) ON DELETE RESTRICT,
  user_id     UUID NOT NULL REFERENCES users(id),
  scanned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  result      TEXT NOT NULL CHECK (result IN ('matched', 'unknown')),
  source      TEXT NOT NULL DEFAULT 'camera' CHECK (source IN ('camera', 'manual'))
);
CREATE INDEX scan_log_qr_idx   ON scan_log (lower(btrim(qr_value)), scanned_at DESC);
CREATE INDEX scan_log_user_idx ON scan_log (user_id, scanned_at DESC);
CREATE TRIGGER scan_log_immutable BEFORE UPDATE OR DELETE ON scan_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A representative who scans an unrecognised code can propose which asset it
-- belongs to; inventory / management / admin confirm before it is linked.
CREATE TABLE qr_link_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qr_value      TEXT NOT NULL CHECK (length(btrim(qr_value)) > 0),
  asset_id      UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  requested_by  UUID NOT NULL REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by    UUID REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  CHECK (status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX qr_link_requests_pending_uq ON qr_link_requests (lower(btrim(qr_value))) WHERE status = 'pending';
CREATE TRIGGER qr_link_requests_no_delete BEFORE DELETE ON qr_link_requests
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'transfer_incoming', 'transfer_pending', 'transfer_overdue', 'return_overdue', 'asset_missing',
  'unauthorized_movement', 'location_discrepancy', 'audit_discrepancy', 'import_conflict',
  'qr_link_request', 'system'));
