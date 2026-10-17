-- Reference copy. The applied version is MIGRATION_015_SQL in database.ts.
--
-- Per-event reminders and the per-calendar default Google publishes, both as
-- JSON lists of { minutesBefore, method? }. NULL means "use the default" and
-- [] means "none". No backfill: NULL is already right for every existing row,
-- and an UPDATE would re-index each one through the FTS5 trigger.
ALTER TABLE events ADD COLUMN reminders TEXT;
ALTER TABLE calendars ADD COLUMN default_reminders TEXT;
