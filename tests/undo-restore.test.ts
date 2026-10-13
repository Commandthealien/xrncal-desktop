import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteDriver, type ISqliteDatabase } from '../src/main/db/sqlite-driver'
import { runMigrations, seedDefaultData } from '../src/main/db/database'
import { EventsRepo } from '../src/main/db/repos/events-repo'

/**
 * Undoing a delete. A synced deletion is pushed within seconds of the delete,
 * after which the row is gone, so undo has two paths: bring back a row that is
 * still here, or recreate the event from the snapshot taken before the delete.
 */
const CAL = 'calendar-local-default'

describe('EventsRepo.restoreEvent', () => {
  let db: ISqliteDatabase
  let repo: EventsRepo

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)
    repo = new EventsRepo(db)
  })

  const create = () =>
    repo.createEvent({
      calendarId: CAL,
      title: 'Standup',
      dtStartUtc: '2026-04-01T09:00:00.000Z',
      dtEndUtc: '2026-04-01T09:15:00.000Z',
      rrule: 'FREQ=DAILY',
      reminders: [{ minutesBefore: 5 }],
      attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }]
    })

  it('brings back a row whose deletion has not been pushed, under its own id', () => {
    const evt = create()
    const snapshot = repo.getEventById(evt.id)!
    repo.deleteEvent(evt.id)
    expect(repo.getEventById(evt.id)).toBeNull()

    const restored = repo.restoreEvent(snapshot)

    expect(restored.id).toBe(evt.id)
    expect(restored.dirty).toBe(true)
  })

  it('recreates an event whose deletion already reached the provider, exceptions included', () => {
    const evt = create()
    repo.upsertException({
      masterEventId: evt.id,
      originalStartUtc: '2026-04-02T09:00:00.000Z',
      isCancelled: true
    })
    const snapshot = repo.getEventById(evt.id)!
    // What a successful push of the deletion leaves behind: nothing.
    db.prepare('DELETE FROM events WHERE id = ?').run(evt.id)

    const restored = repo.restoreEvent(snapshot)
    const full = repo.getEventById(restored.id)!

    expect(restored.id).not.toBe(evt.id)
    expect(full.event).toMatchObject({ title: 'Standup', rrule: 'FREQ=DAILY', reminders: [{ minutesBefore: 5 }] })
    expect(full.event.attendees?.map((a) => a.email)).toEqual(['a@example.com'])
    expect(full.exceptions).toEqual([
      expect.objectContaining({ originalStartUtc: '2026-04-02T09:00:00.000Z', isCancelled: true })
    ])
  })

  it('recreates an invitation from someone else without re-inviting its guests', () => {
    const evt = create()
    repo.replaceAttendees(evt.id, [
      { email: 'boss@example.com', isOrganizer: true },
      { email: 'me@example.com', isSelf: true }
    ])
    const snapshot = repo.getEventById(evt.id)!
    db.prepare('DELETE FROM events WHERE id = ?').run(evt.id)

    const restored = repo.restoreEvent(snapshot)

    expect(repo.getEventById(restored.id)!.event.attendees).toEqual([])
  })

  describe('one deleted occurrence', () => {
    const OCC = '2026-04-02T09:00:00.000Z'
    const cancelled = (id: string) =>
      db
        .prepare('SELECT is_cancelled, dirty FROM event_exceptions WHERE master_event_id = ? AND original_start_utc = ?')
        .get<{ is_cancelled: number; dirty: number }>(id, OCC)

    it('drops a cancellation the provider has not heard of', () => {
      const evt = create()
      const snapshot = repo.getEventById(evt.id)!
      repo.deleteRecurringScope({ masterEventId: evt.id, originalStartUtc: OCC, scope: 'this' })

      repo.restoreOccurrence(evt.id, OCC, snapshot.exceptions.find((x) => x.originalStartUtc === OCC))

      expect(cancelled(evt.id)).toBeUndefined()
    })

    it('puts back the override the occurrence had before', () => {
      const evt = create()
      repo.upsertException({ masterEventId: evt.id, originalStartUtc: OCC, isCancelled: false, title: 'Moved' })
      const snapshot = repo.getEventById(evt.id)!
      repo.deleteRecurringScope({ masterEventId: evt.id, originalStartUtc: OCC, scope: 'this' })

      repo.restoreOccurrence(evt.id, OCC, snapshot.exceptions.find((x) => x.originalStartUtc === OCC))

      expect(repo.getEventById(evt.id)!.exceptions).toEqual([
        expect.objectContaining({ originalStartUtc: OCC, isCancelled: false, title: 'Moved' })
      ])
    })

    it('reverses a pushed cancellation with an override that goes out again', () => {
      const evt = create()
      repo.deleteRecurringScope({ masterEventId: evt.id, originalStartUtc: OCC, scope: 'this' })
      db.prepare('UPDATE event_exceptions SET dirty = 0').run()

      repo.restoreOccurrence(evt.id, OCC)

      expect(cancelled(evt.id)).toEqual({ is_cancelled: 0, dirty: 1 })
    })

    it('refuses when Outlook already removed it, since Outlook cannot restore one', () => {
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO accounts (id, type, name, is_active, created_at, updated_at) VALUES ('acc_ms', 'graph', 'Outlook', 1, ?, ?)"
      ).run(now, now)
      db.prepare(
        `INSERT INTO calendars (id, account_id, name, color, is_visible, is_read_only, is_default, created_at, updated_at)
         VALUES ('cal_ms', 'acc_ms', 'Work', '#000', 1, 0, 0, ?, ?)`
      ).run(now, now)
      const evt = repo.createEvent({
        calendarId: 'cal_ms',
        title: 'Standup',
        dtStartUtc: '2026-04-01T09:00:00.000Z',
        dtEndUtc: '2026-04-01T09:15:00.000Z',
        rrule: 'FREQ=DAILY'
      })
      repo.deleteRecurringScope({ masterEventId: evt.id, originalStartUtc: OCC, scope: 'this' })
      db.prepare('UPDATE event_exceptions SET dirty = 0').run()

      expect(() => repo.restoreOccurrence(evt.id, OCC)).toThrow(/Outlook/)
      expect(cancelled(evt.id)).toEqual({ is_cancelled: 1, dirty: 0 })
    })
  })
})

describe('guests through recurring edits', () => {
  let db: ISqliteDatabase
  let repo: EventsRepo

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)
    repo = new EventsRepo(db)
  })

  const series = (attendees: { email: string; isOrganizer?: boolean; isSelf?: boolean; role?: 'optional' | 'room' }[]) => {
    const evt = repo.createEvent({
      calendarId: CAL,
      title: 'Weekly',
      dtStartUtc: '2026-04-01T09:00:00.000Z',
      dtEndUtc: '2026-04-01T10:00:00.000Z',
      rrule: 'FREQ=WEEKLY'
    })
    repo.replaceAttendees(evt.id, attendees)
    return evt
  }

  it('takes the guests to the new series a this-and-following edit splits off', () => {
    const evt = series([
      { email: 'me@example.com', isOrganizer: true, isSelf: true },
      { email: 'a@example.com' },
      { email: 'room@example.com', role: 'room' }
    ])
    repo.updateRecurringScope({
      masterEventId: evt.id,
      originalStartUtc: '2026-04-15T09:00:00.000Z',
      scope: 'future',
      updateInput: { title: 'Weekly (new time)' }
    })
    const split = db
      .prepare("SELECT id FROM events WHERE title = 'Weekly (new time)'")
      .get<{ id: string }>()!
    expect(repo.getEventById(split.id)!.event.attendees?.map((a) => [a.email, a.role])).toEqual([
      ['me@example.com', undefined],
      ['a@example.com', undefined],
      ['room@example.com', 'room']
    ])
  })

  it('does not copy the guests of someone else\'s invitation into a series of our own', () => {
    const evt = series([{ email: 'boss@example.com', isOrganizer: true }, { email: 'me@example.com', isSelf: true }])
    repo.updateRecurringScope({
      masterEventId: evt.id,
      originalStartUtc: '2026-04-15T09:00:00.000Z',
      scope: 'future',
      updateInput: { title: 'Mine now' }
    })
    const split = db.prepare("SELECT id FROM events WHERE title = 'Mine now'").get<{ id: string }>()!
    expect(repo.getEventById(split.id)!.event.attendees).toEqual([])
  })

  it('applies a guest change made on one occurrence to the series', () => {
    const evt = series([{ email: 'me@example.com', isOrganizer: true, isSelf: true }])
    repo.updateRecurringScope({
      masterEventId: evt.id,
      originalStartUtc: '2026-04-08T09:00:00.000Z',
      scope: 'this',
      updateInput: {
        title: 'Weekly',
        attendees: [{ email: 'me@example.com', isOrganizer: true, isSelf: true }, { email: 'new@example.com' }]
      }
    })
    expect(repo.getEventById(evt.id)!.event.attendees?.map((a) => a.email)).toEqual([
      'me@example.com',
      'new@example.com'
    ])
  })
})
