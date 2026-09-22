package app.xrncal.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The splitter is the one place where Android needs logic the desktop build
 * does not have, and it runs before anything else: if it cuts a migration in
 * the wrong place the app cannot open its database at all. Migration 002 is
 * the hard case and is reproduced here verbatim from
 * `src/main/db/database.ts`.
 */
class SqlStatementSplitterTest {

    /** Copied from MIGRATION_002_SQL in src/main/db/database.ts. */
    private val migration002 = """
CREATE TABLE IF NOT EXISTS attendees (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  response_status TEXT NOT NULL DEFAULT 'needsAction',
  is_organizer INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attendees_event_id ON attendees(event_id);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  event_id UNINDEXED,
  title,
  notes,
  location,
  content=''
);

CREATE TRIGGER IF NOT EXISTS trg_events_fts_insert AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(event_id, title, notes, location)
  VALUES (new.id, new.title, COALESCE(new.notes, ''), COALESCE(new.location, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_events_fts_update AFTER UPDATE ON events BEGIN
  DELETE FROM events_fts WHERE event_id = old.id;
  INSERT INTO events_fts(event_id, title, notes, location)
  VALUES (new.id, new.title, COALESCE(new.notes, ''), COALESCE(new.location, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_events_fts_delete AFTER DELETE ON events BEGIN
  DELETE FROM events_fts WHERE event_id = old.id;
END;

-- Populate FTS table with existing events
INSERT OR IGNORE INTO events_fts(event_id, title, notes, location)
SELECT id, title, COALESCE(notes, ''), COALESCE(location, '') FROM events;
"""

    @Test
    fun `migration 002 splits into its seven statements`() {
        val statements = SqlStatementSplitter.split(migration002)
        assertEquals(
            "expected table, index, virtual table, three triggers and the backfill",
            7,
            statements.size
        )
    }

    @Test
    fun `trigger bodies survive intact`() {
        val statements = SqlStatementSplitter.split(migration002)
        val update = statements.single { it.contains("trg_events_fts_update") }

        // The body's own terminators must not have ended the statement early.
        assertTrue("trigger lost its DELETE", update.contains("DELETE FROM events_fts"))
        assertTrue("trigger lost its INSERT", update.contains("INSERT INTO events_fts"))
        assertTrue("trigger was not closed", update.trimEnd().endsWith("END"))
    }

    @Test
    fun `no statement is left holding a bare terminator`() {
        for (statement in SqlStatementSplitter.split(migration002)) {
            assertTrue("empty statement emitted", statement.isNotBlank())
            assertTrue("statement kept its trailing ';': $statement", !statement.endsWith(";"))
        }
    }

    @Test
    fun `semicolons inside string literals are not boundaries`() {
        val sql = "INSERT INTO t(a) VALUES ('one; two'); SELECT 1;"
        val statements = SqlStatementSplitter.split(sql)
        assertEquals(2, statements.size)
        assertTrue(statements[0].contains("'one; two'"))
    }

    @Test
    fun `escaped quotes do not end a literal early`() {
        // VACUUM INTO escapes quotes in the destination path this way.
        val sql = "VACUUM INTO '/data/it''s here.sqlite'; SELECT 1;"
        val statements = SqlStatementSplitter.split(sql)
        assertEquals(2, statements.size)
        assertTrue(statements[0].contains("it''s here"))
    }

    @Test
    fun `comments containing semicolons are not boundaries`() {
        val sql = """
            -- a comment; with a semicolon
            SELECT 1;
            /* block; comment */
            SELECT 2;
        """
        assertEquals(2, SqlStatementSplitter.split(sql).size)
    }

    @Test
    fun `a CASE inside a trigger does not close the body early`() {
        // No current migration does this, but END is shared between CASE and a
        // trigger body, so the tracking is asserted rather than assumed.
        val sql = """
            CREATE TRIGGER t AFTER INSERT ON x BEGIN
              UPDATE y SET a = CASE WHEN new.b > 0 THEN 1 ELSE 0 END;
              UPDATE y SET c = 2;
            END;
            SELECT 1;
        """
        val statements = SqlStatementSplitter.split(sql)
        assertEquals(2, statements.size)
        assertTrue(statements[0].contains("UPDATE y SET c = 2"))
    }

    @Test
    fun `a trailing statement without a terminator is still emitted`() {
        assertEquals(1, SqlStatementSplitter.split("SELECT 1").size)
    }

    @Test
    fun `whitespace and comment-only input yields nothing`() {
        assertEquals(0, SqlStatementSplitter.split("   \n  -- nothing here\n ").size)
        assertEquals(0, SqlStatementSplitter.split(";;;").size)
    }

    @Test
    fun `keyword matching respects word boundaries`() {
        // ENDING / BEGINNING must not be read as END / BEGIN.
        val sql = """
            CREATE TRIGGER t AFTER INSERT ON x BEGIN
              UPDATE y SET ending = 1;
            END;
        """
        assertEquals(1, SqlStatementSplitter.split(sql).size)
    }
}
