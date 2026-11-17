-- =====================================================================
-- Phase 2: multi-spreadsheet import engine
-- =====================================================================

-- Identifiers parsed out of the free-text "Lot" column, e.g.
--   "AR-9501HS BATCH# 14919754 SN# 808" -> catalog AR-9501HS, batch 14919754, serial 808
-- The original Lot text is always preserved unchanged in assets.lot.
ALTER TABLE assets
  ADD COLUMN catalog_number TEXT,
  ADD COLUMN batch_number   TEXT;

-- Serial numbers are NOT unique per physical tray. In the source data one
-- instrument-set serial (e.g. AR-9501HS SN 642) is shared by the trays of a
-- multi-tray set (#5A, #5B, #5C). The Phase 1 unique index would wrongly force
-- those trays into one record, so it becomes a plain lookup index and the
-- importer uses serials only as evidence alongside the Reference.
DROP INDEX assets_serial_uq;
CREATE INDEX assets_serial_idx
  ON assets (upper(btrim(coalesce(catalog_number, ''))), upper(btrim(serial_number)))
  WHERE serial_number IS NOT NULL AND btrim(serial_number) <> '';
CREATE INDEX assets_reference_idx ON assets (upper(btrim(reference)));

-- Batch-level mapping of spreadsheet values (Warehouse -> team, Location -> facility)
-- chosen by the person running the import, and the committed result summary.
ALTER TABLE import_batches
  ADD COLUMN mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN result  JSONB;

-- Human decisions on rows that need review (possible name-only matches).
ALTER TABLE import_rows
  ADD COLUMN decision_target UUID REFERENCES assets(id),
  ADD COLUMN warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN details  JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Conflicts on facility / team / representative carry the ids involved so a
-- resolution can be applied to the live record.
ALTER TABLE asset_conflicts
  ADD COLUMN current_ref  UUID,
  ADD COLUMN proposed_ref UUID;

-- Remembered name variants, e.g. "SOUTHERN TENNESSEE MED CTR" -> facility X,
-- so later spreadsheets map automatically.
CREATE TABLE name_aliases (
  kind        TEXT NOT NULL CHECK (kind IN ('facility', 'team')),
  alias_norm  TEXT NOT NULL,
  target_id   UUID NOT NULL,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, alias_norm)
);
