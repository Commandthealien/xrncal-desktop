import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSqliteDriver, type ISqliteDatabase } from '../src/main/db/sqlite-driver'
import { runMigrations, seedDefaultData } from '../src/main/db/database'
import { MicrosoftSyncEngine } from '../src/main/sync/microsoft-sync-engine'

/**
 * The Microsoft pull listed the whole calendar on every poll and rewrote every
 * row, and never removed an event deleted in Outlook - the listing just stopped
 * mentioning it. These pin the three rules that replaced that: unchanged rows
 * are skipped by etag, a complete listing removes what is gone, and polls
 * between full listings ask only for what changed.
 */

const CAL = 'cal_graph'

function graphEvent(id: string, opts: { etag?: string; modified?: string } = {}) {
  return {
    id,
    subject: `Event ${id}`,
    start: { dateTime: '2026-04-01T09:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-04-01T10:00:00.0000000', timeZone: 'UTC' },
    '@odata.etag': opts.etag ?? `W/"etag-${id}"`,
    lastModifiedDateTime: opts.modified ?? '2026-04-01T08:00:00.0000000Z'
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response
}

function count(db: ISqliteDatabase, where = '1 = 1'): number {
  return db
    .prepare(`SELECT COUNT(*) c FROM events WHERE calendar_id = ? AND ${where}`)
    .get<{ c: number }>(CAL)!.c
}

describe('Microsoft pull', () => {
  let db: ISqliteDatabase

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO calendars (id, account_id, name, color, is_visible, is_read_only, is_default, created_at, updated_at)
       VALUES (?, 'account-local-primary', 'Outlook', '#000000', 1, 0, 0, ?, ?)`
    ).run(CAL, now, now)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /** A calendar listed in full long ago: the next poll lists it again. */
  const forceFullListing = () =>
    db
      .prepare('UPDATE sync_state SET sync_token = ? WHERE calendar_id = ?')
      .run(JSON.stringify({ fullAt: '2000-01-01T00:00:00.000Z' }), CAL)

  it('removes a synced event the listing no longer mentions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ value: [graphEvent('a'), graphEvent('b')] })))
    await new MicrosoftSyncEngine(db).pullCalendarEvents(CAL, 'token')
    expect(count(db)).toBe(2)

    // Not yet pushed, an unsent edit, and a lunar master - none of them may go.
    const now = new Date().toISOString()
    const insert = db.prepare(
      `INSERT INTO events (id, calendar_id, uid, title, dtstart_utc, dtend_utc, etag, dirty, lunar_rule, created_at, updated_at)
       VALUES (?, ?, ?, 'x', '2026-04-02T09:00:00.000Z', '2026-04-02T10:00:00.000Z', ?, ?, ?, ?, ?)`
    )
    insert.run('evt_local', CAL, 'u1', null, 1, null, now, now)
    insert.run('evt_dirty', CAL, 'u2', 'W/"old"', 1, null, now, now)
    insert.run('evt_lunar', CAL, 'u3', null, 0, '{"day":1,"month":1,"leap":false}', now, now)

    // Force a full listing on the next poll; "b" has been deleted in Outlook.
    forceFullListing()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ value: [graphEvent('a')] })))
    const res = await new MicrosoftSyncEngine(db).pullCalendarEvents(CAL, 'token')

    expect(res.pulledCount).toBe(1)
    const ids = db
      .prepare('SELECT id FROM events WHERE calendar_id = ? ORDER BY id')
      .all<{ id: string }>(CAL)
      .map((r) => r.id)
    expect(ids).toEqual(['a', 'evt_dirty', 'evt_local', 'evt_lunar'])
  })

  it('leaves rows alone when their etag has not changed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ value: [graphEvent('a')] })))
    await new MicrosoftSyncEngine(db).pullCalendarEvents(CAL, 'token')
    db.prepare("UPDATE events SET updated_at = 'marker' WHERE id = 'a'").run()

    forceFullListing()
    const res = await new MicrosoftSyncEngine(db).pullCalendarEvents(CAL, 'token')

    // Nothing changed, so nothing is reported - the renderer is not told to reload.
    expect(res.pulledCount).toBe(0)
    expect(db.prepare("SELECT updated_at FROM events WHERE id = 'a'").get<{ updated_at: string }>()!.updated_at).toBe(
      'marker'
    )
  })

  it('rewrites every row when the calendar has no pull state, as after a migration clears it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ value: [graphEvent('a')] })))
    await new MicrosoftSyncEngine(db).pullCalendarEvents(CAL, 'token')
    db.prepare("UPDATE events SET updated_at = 'marker' WHERE id = 'a'").run()

    db.prepare('UPDATE sync_state SET sync_token = NULL WHERE calendar_id = ?').run(CAL)
    const res = await new MicrosoftSyncEngine(db).pullCalendarEvents(CAL, 'token')

    expect(res.pulledCount).toBe(1)
    expect(db.prepare("SELECT updated_at FROM events WHERE id = 'a'").get<{ updated_at: string }>()!.updated_at).not.toBe(
      'marker'
    )
  })

  it('asks only for changes between full listings, from the newest modification seen', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.includes('filter')) {
          return jsonResponse({
            value: [graphEvent('c', { modified: '2026-04-03T08:00:00.0000000Z' })]
          })
        }
        return jsonResponse({
          value: [
            graphEvent('a', { modified: '2026-04-01T08:00:00.0000000Z' }),
            graphEvent('b', { modified: '2026-04-02T08:00:00.0000000Z' })
          ]
        })
      })
    )

    const engine = new MicrosoftSyncEngine(db)
    await engine.pullCalendarEvents(CAL, 'token')
    await engine.pullCalendarEvents(CAL, 'token')

    expect(calls).toHaveLength(2)
    expect(calls[0]).not.toContain('filter')
    expect(decodeURIComponent(calls[1])).toContain('$filter=lastModifiedDateTime ge 2026-04-02T08:00:00.0000000Z')
    // An incremental poll never deletes: "a" and "b" were simply unchanged.
    expect(count(db)).toBe(3)

    const third: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        third.push(url)
        return jsonResponse({ value: [] })
      })
    )
    await engine.pullCalendarEvents(CAL, 'token')
    expect(decodeURIComponent(third[0])).toContain('ge 2026-04-03T08:00:00.0000000Z')
  })

  it('lists in full again once the interval has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-04-10T12:00:00Z'))
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({ value: [graphEvent('a')] })
      })
    )

    const engine = new MicrosoftSyncEngine(db)
    await engine.pullCalendarEvents(CAL, 'token')
    vi.setSystemTime(new Date('2026-04-10T12:05:00Z'))
    await engine.pullCalendarEvents(CAL, 'token')
    vi.setSystemTime(new Date('2026-04-10T12:11:00Z'))
    await engine.pullCalendarEvents(CAL, 'token')

    expect(calls.map((u) => u.includes('filter'))).toEqual([false, true, false])
  })

  it('falls back to a full listing when Graph rejects the filter', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.includes('filter')) return jsonResponse({ error: { code: 'BadRequest' } }, 400)
        return jsonResponse({ value: [graphEvent('a')] })
      })
    )

    const engine = new MicrosoftSyncEngine(db)
    await engine.pullCalendarEvents(CAL, 'token')
    await expect(engine.pullCalendarEvents(CAL, 'token')).resolves.toBeDefined()

    expect(calls.map((u) => u.includes('filter'))).toEqual([false, true, false])
  })
})
