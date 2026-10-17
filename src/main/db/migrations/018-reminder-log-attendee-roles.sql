-- Reference copy. The applied version is MIGRATION_018_SQL in database.ts.
--
-- reminder_log: which reminders have rung, so a restart does not ring them again.
-- attendees.role: 'optional' or 'resource' (a meeting room); NULL is a required guest.
-- Clearing the sync positions re-reads every calendar so stored lists get their rooms back.
CREATE TABLE IF NOT EXISTS reminder_log (
  ring_key TEXT PRIMARY KEY,
  anchor_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminder_log_anchor ON reminder_log(anchor_utc);
ALTER TABLE attendees ADD COLUMN role TEXT;
UPDATE sync_state SET sync_token = NULL;
