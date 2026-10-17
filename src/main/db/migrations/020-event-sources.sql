-- Reference copy. The applied version is MIGRATION_020_SQL in database.ts.
--
-- The server's copy of each CalDAV event, so an edit made here keeps what other
-- clients stored that xrncal does not model (see src/main/ics/merge-ics.ts).
-- Clearing the CalDAV pull state reads every event once to fill it.
CREATE TABLE IF NOT EXISTS event_sources (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  ics TEXT NOT NULL
);
UPDATE sync_state SET sync_token = NULL
WHERE calendar_id IN (
  SELECT c.id FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE a.type = 'caldav'
);
