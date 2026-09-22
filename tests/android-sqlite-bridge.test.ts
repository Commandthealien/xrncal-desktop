import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createSqliteDriver } from '../src/android/platform/sqlite-driver'
import { NativeBridgeError } from '../src/android/native/bridge'
import { runMigrations, seedDefaultData } from '../src/main/db/database'
import { EventsRepo } from '../src/main/db/repos/events-repo'
import { CalendarsRepo } from '../src/main/db/repos/calendars-repo'

/**
 * Exercises the Android SQLite driver against a stub of the Kotlin bridge.
 *
 * The real host cannot run here, so `XrncalNative` is reimplemented on top of
 * `node:sqlite` following the same JSON-envelope protocol the Kotlin class
 * uses. That pins the contract from the TypeScript side: if the envelope
 * shape, the parameter marshalling or the savepoint handling drifts, this
 * fails in CI rather than on a device.
 *
 * What it does *not* cover, because they are genuinely native: the Keystore
 * cipher, the share sheet, and statement splitting (Kotlin's
 * SqlStatementSplitter, covered by SqlStatementSplitterTest.kt - node:sqlite's
 * exec() takes whole scripts, so the stub never needs to split).
 */

interface Envelope {
  ok: boolean
  value?: unknown
  error?: string
}

function ok(value: unknown = null): string {
  return JSON.stringify({ ok: true, value } satisfies Envelope)
}

function fail(err: unknown): string {
  return JSON.stringify({
    ok: false,
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  } satisfies Envelope)
}

/** Mirrors android/app/src/main/java/app/xrncal/android/XrncalNative.kt. */
function installNativeStub(): { close: () => void } {
  let raw: DatabaseSync | null = null

  const bridge = {
    dbOpen(path: string): string {
      try {
        raw?.close()
        raw = new DatabaseSync(path)
        raw.exec('PRAGMA foreign_keys = ON;')
        return ok()
      } catch (err) {
        return fail(err)
      }
    },
    dbExec(sql: string): string {
      try {
        raw!.exec(sql)
        return ok()
      } catch (err) {
        return fail(err)
      }
    },
    dbQuery(sql: string, paramsJson: string): string {
      try {
        const params = JSON.parse(paramsJson) as unknown[]
        // The Kotlin side returns integers as JS numbers, never BigInt.
        const rows = raw!.prepare(sql).all(...(params as never[]))
        return ok(
          rows.map((row) =>
            Object.fromEntries(
              Object.entries(row as Record<string, unknown>).map(([k, v]) => [
                k,
                typeof v === 'bigint' ? Number(v) : v
              ])
            )
          )
        )
      } catch (err) {
        return fail(err)
      }
    },
    dbRun(sql: string, paramsJson: string): string {
      try {
        const params = JSON.parse(paramsJson) as unknown[]
        const res = raw!.prepare(sql).run(...(params as never[]))
        return ok({
          changes: Number(res.changes ?? 0),
          lastInsertRowid: Number(res.lastInsertRowid ?? 0)
        })
      } catch (err) {
        return fail(err)
      }
    },
    dbClose(): string {
      try {
        raw?.close()
        raw = null
        return ok()
      } catch (err) {
        return fail(err)
      }
    },
    secureAvailable: () => true,
    secureEncrypt: (plaintext: string) => ok(Buffer.from(plaintext).toString('base64')),
    secureDecrypt: (b64: string) => ok(Buffer.from(b64, 'base64').toString('utf8')),
    appVersion: () => ok('0.1.0'),
    dirData: () => ok('/data'),
    dirCache: () => ok('/cache'),
    fsExists: () => false,
    fsMkdirs: () => ok(),
    fsReadBase64: () => ok(''),
    fsWriteBase64: () => ok(),
    fsUnlink: () => ok(),
    fsSize: () => ok(0),
    shareFile: () => ok()
  }

  const g = globalThis as unknown as { window?: unknown }
  const previous = g.window
  g.window = { XrncalNative: bridge }

  return {
    close: () => {
      try {
        raw?.close()
      } catch {
        // Already closed by the driver under test.
      }
      g.window = previous
    }
  }
}

describe('android sqlite driver over the native bridge', () => {
  let stub: { close: () => void }

  beforeEach(() => {
    stub = installNativeStub()
  })

  afterEach(() => {
    stub.close()
  })

  it('applies every migration to a fresh database', () => {
    const db = createSqliteDriver(':memory:')
    runMigrations(db)

    const version = db
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get<{ v: number }>()
    // Head is 014; a mismatch means a migration was added without the Android
    // path being re-checked.
    expect(version?.v).toBe(14)

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>()
      .map((r) => r.name)

    expect(tables).toEqual(
      expect.arrayContaining(['accounts', 'calendars', 'events', 'event_exceptions', 'settings'])
    )
  })

  it('round-trips an event through the real repo layer', () => {
    const db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)

    const calendars = new CalendarsRepo(db).listCalendars()
    expect(calendars.length).toBeGreaterThan(0)

    const events = new EventsRepo(db)
    const created = events.createEvent({
      calendarId: calendars[0].id,
      title: 'Cà phê',
      dtStartUtc: '2026-09-21T02:00:00.000Z',
      dtEndUtc: '2026-09-21T03:00:00.000Z',
      allDay: false
    })

    expect(created.id).toBeTruthy()

    const found = events.getEventById(created.id)
    expect(found?.event.title).toBe('Cà phê')

    const occurrences = events.queryEventsByRange(
      [calendars[0].id],
      '2026-09-20T00:00:00.000Z',
      '2026-09-22T00:00:00.000Z'
    )
    expect(occurrences.map((o) => o.title)).toContain('Cà phê')
  })

  it('binds integers, nulls and booleans the way the repos expect', () => {
    const db = createSqliteDriver(':memory:')
    db.exec('CREATE TABLE t (a INTEGER, b TEXT, c INTEGER)')

    // `dirty = 1` style flags are the classic breakage: a boolean or a float
    // bound where an integer is expected silently matches nothing.
    db.prepare('INSERT INTO t (a, b, c) VALUES (?, ?, ?)').run(1, null, true)

    const row = db.prepare('SELECT * FROM t WHERE a = ? AND c = ?').get<{
      a: number
      b: string | null
      c: number
    }>(1, 1)

    expect(row).toBeDefined()
    expect(row?.b).toBeNull()
    expect(row?.c).toBe(1)
  })

  it('reports a native failure as a thrown error, not a silent no-op', () => {
    const db = createSqliteDriver(':memory:')
    db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)')
    db.prepare('INSERT INTO t (a) VALUES (?)').run(1)

    // A constraint violation has to surface. The envelope exists precisely
    // because a raw throw across @JavascriptInterface arrives in JS as null.
    // toThrow matches the message, so the class is asserted separately.
    expect(() => db.prepare('INSERT INTO t (a) VALUES (?)').run(1)).toThrow(NativeBridgeError)
    expect(() => db.prepare('INSERT INTO t (a) VALUES (?)').run(1)).toThrow(/UNIQUE constraint/)
  })

  it('rolls back a failed nested transaction without unwinding the outer one', () => {
    const db = createSqliteDriver(':memory:')
    db.exec('CREATE TABLE t (a INTEGER)')

    db.transaction(() => {
      db.prepare('INSERT INTO t (a) VALUES (?)').run(1)

      // Repos nest transactions freely; a bare BEGIN would fail on re-entry,
      // which is why the driver uses savepoints.
      expect(() =>
        db.transaction(() => {
          db.prepare('INSERT INTO t (a) VALUES (?)').run(2)
          throw new Error('inner fails')
        })()
      ).toThrow('inner fails')

      db.prepare('INSERT INTO t (a) VALUES (?)').run(3)
    })()

    const rows = db.prepare('SELECT a FROM t ORDER BY a').all<{ a: number }>()
    expect(rows.map((r) => r.a)).toEqual([1, 3])
  })

  it('sees its own writes from inside a transaction', () => {
    // Regression guard for a bug that only appeared on a real device.
    //
    // Enabling WAL via SQLiteDatabase.enableWriteAheadLogging() puts Android
    // on a multi-connection pool, so a read issued inside an explicit
    // SAVEPOINT was served by a different connection and could not see that
    // transaction's uncommitted rows. EventsRepo.createEvent inserts and then
    // reads the row back, and importIcs wraps that in a transaction - so the
    // import reported "0 imported, N errors" while the rows had actually
    // landed. XrncalNative now sets `PRAGMA journal_mode = WAL` directly,
    // which keeps the journal but leaves the pool at one connection.
    //
    // node:sqlite is single-connection, so this passes here either way; it
    // exists to state the contract the Kotlin bridge has to honour.
    const db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)

    const calendars = new CalendarsRepo(db).listCalendars()
    const events = new EventsRepo(db)

    db.transaction(() => {
      const created = events.createEvent({
        calendarId: calendars[0].id,
        title: 'Read your writes',
        dtStartUtc: '2026-09-21T02:00:00.000Z',
        dtEndUtc: '2026-09-21T03:00:00.000Z',
        allDay: false
      })
      // The read-back the repo itself performs is what used to come back empty.
      expect(events.getEventById(created.id)?.event.title).toBe('Read your writes')
    })()

    expect(
      events.queryEventsByRange(
        [calendars[0].id],
        '2026-09-20T00:00:00.000Z',
        '2026-09-22T00:00:00.000Z'
      ).map((o) => o.title)
    ).toContain('Read your writes')
  })

  it('keeps full-text search working, which needs FTS5', () => {
    const db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)

    const calendars = new CalendarsRepo(db).listCalendars()
    const events = new EventsRepo(db)
    events.createEvent({
      calendarId: calendars[0].id,
      title: 'Standup with the team',
      dtStartUtc: '2026-09-21T02:00:00.000Z',
      dtEndUtc: '2026-09-21T03:00:00.000Z',
      allDay: false
    })

    expect(events.searchEvents('standup').map((e) => e.title)).toContain('Standup with the team')
  })
})
