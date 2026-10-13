-- Reference copy. The applied version is MIGRATION_017_SQL in database.ts.
--
-- Calendars subscribed to by URL (a published .ics feed): local, read-only,
-- refreshed from `subscription_url`.
ALTER TABLE calendars ADD COLUMN subscription_url TEXT;
ALTER TABLE calendars ADD COLUMN subscription_refreshed_at TEXT;
