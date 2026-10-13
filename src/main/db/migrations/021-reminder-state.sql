-- Reference copy. The applied version is MIGRATION_021_SQL in database.ts.
--
-- Reminders on screen (snoozed_until NULL) and snoozed, so a restart keeps them.
CREATE TABLE IF NOT EXISTS reminder_state (
  occurrence_id TEXT PRIMARY KEY,
  snoozed_until TEXT
);
