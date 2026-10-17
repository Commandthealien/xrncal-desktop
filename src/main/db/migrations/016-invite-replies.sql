-- Reference copy. The applied version is MIGRATION_016_SQL in database.ts.
--
-- Replying to invitations: `is_self` marks the account's own attendee row and
-- `rsvp_pending` holds a reply until the provider has accepted it.
-- `attendees_synced` says the local guest list is the provider's; until it is,
-- a push leaves guests alone. Clearing the sync positions re-reads every
-- calendar once, so the lists fill in straight away.
ALTER TABLE attendees ADD COLUMN is_self INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN rsvp_pending TEXT;
ALTER TABLE events ADD COLUMN attendees_synced INTEGER NOT NULL DEFAULT 0;
UPDATE sync_state SET sync_token = NULL;
