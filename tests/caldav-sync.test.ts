import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSqliteDriver, type ISqliteDatabase } from '../src/main/db/sqlite-driver'
import { runMigrations, seedDefaultData } from '../src/main/db/database'
import { EventsRepo } from '../src/main/db/repos/events-repo'
import { CalDavSyncEngine } from '../src/main/sync/caldav-sync-engine'
import type { CalDavCredentials } from '../src/main/sync/caldav-adapter'
import { SecureStore } from '../src/main/secure-store'
import { SyncStateRepo } from '../src/main/db/repos/sync-state-repo'

/**
 * The CalDAV pull used to key every event by its UID, but an event created in
 * xrncal keeps its own id, so the first pull after pushing it inserted a second
 * copy. It also never noticed an event deleted on the server, and pushes and
 * deletes guessed the address as `<uid>.ics`, which is only where xrncal puts
 * the events it creates - another client may name the resource anything.
 *
 * It also dropped a series' EXDATEs and RECURRENCE-ID overrides, and fetched the
 * whole calendar on every 20-second poll even when its ctag said nothing changed.
 */

const CAL = 'https://dav.example/sonn/personal/'
const CREDS: CalDavCredentials = { url: 'https://dav.example/sonn/', username: 'sonn', password: 'pw' }

interface ServerItem {
  name: string
  uid: string
  title: string
  etag: string
  ics?: string
}

function vevent(uid: string, title: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261010T000000Z',
    'DTSTART:20261010T010000Z',
    'DTEND:20261010T013000Z',
    `SUMMARY:${title}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n')
}

/** What a server does to text inside XML, calendar-data included. */
function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function multistatus(items: ServerItem[], withData = true): string {
  const responses = items
    .map(
      (i) => `<D:response><D:href>/sonn/personal/${i.name}</D:href><D:propstat><D:prop>` +
        `<D:getetag>${xmlEscape(i.etag)}</D:getetag>` +
        (withData ? `<C:calendar-data>${xmlEscape(i.ics ?? vevent(i.uid, i.title))}</C:calendar-data>` : '') +
        `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    )
    .join('')
  return `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}</D:multistatus>`
}

function response(status: number, body = '', headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    text: async () => body,
    body: new Response(body).body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }
  } as unknown as Response
}

function calendarListing(ctag: string): string {
  return `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/">` +
    `<D:response><D:href>/sonn/personal/</D:href><D:propstat><D:prop>` +
    `<D:resourcetype><D:collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:resourcetype>` +
    `<D:displayname>Personal</D:displayname><CS:getctag>${ctag}</CS:getctag>` +
    `<D:current-user-privilege-set><D:privilege><D:write/></D:privilege></D:current-user-privilege-set>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`
}

let putBodies: string[] = []
/** Each REPORT: `query` (whole calendar), `etags` (listing only) or the resource names a multiget asked for. */
let reports: string[] = []

/**
 * A fake server: PROPFIND lists the calendar with `ctag`, REPORT lists `items`
 * (with their data, or only etags) or fetches the ones a multiget names;
 * every other request is recorded and answered. `gone` are listed but deleted
 * before a multiget reaches them.
 */
function stubServer(
  items: ServerItem[],
  ctag = 'ctag-1',
  options: { multiget?: boolean; gone?: string[]; putStatus?: number } = {}
): { method: string; url: string }[] {
  const calls: { method: string; url: string }[] = []
  putBodies = []
  reports = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET'
      calls.push({ method, url })
      if (method === 'PROPFIND') return response(207, calendarListing(ctag))
      if (method === 'REPORT') {
        const body = String(init.body)
        if (body.includes('calendar-multiget')) {
          if (options.multiget === false) return response(405)
          const names = [...body.matchAll(/<D:href>\/sonn\/personal\/([^<]+)<\/D:href>/g)].map((m) => m[1])
          reports.push(names.join(','))
          return response(207, multistatus(items.filter((i) => names.includes(i.name) && !options.gone?.includes(i.name))))
        }
        const withData = body.includes('calendar-data')
        reports.push(withData ? 'query' : 'etags')
        return response(207, multistatus(items, withData))
      }
      if (method === 'PUT') {
        if (options.putStatus) return response(options.putStatus, 'refused')
        putBodies.push(String(init.body))
        return response(204, '', { etag: '"etag-after-put"' })
      }
      return response(204)
    })
  )
  return calls
}

/** A weekly series with one cancelled week (EXDATE) and one moved week (RECURRENCE-ID). */
function series(overrides: { moved?: boolean } = {}): string {
  const moved = overrides.moved ?? true
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    'UID:uid-series',
    'DTSTAMP:20261010T000000Z',
    'DTSTART:20261005T010000Z',
    'DTEND:20261005T020000Z',
    'RRULE:FREQ=WEEKLY',
    'EXDATE:20261012T010000Z',
    'SUMMARY:Weekly',
    'END:VEVENT',
    ...(moved
      ? [
          'BEGIN:VEVENT',
          'UID:uid-series',
          'DTSTAMP:20261010T000000Z',
          'RECURRENCE-ID:20261019T010000Z',
          'DTSTART:20261019T050000Z',
          'DTEND:20261019T060000Z',
          'SUMMARY:Weekly (moved)',
          'END:VEVENT'
        ]
      : []),
    'END:VCALENDAR'
  ].join('\r\n')
}

describe('CalDAV sync', () => {
  let db: ISqliteDatabase
  let repo: EventsRepo
  let engine: CalDavSyncEngine

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO calendars (id, account_id, name, color, is_visible, is_read_only, is_default, created_at, updated_at)
       VALUES (?, 'account-local-primary', 'Personal', '#000000', 1, 0, 0, ?, ?)`
    ).run(CAL, now, now)
    repo = new EventsRepo(db)
    engine = new CalDavSyncEngine(db)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const rows = () =>
    db
      .prepare('SELECT id, uid, title, provider_event_id FROM events WHERE calendar_id = ? ORDER BY id')
      .all<{ id: string; uid: string; title: string; provider_event_id: string | null }>(CAL)

  it('updates an event xrncal pushed instead of inserting a copy', async () => {
    const created = repo.createEvent({
      calendarId: CAL,
      title: 'Made here',
      dtStartUtc: '2026-10-10T01:00:00.000Z',
      dtEndUtc: '2026-10-10T01:30:00.000Z'
    })
    const calls = stubServer([])
    await engine.pushDirtyEvents(CAL, CREDS)
    expect(calls[0]).toEqual({ method: 'PUT', url: `${CAL}${encodeURIComponent(created.uid)}.ics` })

    stubServer([{ name: `${created.uid}.ics`, uid: created.uid, title: 'Edited on the phone', etag: '"e2"' }])
    await engine.pullCalendarEvents(CAL, CREDS)

    expect(rows()).toEqual([
      {
        id: created.id,
        uid: created.uid,
        title: 'Edited on the phone',
        provider_event_id: `https://dav.example/sonn/personal/${created.uid}.ics`
      }
    ])
  })

  it('folds a copy left by the old pull back into the event it duplicated', async () => {
    const created = repo.createEvent({
      calendarId: CAL,
      title: 'Made here',
      dtStartUtc: '2026-10-10T01:00:00.000Z',
      dtEndUtc: '2026-10-10T01:30:00.000Z'
    })
    db.prepare("UPDATE events SET dirty = 0, etag = '\"e1\"' WHERE id = ?").run(created.id)
    db.prepare(
      `INSERT INTO events (id, calendar_id, uid, title, dtstart_utc, dtend_utc, tzid, etag, dirty, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, 'Made here', '2026-10-10T01:00:00.000Z', '2026-10-10T01:30:00.000Z', 'UTC', '"e1"', 0, 0, '', '')`
    ).run(created.uid, CAL, created.uid)

    stubServer([{ name: `${created.uid}.ics`, uid: created.uid, title: 'Made here', etag: '"e1"' }])
    await engine.pullCalendarEvents(CAL, CREDS)

    expect(rows().map((r) => r.id)).toEqual([created.id])
  })

  it('deletes an event that is gone from the server, and nothing that has not synced', async () => {
    stubServer([
      { name: 'a.ics', uid: 'uid-a', title: 'Stays', etag: '"a"' },
      { name: 'b.ics', uid: 'uid-b', title: 'Deleted on the phone', etag: '"b"' }
    ])
    await engine.pullCalendarEvents(CAL, CREDS)
    const unsent = repo.createEvent({
      calendarId: CAL,
      title: 'Not pushed yet',
      dtStartUtc: '2026-10-11T01:00:00.000Z',
      dtEndUtc: '2026-10-11T01:30:00.000Z'
    })

    stubServer([{ name: 'a.ics', uid: 'uid-a', title: 'Stays', etag: '"a"' }])
    await engine.pullCalendarEvents(CAL, CREDS)

    expect(rows().map((r) => r.title).sort()).toEqual(['Not pushed yet', 'Stays'])
    expect(rows().some((r) => r.id === unsent.id)).toBe(true)
  })

  it('removes nothing when an item fails to parse', async () => {
    stubServer([
      { name: 'a.ics', uid: 'uid-a', title: 'A', etag: '"a"' },
      { name: 'b.ics', uid: 'uid-b', title: 'B', etag: '"b"' }
    ])
    await engine.pullCalendarEvents(CAL, CREDS)

    stubServer([
      { name: 'a.ics', uid: 'uid-a', title: 'A', etag: '"a"' },
      { name: 'b.ics', uid: 'uid-b', title: 'B', etag: '"b2"', ics: 'not a calendar' }
    ])
    await engine.pullCalendarEvents(CAL, CREDS)

    expect(rows().map((r) => r.title).sort()).toEqual(['A', 'B'])
  })

  it('edits and deletes a server-made event at the address the server listed it under', async () => {
    stubServer([{ name: 'onecal-1234.ics', uid: 'uid-from-phone', title: 'Made on the phone', etag: '"p1"' }])
    await engine.pullCalendarEvents(CAL, CREDS)
    const href = 'https://dav.example/sonn/personal/onecal-1234.ics'
    const id = rows()[0].id

    repo.updateEvent(id, { title: 'Edited here' })
    let calls = stubServer([])
    await engine.pushDirtyEvents(CAL, CREDS)
    expect(calls).toEqual([{ method: 'PUT', url: href }])

    repo.deleteEvent(id)
    calls = stubServer([])
    await engine.pushDirtyEvents(CAL, CREDS)
    expect(calls).toEqual([{ method: 'DELETE', url: href }])
  })

  it('undoes the XML escaping of calendar data', async () => {
    stubServer([{ name: 'r.ics', uid: 'uid-r', title: 'R&D <draft> & co', etag: '"r"' }])
    await engine.pullCalendarEvents(CAL, CREDS)

    expect(rows().map((r) => r.title)).toEqual(['R&D <draft> & co'])
  })

  it('keeps the same UID in two calendars as two events', async () => {
    const other = 'https://dav.example/sonn/work/'
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO calendars (id, account_id, name, color, is_visible, is_read_only, is_default, created_at, updated_at)
       VALUES (?, 'account-local-primary', 'Work', '#000000', 1, 0, 0, ?, ?)`
    ).run(other, now, now)

    stubServer([{ name: 'x.ics', uid: 'shared-uid', title: 'In Personal', etag: '"p"' }])
    await engine.pullCalendarEvents(CAL, CREDS)
    stubServer([{ name: 'x.ics', uid: 'shared-uid', title: 'In Work', etag: '"w"' }])
    await engine.pullCalendarEvents(other, CREDS)
    await engine.pullCalendarEvents(other, CREDS)

    const titles = db
      .prepare("SELECT calendar_id, title FROM events WHERE uid = 'shared-uid' ORDER BY title")
      .all<{ calendar_id: string; title: string }>()
    expect(titles).toEqual([
      { calendar_id: CAL, title: 'In Personal' },
      { calendar_id: other, title: 'In Work' }
    ])
  })

  const seriesRow = () =>
    db.prepare("SELECT id, exdate FROM events WHERE uid = 'uid-series'").get<{ id: string; exdate: string | null }>()!

  it("keeps a series' cancelled and moved occurrences", async () => {
    stubServer([{ name: 'series.ics', uid: 'uid-series', title: 'Weekly', etag: '"s1"', ics: series() }])
    await engine.pullCalendarEvents(CAL, CREDS)

    const master = seriesRow()
    expect(master.exdate).toBe('2026-10-12T01:00:00.000Z')
    const exceptions = repo.getExceptionsForEvent(master.id)
    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]).toMatchObject({
      originalStartUtc: '2026-10-19T01:00:00.000Z',
      dtStartUtc: '2026-10-19T05:00:00.000Z',
      title: 'Weekly (moved)'
    })
  })

  it('drops an override the server no longer has, but not one with unsent edits', async () => {
    stubServer([{ name: 'series.ics', uid: 'uid-series', title: 'Weekly', etag: '"s1"', ics: series() }])
    await engine.pullCalendarEvents(CAL, CREDS)
    const master = seriesRow()
    repo.upsertException({ masterEventId: master.id, originalStartUtc: '2026-10-26T01:00:00.000Z', isCancelled: true })

    stubServer([{ name: 'series.ics', uid: 'uid-series', title: 'Weekly', etag: '"s2"', ics: series({ moved: false }) }])
    await engine.pullCalendarEvents(CAL, CREDS)

    expect(repo.getExceptionsForEvent(master.id).map((e) => e.originalStartUtc)).toEqual(['2026-10-26T01:00:00.000Z'])
  })

  it('sends the moved occurrence and the cancelled date back when the series is pushed', async () => {
    stubServer([{ name: 'series.ics', uid: 'uid-series', title: 'Weekly', etag: '"s1"', ics: series() }])
    await engine.pullCalendarEvents(CAL, CREDS)
    repo.updateEvent(seriesRow().id, { title: 'Weekly (renamed)' })

    stubServer([])
    await engine.pushDirtyEvents(CAL, CREDS)

    expect(putBodies).toHaveLength(1)
    expect(putBodies[0]).toContain('RECURRENCE-ID')
    expect(putBodies[0]).toContain('EXDATE')
  })

  it('skips the download while the calendar ctag is unchanged', async () => {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO accounts (id, type, name, email, is_active, created_at, updated_at)
       VALUES ('acc_caldav_test', 'caldav', 'Home server', 'sonn', 1, ?, ?)`
    ).run(now, now)
    vi.spyOn(SecureStore.prototype, 'getToken').mockReturnValue(CREDS as never)
    const reportCount = (calls: { method: string }[]) => calls.filter((c) => c.method === 'REPORT').length
    const a = { name: 'a.ics', uid: 'uid-a', title: 'A', etag: '"a"' }
    const b = { name: 'b.ics', uid: 'uid-b', title: 'B', etag: '"b"' }

    let calls = stubServer([a], 'ctag-1')
    await engine.syncAll()
    expect(reportCount(calls)).toBe(1)

    calls = stubServer([a], 'ctag-1')
    await engine.syncAll()
    expect(reportCount(calls)).toBe(0)

    // A changed ctag lists the etags, then fetches only what is new.
    calls = stubServer([a, b], 'ctag-2')
    await engine.syncAll()
    expect(reports).toEqual(['etags', 'b.ics'])
    expect(rows().map((r) => r.title).sort()).toEqual(['A', 'B'])
  })

  it('keeps what another app stored on an event when it is edited here', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//OneCal//EN',
      'BEGIN:VEVENT',
      'UID:uid-rich',
      'DTSTAMP:20261010T000000Z',
      'DTSTART:20261010T010000Z',
      'DTEND:20261010T013000Z',
      'SUMMARY:Dentist',
      'CATEGORIES:Health',
      'CLASS:PRIVATE',
      'X-ONECAL-COLOR-ID:7',
      'BEGIN:VALARM',
      'ACTION:EMAIL',
      'TRIGGER:-P1D',
      'SUMMARY:Dentist',
      'DESCRIPTION:Tomorrow',
      'ATTENDEE:mailto:sonn@example.com',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n')
    stubServer([{ name: 'rich.ics', uid: 'uid-rich', title: 'Dentist', etag: '"r1"', ics }])
    await engine.pullCalendarEvents(CAL, CREDS)
    const id = rows().find((r) => r.uid === 'uid-rich')!.id
    repo.updateEvent(id, { title: 'Dentist (moved clinic)' })

    stubServer([])
    await engine.pushDirtyEvents(CAL, CREDS)

    expect(putBodies).toHaveLength(1)
    const body = putBodies[0]
    expect(body).toContain('SUMMARY:Dentist (moved clinic)')
    expect(body).toContain('CATEGORIES:Health')
    expect(body).toContain('CLASS:PRIVATE')
    expect(body).toContain('X-ONECAL-COLOR-ID:7')
    expect(body).toContain('ACTION:EMAIL')
    expect(body).not.toContain('METHOD')

    // What was sent is the copy the next edit starts from.
    const stored = db.prepare('SELECT ics FROM event_sources WHERE event_id = ?').get<{ ics: string }>(id)!.ics
    expect(stored).toBe(body)
  })

  describe('when the account cannot sync', () => {
    beforeEach(() => {
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO accounts (id, type, name, email, is_active, created_at, updated_at)
         VALUES ('acc_caldav_test', 'caldav', 'Home server', 'sonn', 1, ?, ?)`
      ).run(now, now)
    })

    it('says the server could not be reached, with the reason fetch keeps on its cause', async () => {
      vi.spyOn(SecureStore.prototype, 'getToken').mockReturnValue(CREDS as never)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 100.68.210.10:443') })
        })
      )

      const res = await engine.syncAll()

      expect(res.success).toBe(false)
      expect(res.accountErrors).toEqual({ acc_caldav_test: 'fetch failed: connect ECONNREFUSED 100.68.210.10:443' })
    })

    it('says the saved password could not be read, instead of skipping the account quietly', async () => {
      vi.spyOn(SecureStore.prototype, 'getToken').mockReturnValue(null)

      const res = await engine.syncAll()

      expect(res.errorCount).toBe(1)
      expect(res.accountErrors?.acc_caldav_test).toMatch(/keyring/)
    })

    it('reports an edit the server refuses', async () => {
      vi.spyOn(SecureStore.prototype, 'getToken').mockReturnValue(CREDS as never)
      repo.createEvent({
        calendarId: CAL,
        title: 'Refused',
        dtStartUtc: '2026-10-10T01:00:00.000Z',
        dtEndUtc: '2026-10-10T01:30:00.000Z'
      })
      stubServer([], 'ctag-1', { putStatus: 403 })

      const res = await engine.syncAll()

      expect(res.accountErrors?.acc_caldav_test).toMatch(/HTTP 403/)
    })
  })

  describe('once the calendar has been pulled', () => {
    const a = { name: 'a.ics', uid: 'uid-a', title: 'A', etag: '"a"' }
    const b = { name: 'b.ics', uid: 'uid-b', title: 'B', etag: '"b"' }
    const c = { name: 'c.ics', uid: 'uid-c', title: 'C', etag: '"c"' }
    const updatedAt = (uid: string) =>
      db.prepare('SELECT updated_at FROM events WHERE uid = ?').get<{ updated_at: string }>(uid)?.updated_at

    beforeEach(async () => {
      stubServer([a, b, c])
      await engine.pullCalendarEvents(CAL, CREDS)
      new SyncStateRepo(db).saveSyncToken(CAL, 'ctag-1')
      db.prepare("UPDATE events SET updated_at = 'untouched'").run()
    })

    it('downloads and rewrites only the events whose etag changed', async () => {
      const d = { name: 'd.ics', uid: 'uid-d', title: 'D', etag: '"d"' }
      stubServer([a, { ...b, title: 'B edited', etag: '"b2"' }, c, d])
      const res = await engine.pullCalendarEvents(CAL, CREDS)

      expect(reports).toEqual(['etags', 'b.ics,d.ics'])
      expect(res.pulledCount).toBe(2)
      expect(rows().map((r) => r.title).sort()).toEqual(['A', 'B edited', 'C', 'D'])
      expect(updatedAt('uid-a')).toBe('untouched')
      expect(updatedAt('uid-c')).toBe('untouched')
    })

    it('removes an event deleted on the server without downloading anything', async () => {
      stubServer([a, c])
      const res = await engine.pullCalendarEvents(CAL, CREDS)

      expect(reports).toEqual(['etags'])
      expect(res.pulledCount).toBe(1)
      expect(rows().map((r) => r.title).sort()).toEqual(['A', 'C'])
    })

    it('falls back to the whole calendar when the server will not multiget, still writing only changes', async () => {
      stubServer([a, { ...b, title: 'B edited', etag: '"b2"' }, c], 'ctag-2', { multiget: false })
      await engine.pullCalendarEvents(CAL, CREDS)

      expect(reports).toEqual(['etags', 'query'])
      expect(rows().map((r) => r.title).sort()).toEqual(['A', 'B edited', 'C'])
      expect(updatedAt('uid-a')).toBe('untouched')
    })

    it('removes nothing when a changed event is gone before it can be fetched', async () => {
      // c was deleted on the server, and b changed and then went too.
      stubServer([a, { ...b, etag: '"b2"' }], 'ctag-2', { gone: ['b.ics'] })
      await engine.pullCalendarEvents(CAL, CREDS)

      expect(rows().map((r) => r.title).sort()).toEqual(['A', 'B', 'C'])

      stubServer([a])
      await engine.pullCalendarEvents(CAL, CREDS)
      expect(rows().map((r) => r.title)).toEqual(['A'])
    })

    it('fetches an event pushed from here once, to take the address the server lists it under', async () => {
      const created = repo.createEvent({
        calendarId: CAL,
        title: 'Made here',
        dtStartUtc: '2026-10-10T01:00:00.000Z',
        dtEndUtc: '2026-10-10T01:30:00.000Z'
      })
      stubServer([a, b, c])
      await engine.pushDirtyEvents(CAL, CREDS)
      const made = { name: `${created.uid}.ics`, uid: created.uid, title: 'Made here', etag: '"etag-after-put"' }

      // The PUT went to `%40` in the UID; the server lists it with `@`.
      stubServer([a, b, c, made])
      await engine.pullCalendarEvents(CAL, CREDS)
      expect(reports).toEqual(['etags', made.name])
      stubServer([a, b, c, made])
      await engine.pullCalendarEvents(CAL, CREDS)

      expect(reports).toEqual(['etags'])
      expect(rows().filter((r) => r.title === 'Made here').map((r) => r.id)).toEqual([created.id])
    })
  })
})
