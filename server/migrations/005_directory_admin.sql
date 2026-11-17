-- =====================================================================
-- Phase 5: facility / team / user administration
-- =====================================================================

-- Accounts created or reset by an administrator get a temporary password
-- that must be changed at first sign-in.
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;

-- Permanent log of directory changes (who changed which user / team /
-- facility / asset assignment, what changed, when). Append-only.
CREATE TABLE admin_audit (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    UUID NOT NULL REFERENCES users(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  entity      TEXT NOT NULL CHECK (entity IN ('user', 'team', 'facility', 'asset')),
  entity_id   UUID NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deactivated', 'reactivated', 'password_reset', 'assignment_changed')),
  changes     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX admin_audit_entity_idx ON admin_audit (entity, entity_id, occurred_at DESC);
CREATE TRIGGER admin_audit_immutable BEFORE UPDATE OR DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER admin_audit_no_truncate BEFORE TRUNCATE ON admin_audit
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
