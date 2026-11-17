-- Small key/value store for one-time operational markers (e.g. which
-- administrator-recovery value has already been applied).
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
