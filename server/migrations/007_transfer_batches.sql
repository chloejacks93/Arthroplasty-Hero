-- Several trays sent together in one action ("shipment"). Each tray still has
-- its own transfer row, receipt and history; the batch only groups them.
CREATE TABLE transfer_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_no        BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  sender_id       UUID NOT NULL REFERENCES users(id),
  recipient_id    UUID NOT NULL REFERENCES users(id),
  to_facility_id  UUID NOT NULL REFERENCES facilities(id),
  reason          TEXT,
  asset_count     INTEGER NOT NULL CHECK (asset_count > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER transfer_batches_no_delete BEFORE DELETE ON transfer_batches
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

ALTER TABLE transfers ADD COLUMN batch_id UUID REFERENCES transfer_batches(id);
CREATE INDEX transfers_batch_idx ON transfers (batch_id);
