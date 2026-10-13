import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSqliteDriver, type ISqliteDatabase } from '../src/main/db/sqlite-driver'
import { runMigrations, seedDefaultData } from '../src/main/db/database'
import {
  normaliseSubscriptionUrl,
  addSubscription,
  refreshSubscription,
  refreshDueSubscriptions,
  SUBSCRIPTION_REFRESH_MS
} from '../src/main/subscriptions/ics-subscription'

function feed(events: { uid: string; summary: string; start: string }[], name = 'Fixtures'): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `X-WR-CALNAME:${name}`,
    ...events.flatMap((e) => [
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTART:${e.start}`,
      `DTEND:${e.start.replace(/T(\d\d)/, (_m, h) => `T${String(Number(h) + 1).padStart(2, '0')}`)}`,
      `SUMMARY:${e.summary}`,
      'END:VEVENT'
    ]),
    'END:VCALENDAR'
  ].join('\r\n')
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status })
}

describe('normaliseSubscriptionUrl', () => {
  it('fetches webcal links over HTTPS and adds a missing scheme', () => {
    expect(normaliseSubscriptionUrl('webcal://example.com/cal.ics')).toBe('https://example.com/cal.ics')
    expect(normaliseSubscriptionUrl('example.com/cal.ics')).toBe('https://example.com/cal.ics')
    expect(normaliseSubscriptionUrl('http://example.com/a.ics')).toBe('http://example.com/a.ics')
  })

  it('refuses anything that is not a web address', () => {
    expect(() => normaliseSubscriptionUrl('file:///etc/passwd')).toThrow()
    expect(() => normaliseSubscriptionUrl('ftp://example.com/a.ics')).toThrow()
  })
})

describe('calendar subscriptions', () => {
  let db: ISqliteDatabase
  const count = (calendarId: string) =>
    db.prepare('SELECT COUNT(*) c FROM events WHERE calendar_id = ?').get<{ c: number }>(calendarId)!.c

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('creates a read-only calendar named after the feed, with its events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => textResponse(feed([{ uid: 'a', summary: 'Match 1', start: '20260401T180000Z' }])))
    )
    const cal = await addSubscription(db, 'webcal://example.com/fixtures.ics')

    expect(cal).toMatchObject({
      name: 'Fixtures',
      isReadOnly: true,
      subscriptionUrl: 'https://example.com/fixtures.ics'
    })
    expect(count(cal.id)).toBe(1)
  })

  it('refuses a link that is not a calendar, and creates nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('<html>not found</html>')))
    await expect(addSubscription(db, 'https://example.com/page')).rejects.toThrow(/not lead to a calendar/)
    expect(db.prepare('SELECT COUNT(*) c FROM calendars WHERE subscription_url IS NOT NULL').get<{ c: number }>()!.c).toBe(0)
  })

  it('keeps each event\'s id across a refresh, and drops what the feed no longer has', async () => {
    let body = feed([
      { uid: 'a', summary: 'Match 1', start: '20260401T180000Z' },
      { uid: 'b', summary: 'Match 2', start: '20260408T180000Z' }
    ])
    vi.stubGlobal('fetch', vi.fn(async () => textResponse(body)))
    const cal = await addSubscription(db, 'https://example.com/f.ics')
    const idOf = (title: string) =>
      db.prepare('SELECT id FROM events WHERE calendar_id = ? AND title = ?').get<{ id: string }>(cal.id, title)?.id
    const before = idOf('Match 1')

    body = feed([{ uid: 'a', summary: 'Match 1', start: '20260401T190000Z' }])
    expect(await refreshSubscription(db, cal.id)).toBe(1)

    expect(idOf('Match 1')).toBe(before)
    expect(idOf('Match 2')).toBeUndefined()
  })

  it('writes nothing when the feed has not changed', async () => {
    const body = feed([{ uid: 'a', summary: 'Match 1', start: '20260401T180000Z' }])
    vi.stubGlobal('fetch', vi.fn(async () => textResponse(body)))
    const cal = await addSubscription(db, 'https://example.com/f.ics')
    db.prepare("UPDATE events SET updated_at = 'marker' WHERE calendar_id = ?").run(cal.id)

    expect(await refreshSubscription(db, cal.id)).toBe(0)
    expect(
      db.prepare('SELECT updated_at FROM events WHERE calendar_id = ?').get<{ updated_at: string }>(cal.id)!.updated_at
    ).toBe('marker')
  })

  it('refreshes only feeds that are due, and does not retry a broken one every poll', async () => {
    const fetchMock = vi.fn(async () => textResponse(feed([{ uid: 'a', summary: 'x', start: '20260401T180000Z' }])))
    vi.stubGlobal('fetch', fetchMock)
    const cal = await addSubscription(db, 'https://example.com/f.ics')
    const added = Date.parse(cal.subscriptionRefreshedAt!)
    fetchMock.mockClear()

    await refreshDueSubscriptions(db, added + 60_000)
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockImplementation(async () => textResponse('gone', 404))
    const failed = await refreshDueSubscriptions(db, added + SUBSCRIPTION_REFRESH_MS + 1)
    expect(failed.errorCount).toBe(1)
    expect(count(cal.id)).toBe(1)

    fetchMock.mockClear()
    await refreshDueSubscriptions(db, added + SUBSCRIPTION_REFRESH_MS + 120_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
