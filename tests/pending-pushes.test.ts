import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteDriver, type ISqliteDatabase } from '../src/main/db/sqlite-driver'
import { runMigrations, seedDefaultData } from '../src/main/db/database'
import { CalendarsRepo } from '../src/main/db/repos/calendars-repo'
import { EventsRepo } from '../src/main/db/repos/events-repo'
import { SyncStateRepo } from '../src/main/db/repos/sync-state-repo'

/**
 * The status panel's "N offline changes pending push" counted every dirty row,
 * including local calendars no engine ever pushes - so a local-only user saw a
 * number that could never drain.
 */
describe('SyncStateRepo.countPendingPushes', () => {
  let db: ISqliteDatabase
  let calendars: CalendarsRepo
  let events: EventsRepo
  let repo: SyncStateRepo

  const addAccount = (id: string, type: string, active = 1): void => {
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO accounts (id, type, name, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, type, id, active, now, now)
  }

  const addEvent = (calendarId: string, title = 'Event') =>
    events.createEvent({
      calendarId,
      title,
      dtStartUtc: '2026-10-05T01:00:00.000Z',
      dtEndUtc: '2026-10-05T02:00:00.000Z'
    })

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)
    calendars = new CalendarsRepo(db)
    events = new EventsRepo(db)
    repo = new SyncStateRepo(db)
  })

  it('does not count edits in local calendars, which are never pushed', () => {
    const local = calendars.listCalendars()[0]
    addEvent(local.id)
    addEvent(local.id)

    expect(db.prepare('SELECT COUNT(*) AS n FROM events WHERE dirty = 1').get<{ n: number }>()!.n).toBe(2)
    expect(repo.countPendingPushes()).toBe(0)
  })

  it('counts dirty events in a provider calendar', () => {
    addAccount('acc-google', 'google')
    const cal = calendars.createCalendar({ name: 'Work', color: '#4285f4', accountId: 'acc-google' })
    addEvent(cal.id)
    addEvent(cal.id)

    expect(repo.countPendingPushes()).toBe(2)
  })

  it('leaves out conflicts, which the engines skip until resolved', () => {
    addAccount('acc-caldav', 'caldav')
    const cal = calendars.createCalendar({ name: 'Nextcloud', color: '#0082c9', accountId: 'acc-caldav' })
    const parked = addEvent(cal.id)
    addEvent(cal.id)
    db.prepare('UPDATE events SET has_conflict = 1 WHERE id = ?').run(parked.id)

    expect(repo.countPendingPushes()).toBe(1)
  })

  it('counts a dirty occurrence exception as its own pending push', () => {
    addAccount('acc-graph', 'graph')
    const cal = calendars.createCalendar({ name: 'Outlook', color: '#0078d4', accountId: 'acc-graph' })
    const master = addEvent(cal.id)
    db.prepare('UPDATE events SET dirty = 0 WHERE id = ?').run(master.id)
    // upsertException always marks the row dirty, as a this-scoped edit does.
    events.upsertException({
      masterEventId: master.id,
      originalStartUtc: master.dtStartUtc,
      isCancelled: true
    })

    expect(repo.countPendingPushes()).toBe(1)
  })

  it('ignores accounts that have been switched off', () => {
    addAccount('acc-off', 'google', 0)
    const cal = calendars.createCalendar({ name: 'Old', color: '#999999', accountId: 'acc-off' })
    addEvent(cal.id)

    expect(repo.countPendingPushes()).toBe(0)
  })
})
