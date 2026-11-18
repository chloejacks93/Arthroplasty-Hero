-- A facility can own the trays that come back to it: when a tray is received
-- there (by transfer or one-step return), its team switches to this team.
-- Configured per facility by an administrator; nothing is hard-coded.
ALTER TABLE facilities ADD COLUMN receiving_team_id UUID REFERENCES teams(id);
