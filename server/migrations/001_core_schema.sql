-- =====================================================================
-- Arthroplasty Asset Control System — core relational schema
-- ---------------------------------------------------------------------
-- Design principles
--   * The existing Arthrex QR value (UUID / random string) is the permanent
--     physical identifier. It lives in asset_qr_codes and is globally unique
--     among active links, so one QR can never point at two assets.
--   * Facility, representative and status are mutable on `assets`; every change
--     to them is recorded in `asset_events`, which is append-only (enforced by
--     trigger). Movement history can never be edited or deleted.
--   * Assets, transfers, cases and audits are never hard-deleted (RESTRICT FKs
--     plus delete-blocking triggers). Records are retired / deactivated instead.
--   * No patient-identifying information is stored anywhere in this schema.
--   * Enumerations use TEXT + CHECK (not PG enums) so values can evolve via
--     ordinary migrations.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: this history is permanent', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'DELETE on % is not permitted: deactivate or retire the record instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- Teams (configurable — nothing hardcoded)
-- ---------------------------------------------------------------------
CREATE TABLE teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  code        TEXT,
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_name_uq ON teams (lower(btrim(name)));
CREATE TRIGGER teams_updated BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Facilities (warehouses, hospitals, ASCs …)
-- ---------------------------------------------------------------------
CREATE TABLE facilities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  facility_type TEXT NOT NULL DEFAULT 'hospital'
                CHECK (facility_type IN ('warehouse','hospital','surgery_center','clinic','other')),
  code          TEXT,
  address_line  TEXT,
  city          TEXT,
  state         TEXT,
  postal_code   TEXT,
  phone         TEXT,
  notes         TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX facilities_name_uq ON facilities (lower(btrim(name)));
CREATE INDEX facilities_type_idx ON facilities (facility_type) WHERE active;
CREATE TRIGGER facilities_updated BEFORE UPDATE ON facilities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER facilities_no_delete BEFORE DELETE ON facilities FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------
-- Users & roles
--   admin     — full control, user/team/facility administration
--   manager   — organisation-wide visibility, reports, conflict resolution
--   inventory — organisation-wide visibility, imports, audits, investigations
--   rep       — sees assets for their teams / in their custody
--   system    — non-login actor for automated events (overdue sweeps etc.)
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL CHECK (position('@' IN email) > 1),
  full_name      TEXT NOT NULL CHECK (length(btrim(full_name)) > 0),
  role           TEXT NOT NULL CHECK (role IN ('admin','manager','inventory','rep','system')),
  phone          TEXT,
  title          TEXT,
  password_hash  TEXT,
  active         BOOLEAN NOT NULL DEFAULT true,
  last_login_at  TIMESTAMPTZ,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role = 'system' OR password_hash IS NOT NULL OR active = false)
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_no_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Team membership drives a representative's visibility.
CREATE TABLE user_teams (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX user_teams_team_idx ON user_teams (team_id);

-- Server-side sessions. Only a SHA-256 hash of the cookie token is stored.
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- Fixed, non-login system actor so every event has an accountable user_id.
INSERT INTO users (id, email, full_name, role, active)
VALUES ('00000000-0000-0000-0000-000000000001', 'system@asset-control.local', 'System', 'system', false);

-- ---------------------------------------------------------------------
-- Assets
-- ---------------------------------------------------------------------
CREATE TABLE assets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_no              BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,  -- permanent human-readable ID (AH-000001)
  reference             TEXT NOT NULL CHECK (length(btrim(reference)) > 0),  -- existing Arthrex asset name / reference
  description           TEXT,
  asset_type            TEXT NOT NULL DEFAULT 'tray'
                        CHECK (asset_type IN ('tray','tote','implant_set','instrument_set','loaner_kit','other')),
  source_type           TEXT,          -- "Type" exactly as it appeared in source spreadsheets
  team_id               UUID REFERENCES teams(id) ON DELETE RESTRICT,
  warehouse_id          UUID REFERENCES facilities(id) ON DELETE RESTRICT,
  current_facility_id   UUID REFERENCES facilities(id) ON DELETE RESTRICT,
  assigned_rep_id       UUID REFERENCES users(id) ON DELETE RESTRICT,
  custodian_id          UUID REFERENCES users(id) ON DELETE RESTRICT,  -- last known physical custodian
  status                TEXT NOT NULL DEFAULT 'at_warehouse'
                        CHECK (status IN ('at_warehouse','at_facility','in_transit','assigned_to_case',
                                          'awaiting_receipt','overdue','missing','under_investigation',
                                          'out_of_service')),
  lot                   TEXT,
  serial_number         TEXT,
  notes                 TEXT,

  -- Fields preserved from the source spreadsheets
  agency                TEXT,
  source_warehouse      TEXT,          -- raw "Warehouse" text before facility matching
  source_location       TEXT,          -- raw "Location" text before facility matching
  consignment_fee       NUMERIC(12,2),
  return_date           DATE,
  items_count           INTEGER,
  flags                 TEXT,

  -- Case utilisation (imported + maintained)
  set_utilization_factor NUMERIC(10,4),
  definition_value       NUMERIC(14,2),
  total_cases_12m        INTEGER,
  top_hcp                TEXT,         -- surgeon (HCP) name; not patient data
  top_hcp_sales          NUMERIC(14,2),
  top_hcp_cases          INTEGER,
  days_since_last_case   INTEGER,
  utilization_as_of      DATE,

  extra                  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- any unmapped spreadsheet columns, preserved verbatim

  last_scanned_at       TIMESTAMPTZ,
  last_transferred_at   TIMESTAMPTZ,
  retired_at            TIMESTAMPTZ,
  version               INTEGER NOT NULL DEFAULT 1,           -- optimistic concurrency
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A serial number, when present, identifies exactly one asset.
CREATE UNIQUE INDEX assets_serial_uq ON assets (upper(btrim(serial_number)))
  WHERE serial_number IS NOT NULL AND btrim(serial_number) <> '';
CREATE INDEX assets_ref_lot_idx        ON assets (upper(btrim(reference)), upper(btrim(coalesce(lot,''))));
CREATE INDEX assets_team_idx           ON assets (team_id);
CREATE INDEX assets_facility_idx       ON assets (current_facility_id);
CREATE INDEX assets_rep_idx            ON assets (assigned_rep_id);
CREATE INDEX assets_custodian_idx      ON assets (custodian_id);
CREATE INDEX assets_status_idx         ON assets (status) WHERE retired_at IS NULL;
CREATE TRIGGER assets_updated   BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER assets_no_delete BEFORE DELETE ON assets FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------
-- Existing Arthrex QR identifiers
-- ---------------------------------------------------------------------
CREATE TABLE asset_qr_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  qr_value     TEXT NOT NULL CHECK (length(btrim(qr_value)) > 0),
  active       BOOLEAN NOT NULL DEFAULT true,
  linked_by    UUID NOT NULL REFERENCES users(id),
  linked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  unlinked_by  UUID REFERENCES users(id),
  unlinked_at  TIMESTAMPTZ,
  unlink_reason TEXT,
  CHECK (active OR (unlinked_at IS NOT NULL AND unlinked_by IS NOT NULL))
);
-- One QR value can be actively linked to only one asset (case-insensitive, trimmed).
CREATE UNIQUE INDEX asset_qr_value_uq  ON asset_qr_codes (lower(btrim(qr_value))) WHERE active;
-- One active QR per asset.
CREATE UNIQUE INDEX asset_qr_asset_uq  ON asset_qr_codes (asset_id) WHERE active;
CREATE TRIGGER asset_qr_no_delete BEFORE DELETE ON asset_qr_codes FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------
-- Transfers (custody movement between facilities / reps)
-- ---------------------------------------------------------------------
CREATE TABLE transfers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no       BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  asset_id          UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  from_facility_id  UUID REFERENCES facilities(id) ON DELETE RESTRICT,
  to_facility_id    UUID NOT NULL REFERENCES facilities(id) ON DELETE RESTRICT,
  sender_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recipient_id      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason            TEXT,
  status            TEXT NOT NULL DEFAULT 'in_transit'
                    CHECK (status IN ('in_transit','received','cancelled','rejected')),
  initiated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  accept_by         TIMESTAMPTZ,                  -- receipt deadline before escalation
  received_at       TIMESTAMPTZ,
  received_by       UUID REFERENCES users(id),
  closed_at         TIMESTAMPTZ,
  closed_by         UUID REFERENCES users(id),
  close_reason      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'received' OR (received_at IS NOT NULL AND received_by IS NOT NULL)),
  CHECK (status NOT IN ('cancelled','rejected') OR (closed_at IS NOT NULL AND closed_by IS NOT NULL))
);
-- An asset can be in only one open transfer at a time.
CREATE UNIQUE INDEX transfers_one_open_uq ON transfers (asset_id) WHERE status = 'in_transit';
CREATE INDEX transfers_recipient_idx ON transfers (recipient_id, status);
CREATE INDEX transfers_sender_idx    ON transfers (sender_id, status);
CREATE INDEX transfers_to_fac_idx    ON transfers (to_facility_id, status);
CREATE INDEX transfers_from_fac_idx  ON transfers (from_facility_id, status);
CREATE TRIGGER transfers_updated   BEFORE UPDATE ON transfers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER transfers_no_delete BEFORE DELETE ON transfers FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Explicit receipt confirmations (immutable). A transfer is only "received"
-- when a matching confirmation row exists.
CREATE TABLE transfer_confirmations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id   UUID NOT NULL UNIQUE REFERENCES transfers(id) ON DELETE RESTRICT,
  confirmed_by  UUID NOT NULL REFERENCES users(id),
  confirmed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  facility_id   UUID NOT NULL REFERENCES facilities(id),
  via_qr_scan   BOOLEAN NOT NULL DEFAULT false,
  notes         TEXT
);
CREATE TRIGGER transfer_conf_immutable BEFORE UPDATE OR DELETE ON transfer_confirmations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Surgical case assignments (no patient data — date, facility, surgeon, rep only)
-- ---------------------------------------------------------------------
CREATE TABLE cases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no       BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  case_date     DATE NOT NULL,
  facility_id   UUID NOT NULL REFERENCES facilities(id) ON DELETE RESTRICT,
  surgeon_name  TEXT,
  rep_id        UUID REFERENCES users(id) ON DELETE RESTRICT,
  team_id       UUID REFERENCES teams(id) ON DELETE RESTRICT,
  procedure     TEXT,           -- generic procedure label, e.g. "Total Shoulder"
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  notes         TEXT,
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cases_date_idx     ON cases (case_date);
CREATE INDEX cases_facility_idx ON cases (facility_id, case_date);
CREATE TRIGGER cases_updated   BEFORE UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER cases_no_delete BEFORE DELETE ON cases FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Assignment of an asset to a case. Deliberately separate from physical
-- movement: assigning does NOT change the asset's location.
CREATE TABLE case_assets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      UUID NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  asset_id     UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  assigned_by  UUID NOT NULL REFERENCES users(id),
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by  UUID REFERENCES users(id),
  released_at  TIMESTAMPTZ,
  used         BOOLEAN
);
CREATE UNIQUE INDEX case_assets_active_uq ON case_assets (case_id, asset_id) WHERE released_at IS NULL;
CREATE INDEX case_assets_asset_idx ON case_assets (asset_id);
CREATE TRIGGER case_assets_no_delete BEFORE DELETE ON case_assets FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------
-- Physical inventory audits
-- ---------------------------------------------------------------------
CREATE TABLE audits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_no      BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  facility_id   UUID NOT NULL REFERENCES facilities(id) ON DELETE RESTRICT,
  team_id       UUID REFERENCES teams(id),
  started_by    UUID NOT NULL REFERENCES users(id),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_by  UUID REFERENCES users(id),
  completed_at  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','cancelled')),
  expected_snapshot JSONB,      -- asset ids expected at facility when audit began
  summary       JSONB,
  notes         TEXT
);
CREATE INDEX audits_facility_idx ON audits (facility_id, started_at DESC);
CREATE TRIGGER audits_no_delete BEFORE DELETE ON audits FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE audit_scans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id    UUID NOT NULL REFERENCES audits(id) ON DELETE RESTRICT,
  asset_id    UUID REFERENCES assets(id) ON DELETE RESTRICT,
  qr_value    TEXT,
  scanned_by  UUID NOT NULL REFERENCES users(id),
  scanned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  result      TEXT NOT NULL CHECK (result IN ('present_expected','unexpected','other_facility',
                                              'in_transit','unknown_qr')),
  recorded_facility_id UUID REFERENCES facilities(id),
  CHECK (asset_id IS NOT NULL OR qr_value IS NOT NULL)
);
CREATE UNIQUE INDEX audit_scans_asset_uq ON audit_scans (audit_id, asset_id) WHERE asset_id IS NOT NULL;
CREATE TRIGGER audit_scans_immutable BEFORE UPDATE OR DELETE ON audit_scans
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Spreadsheet imports, provenance and conflicts
-- ---------------------------------------------------------------------
CREATE TABLE import_batches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by  UUID NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','committed','cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  committed_by UUID REFERENCES users(id)
);

CREATE TABLE imports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            UUID NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT,
  filename            TEXT NOT NULL,
  file_sha256         TEXT NOT NULL,
  sheet_name          TEXT,
  team_id             UUID REFERENCES teams(id),
  uploaded_by         UUID NOT NULL REFERENCES users(id),
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status              TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','committed','cancelled')),
  header_map          JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count           INTEGER NOT NULL DEFAULT 0,
  new_count           INTEGER NOT NULL DEFAULT 0,
  updated_count       INTEGER NOT NULL DEFAULT 0,
  duplicate_count     INTEGER NOT NULL DEFAULT 0,
  conflict_count      INTEGER NOT NULL DEFAULT 0,
  review_count        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX imports_batch_idx ON imports (batch_id);
CREATE INDEX imports_sha_idx   ON imports (file_sha256);
CREATE TRIGGER imports_no_delete BEFORE DELETE ON imports FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE import_rows (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id        UUID NOT NULL REFERENCES imports(id) ON DELETE RESTRICT,
  row_number       INTEGER NOT NULL,
  raw              JSONB NOT NULL,           -- original row exactly as read
  normalized       JSONB NOT NULL,           -- mapped to asset fields
  match_method     TEXT CHECK (match_method IN ('qr','serial','reference_lot','name_only','none')),
  matched_asset_id UUID REFERENCES assets(id),
  action           TEXT NOT NULL CHECK (action IN ('new','update','duplicate','conflict','review','skip','error')),
  decision         TEXT CHECK (decision IN ('accept','skip','merge','create_new')),
  message          TEXT,
  resulting_asset_id UUID REFERENCES assets(id),
  UNIQUE (import_id, row_number)
);
CREATE INDEX import_rows_asset_idx ON import_rows (matched_asset_id);

-- Which spreadsheet supplied each field value for an asset.
CREATE TABLE asset_field_sources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  field       TEXT NOT NULL,
  value       TEXT,
  import_id   UUID NOT NULL REFERENCES imports(id) ON DELETE RESTRICT,
  row_number  INTEGER,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, field, import_id)
);
CREATE INDEX asset_field_sources_asset_idx ON asset_field_sources (asset_id, field);

CREATE TABLE asset_conflicts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  field          TEXT NOT NULL,
  current_value  TEXT,
  proposed_value TEXT,
  import_id      UUID REFERENCES imports(id),
  row_number     INTEGER,
  severity       TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('normal','critical')), -- critical = location / rep
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolved_value TEXT,
  resolved_by    UUID REFERENCES users(id),
  resolved_at    TIMESTAMPTZ,
  resolution_note TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX asset_conflicts_open_idx ON asset_conflicts (status, asset_id);
CREATE TRIGGER asset_conflicts_no_delete BEFORE DELETE ON asset_conflicts FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------
-- Problem reports / investigations (incl. undocumented movement)
-- ---------------------------------------------------------------------
CREATE TABLE investigations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_ref      BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  asset_id      UUID REFERENCES assets(id) ON DELETE RESTRICT,
  qr_value      TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('unauthorized_movement','location_discrepancy','audit_discrepancy',
                                              'missing','damaged','incomplete','unknown_qr','other')),
  facility_id   UUID REFERENCES facilities(id),
  reported_by   UUID NOT NULL REFERENCES users(id),
  reported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','dismissed')),
  assigned_to   UUID REFERENCES users(id),
  resolution    TEXT,
  resolved_by   UUID REFERENCES users(id),
  resolved_at   TIMESTAMPTZ,
  audit_id      UUID REFERENCES audits(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX investigations_status_idx ON investigations (status);
CREATE INDEX investigations_asset_idx  ON investigations (asset_id);
CREATE TRIGGER investigations_updated   BEFORE UPDATE ON investigations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER investigations_no_delete BEFORE DELETE ON investigations FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------
-- Permanent asset event ledger (append-only)
-- ---------------------------------------------------------------------
CREATE TABLE asset_events (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id           UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  event_type         TEXT NOT NULL CHECK (event_type IN (
                       'created','imported','updated','qr_linked','qr_unlinked','scanned',
                       'transfer_initiated','transfer_received','transfer_cancelled','transfer_rejected',
                       'status_changed','location_corrected','reassigned',
                       'case_assigned','case_released','audit_scanned',
                       'problem_reported','investigation_updated','conflict_resolved','retired')),
  actor_id           UUID NOT NULL REFERENCES users(id),
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_facility_id   UUID REFERENCES facilities(id),
  to_facility_id     UUID REFERENCES facilities(id),
  from_custodian_id  UUID REFERENCES users(id),
  to_custodian_id    UUID REFERENCES users(id),
  from_status        TEXT,
  to_status          TEXT,
  transfer_id        UUID REFERENCES transfers(id),
  case_id            UUID REFERENCES cases(id),
  audit_id           UUID REFERENCES audits(id),
  import_id          UUID REFERENCES imports(id),
  investigation_id   UUID REFERENCES investigations(id),
  details            JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX asset_events_asset_idx ON asset_events (asset_id, occurred_at DESC);
CREATE INDEX asset_events_actor_idx ON asset_events (actor_id, occurred_at DESC);
CREATE INDEX asset_events_type_idx  ON asset_events (event_type, occurred_at DESC);
CREATE TRIGGER asset_events_immutable BEFORE UPDATE OR DELETE ON asset_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- TRUNCATE bypasses row triggers, so block it explicitly as well.
CREATE TRIGGER asset_events_no_truncate BEFORE TRUNCATE ON asset_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind         TEXT NOT NULL CHECK (kind IN ('transfer_incoming','transfer_pending','transfer_overdue',
                                             'return_overdue','asset_missing','unauthorized_movement',
                                             'location_discrepancy','audit_discrepancy','import_conflict','system')),
  title        TEXT NOT NULL,
  body         TEXT,
  asset_id     UUID REFERENCES assets(id),
  transfer_id  UUID REFERENCES transfers(id),
  link         TEXT,
  dedupe_key   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at      TIMESTAMPTZ
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_dedupe_uq ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE notification_preferences (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  in_app    BOOLEAN NOT NULL DEFAULT true,
  email     BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, kind)
);
