-- Reference copy. The applied version is MIGRATION_019_SQL in database.ts.
--
-- Migration 002's contentless index read event_id back as NULL, so search never
-- matched through it and its update trigger scanned the whole index on every
-- UPDATE without removing the old entry. This one reads its text from events by
-- rowid, re-indexes only when title, notes or location change, and folds
-- diacritics ("gio" finds "Giỗ").
DROP TRIGGER IF EXISTS trg_events_fts_insert;
DROP TRIGGER IF EXISTS trg_events_fts_update;
DROP TRIGGER IF EXISTS trg_events_fts_delete;
DROP TABLE IF EXISTS events_fts;

CREATE VIRTUAL TABLE events_fts USING fts5(
  title,
  notes,
  location,
  content='events',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER trg_events_fts_insert AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, title, notes, location)
  VALUES (new.rowid, new.title, new.notes, new.location);
END;

CREATE TRIGGER trg_events_fts_update AFTER UPDATE OF title, notes, location ON events
WHEN old.title IS NOT new.title OR old.notes IS NOT new.notes OR old.location IS NOT new.location
BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, notes, location)
  VALUES ('delete', old.rowid, old.title, old.notes, old.location);
  INSERT INTO events_fts(rowid, title, notes, location)
  VALUES (new.rowid, new.title, new.notes, new.location);
END;

CREATE TRIGGER trg_events_fts_delete AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, notes, location)
  VALUES ('delete', old.rowid, old.title, old.notes, old.location);
END;

INSERT INTO events_fts(events_fts) VALUES ('rebuild');
