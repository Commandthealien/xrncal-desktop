import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, closeDatabase, runMigrations } from '../src/main/db/database'
import type { ISqliteDatabase } from '../src/main/db/sqlite-driver'
import { EventsRepo } from '../src/main/db/repos/events-repo'

describe('SQLite FTS5 Full-Text Search and Attendees', () => {
  let db: ISqliteDatabase
  let repo: EventsRepo
  const calId = 'calendar-local-default'

  beforeEach(() => {
    db = initDatabase(':memory:')
    repo = new EventsRepo(db)
  })

  afterEach(() => {
    closeDatabase()
  })

  it('should search events by matching keyword in title, location, or notes', () => {
    repo.createEvent({
      calendarId: calId,
      title: 'Quarterly Strategic Planning Session',
      notes: 'Review Q3 OKRs and roadmap deliverables',
      location: 'Executive Boardroom Hanoi',
      dtStartUtc: '2026-08-20T09:00:00.000Z',
      dtEndUtc: '2026-08-20T11:00:00.000Z',
      tzid: 'Asia/Ho_Chi_Minh'
    })

    repo.createEvent({
      calendarId: calId,
      title: 'Dentist Checkup',
      notes: 'Routine cleaning appointment',
      location: 'Clinic 24 Pasteur',
      dtStartUtc: '2026-08-21T14:00:00.000Z',
      dtEndUtc: '2026-08-21T15:00:00.000Z',
      tzid: 'Asia/Ho_Chi_Minh'
    })

    // Search by title keyword
    const res1 = repo.searchEvents('Strategic')
    expect(res1).toHaveLength(1)
    expect(res1[0].title).toBe('Quarterly Strategic Planning Session')

    // Search by notes keyword
    const res2 = repo.searchEvents('deliverables')
    expect(res2).toHaveLength(1)
    expect(res2[0].title).toBe('Quarterly Strategic Planning Session')

    // Search by location keyword
    const res3 = repo.searchEvents('Pasteur')
    expect(res3).toHaveLength(1)
    expect(res3[0].title).toBe('Dentist Checkup')

    // Non-existent search query
    const res4 = repo.searchEvents('NonExistentTerm999')
    expect(res4).toHaveLength(0)
  })

  it('should keep FTS5 index synchronized on event update and delete', () => {
    const created = repo.createEvent({
      calendarId: calId,
      title: 'Frontend Sprint Kickoff',
      notes: 'Discuss Electron Vite bundling',
      location: 'Virtual Zoom Room',
      dtStartUtc: '2026-08-22T10:00:00.000Z',
      dtEndUtc: '2026-08-22T11:00:00.000Z'
    })

    expect(repo.searchEvents('Bundling')).toHaveLength(1)

    // Update notes
    repo.updateEvent(created.id, {
      notes: 'Refactor SQLite database migrations and FTS triggers'
    })

    // Old term no longer matches
    expect(repo.searchEvents('Bundling')).toHaveLength(0)
    // New term matches
    expect(repo.searchEvents('Migrations')).toHaveLength(1)

    // Delete event
    repo.deleteEvent(created.id)
    expect(repo.searchEvents('Kickoff')).toHaveLength(0)
  })

  it('finds words without their diacritics, which LIKE cannot', () => {
    repo.createEvent({
      calendarId: calId,
      title: 'Giỗ ông nội',
      location: 'Hà Nội',
      dtStartUtc: '2026-08-24T01:00:00.000Z',
      dtEndUtc: '2026-08-24T02:00:00.000Z'
    })

    expect(repo.searchEvents('gio').map((e) => e.title)).toEqual(['Giỗ ông nội'])
    expect(repo.searchEvents('ha noi').map((e) => e.title)).toEqual(['Giỗ ông nội'])
    // A match inside a word still comes from LIKE.
    expect(repo.searchEvents('ội').map((e) => e.title)).toEqual(['Giỗ ông nội'])
  })

  it('leaves the index alone when a row changes but its text does not', () => {
    const created = repo.createEvent({
      calendarId: calId,
      title: 'Standup',
      dtStartUtc: '2026-08-25T01:00:00.000Z',
      dtEndUtc: '2026-08-25T01:15:00.000Z'
    })
    const indexed = () => db.prepare('SELECT COUNT(*) AS n FROM events_fts_docsize').get<{ n: number }>()!.n

    for (let i = 0; i < 5; i++) {
      db.prepare('UPDATE events SET etag = ?, title = title WHERE id = ?').run(`"e${i}"`, created.id)
    }
    expect(indexed()).toBe(1)

    repo.updateEvent(created.id, { title: 'Daily sync' })
    repo.createEvent({
      calendarId: calId,
      title: 'Gone soon',
      dtStartUtc: '2026-08-26T01:00:00.000Z',
      dtEndUtc: '2026-08-26T01:15:00.000Z'
    })
    db.prepare("DELETE FROM events WHERE title = 'Gone soon'").run()

    expect(indexed()).toBe(1)
    expect(repo.searchEvents('standup')).toHaveLength(0)
    expect(repo.searchEvents('daily')).toHaveLength(1)
    expect(() => db.exec("INSERT INTO events_fts(events_fts, rank) VALUES ('integrity-check', 1)")).not.toThrow()
  })

  it('replaces the old index, which never matched, and indexes what is already there', () => {
    // Back to schema 18, with migration 002's contentless index.
    db.exec(`
      DROP TRIGGER trg_events_fts_insert;
      DROP TRIGGER trg_events_fts_update;
      DROP TRIGGER trg_events_fts_delete;
      DROP TABLE events_fts;
      CREATE VIRTUAL TABLE events_fts USING fts5(event_id UNINDEXED, title, notes, location, content='');
      CREATE TRIGGER trg_events_fts_update AFTER UPDATE ON events BEGIN
        DELETE FROM events_fts WHERE event_id = old.id;
        INSERT INTO events_fts(event_id, title, notes, location)
        VALUES (new.id, new.title, COALESCE(new.notes, ''), COALESCE(new.location, ''));
      END;
      DELETE FROM schema_migrations WHERE version >= 19;
    `)
    repo.createEvent({
      calendarId: calId,
      title: 'Họp phụ huynh',
      dtStartUtc: '2026-08-27T01:00:00.000Z',
      dtEndUtc: '2026-08-27T02:00:00.000Z'
    })
    expect(repo.searchEvents('hop')).toHaveLength(0)

    runMigrations(db)

    expect(repo.searchEvents('hop').map((e) => e.title)).toEqual(['Họp phụ huynh'])
  })

  it('should persist and retrieve attendees with response statuses', () => {
    const created = repo.createEvent({
      calendarId: calId,
      title: 'Architecture Review with Team',
      dtStartUtc: '2026-08-23T15:00:00.000Z',
      dtEndUtc: '2026-08-23T16:00:00.000Z',
      attendees: [
        {
          email: 'alice@company.com',
          displayName: 'Alice Architect',
          responseStatus: 'accepted',
          isOrganizer: true
        },
        {
          email: 'bob@company.com',
          displayName: 'Bob Backend',
          responseStatus: 'tentative'
        }
      ]
    })

    const fetched = repo.getEventById(created.id)
    expect(fetched).toBeDefined()
    expect(fetched!.event.attendees).toHaveLength(2)

    const alice = fetched!.event.attendees!.find((a) => a.email === 'alice@company.com')
    expect(alice).toBeDefined()
    expect(alice!.displayName).toBe('Alice Architect')
    expect(alice!.responseStatus).toBe('accepted')
    expect(alice!.isOrganizer).toBe(true)

    // Update attendees
    repo.updateEvent(created.id, {
      attendees: [
        {
          email: 'alice@company.com',
          responseStatus: 'accepted'
        },
        {
          email: 'carol@company.com',
          displayName: 'Carol Cloud',
          responseStatus: 'needsAction'
        }
      ]
    })

    const updated = repo.getEventById(created.id)
    expect(updated!.event.attendees).toHaveLength(2)
    expect(updated!.event.attendees!.some((a) => a.email === 'carol@company.com')).toBe(true)
    expect(updated!.event.attendees!.some((a) => a.email === 'bob@company.com')).toBe(false)
  })
})
