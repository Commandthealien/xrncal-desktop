import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSqliteDriver, type ISqliteDatabase } from '../src/main/db/sqlite-driver'
import { runMigrations, seedDefaultData } from '../src/main/db/database'
import { EventsRepo } from '../src/main/db/repos/events-repo'
import { GoogleSyncEngine } from '../src/main/sync/google-sync-engine'
import { MicrosoftSyncEngine } from '../src/main/sync/microsoft-sync-engine'
import { CalDavSyncEngine } from '../src/main/sync/caldav-sync-engine'
import { mapGoogleEventToDomain, mapDomainEventToGoogle } from '../src/main/sync/google-event-mapper'
import { graphAttendeesToDomain, mapDomainEventToGraph } from '../src/main/sync/microsoft-event-mapper'
import { parseIcsContent } from '../src/main/ics/parse-ics'
import { generateIcs } from '../src/main/ics/write-ics'
import { invitationSelf, markSelfAttendee, type Attendee } from '../src/shared/event-model'

/**
 * Attendees were never synced, so an invitation arrived with no guest list and
 * nothing to answer. These pin the mapping each way, the reply path, and the
 * rule that keeps a guest list nobody has fetched from being pushed as empty.
 */

const CAL = 'cal_inv'
const ME = 'me@example.com'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response
}

describe('guest lists from each provider', () => {
  it('reads Google\'s list with its own self and organizer flags', () => {
    const evt = mapGoogleEventToDomain(
      {
        id: 'g1',
        start: { dateTime: '2026-04-01T09:00:00Z' },
        end: { dateTime: '2026-04-01T10:00:00Z' },
        attendees: [
          { email: 'boss@example.com', organizer: true, responseStatus: 'accepted' },
          { email: ME, self: true, responseStatus: 'needsAction' },
          { email: 'room@resource.calendar.google.com', resource: true }
        ]
      },
      'cal'
    ).event!
    expect(evt.attendees).toEqual([
      { email: 'boss@example.com', displayName: undefined, responseStatus: 'accepted', isOrganizer: true, isSelf: false },
      { email: ME, displayName: undefined, responseStatus: 'needsAction', isOrganizer: false, isSelf: true },
      // Kept: a PUT without the room would cancel its booking.
      {
        email: 'room@resource.calendar.google.com',
        displayName: undefined,
        responseStatus: 'needsAction',
        isOrganizer: false,
        isSelf: false,
        role: 'room'
      }
    ])
    expect(invitationSelf(evt.attendees)?.email).toBe(ME)
  })

  it('adds the organizer Graph leaves out, and takes our answer from responseStatus', () => {
    const list = graphAttendeesToDomain(
      {
        id: 'm1',
        isOrganizer: false,
        organizer: { emailAddress: { address: 'boss@example.com', name: 'Boss' } },
        responseStatus: { response: 'tentativelyAccepted' },
        attendees: [{ emailAddress: { address: 'ME@example.com' }, status: { response: 'none' }, type: 'required' }]
      },
      ME
    )
    expect(list[0]).toMatchObject({ email: 'boss@example.com', isOrganizer: true })
    expect(invitationSelf(list)).toMatchObject({ email: 'ME@example.com', responseStatus: 'tentative' })
  })

  it('adds our own entry when Graph invited us through a group', () => {
    const list = graphAttendeesToDomain(
      {
        id: 'm1',
        isOrganizer: false,
        organizer: { emailAddress: { address: 'boss@example.com' } },
        responseStatus: { response: 'accepted' },
        attendees: [{ emailAddress: { address: 'team@example.com' }, type: 'required' }]
      },
      ME
    )
    expect(invitationSelf(list)).toMatchObject({ email: ME, responseStatus: 'accepted' })
  })

  it('round-trips ATTENDEE and ORGANIZER through iCalendar, PARTSTAT included', () => {
    const attendees: Attendee[] = [
      { email: 'boss@example.com', displayName: 'Boss, The', responseStatus: 'accepted', isOrganizer: true },
      { email: ME, responseStatus: 'declined' }
    ]
    const ics = generateIcs(
      { id: 'c', accountId: 'a', name: 'C', color: '#000', isVisible: true, isReadOnly: false, isDefault: false, createdAt: '', updatedAt: '' },
      [
        {
          id: 'e',
          calendarId: 'c',
          uid: 'e@x',
          title: 'Review',
          dtStartUtc: '2026-04-01T09:00:00.000Z',
          dtEndUtc: '2026-04-01T10:00:00.000Z',
          tzid: 'UTC',
          allDay: false,
          attendees,
          dirty: false,
          isDeleted: false,
          createdAt: '',
          updatedAt: ''
        }
      ]
    )
    expect(ics).toContain('ORGANIZER;CN="Boss, The":mailto:boss@example.com')
    expect(ics).toContain('PARTSTAT=DECLINED:mailto:me@example.com')
    const parsed = markSelfAttendee(parseIcsContent(ics, 'c').events[0].attendees!, ME)
    expect(invitationSelf(parsed)).toMatchObject({ email: ME, responseStatus: 'declined' })
    expect(parsed.find((a) => a.isOrganizer)?.displayName).toBe('Boss, The')
  })
})

describe('pushing guest lists', () => {
  const base = {
    calendarId: 'c',
    title: 'x',
    dtStartUtc: '2026-04-01T09:00:00.000Z',
    dtEndUtc: '2026-04-01T10:00:00.000Z'
  }

  it('leaves guests out entirely when the list is not known', () => {
    expect(mapDomainEventToGoogle(base).attendees).toBeUndefined()
    expect(mapDomainEventToGraph(base).attendees).toBeUndefined()
  })

  it('never sends a guest list on an invitation from someone else (Graph)', () => {
    const payload = mapDomainEventToGraph({
      ...base,
      attendees: [
        { email: 'boss@example.com', isOrganizer: true },
        { email: ME, isSelf: true }
      ]
    })
    expect(payload.attendees).toBeUndefined()
  })

  it('sends the organizer\'s guests without the organizer (Graph)', () => {
    const payload = mapDomainEventToGraph({
      ...base,
      attendees: [
        { email: ME, isOrganizer: true, isSelf: true },
        { email: 'a@example.com', displayName: 'A' }
      ]
    })
    expect(payload.attendees).toEqual([{ emailAddress: { address: 'a@example.com', name: 'A' }, type: 'required' }])
  })

  it('sends rooms and optional guests back as what they were', () => {
    const pulled = graphAttendeesToDomain(
      {
        id: 'm1',
        isOrganizer: true,
        organizer: { emailAddress: { address: ME } },
        attendees: [
          { emailAddress: { address: 'opt@example.com' }, type: 'optional' },
          { emailAddress: { address: 'room1@example.com', name: 'Room 1' }, type: 'resource' }
        ]
      },
      ME
    )
    expect(mapDomainEventToGraph({ ...base, attendees: pulled }).attendees).toEqual([
      { emailAddress: { address: 'opt@example.com', name: undefined }, type: 'optional' },
      { emailAddress: { address: 'room1@example.com', name: 'Room 1' }, type: 'resource' }
    ])

    const google = mapGoogleEventToDomain(
      {
        id: 'g1',
        start: { dateTime: '2026-04-01T09:00:00Z' },
        end: { dateTime: '2026-04-01T10:00:00Z' },
        attendees: [
          { email: 'opt@example.com', optional: true },
          { email: 'room@resource.calendar.google.com', resource: true }
        ]
      },
      'cal'
    ).event!
    expect(mapDomainEventToGoogle({ ...base, attendees: google.attendees }).attendees).toEqual([
      { email: 'opt@example.com', displayName: undefined, responseStatus: 'needsAction', optional: true },
      { email: 'room@resource.calendar.google.com', displayName: undefined, responseStatus: 'needsAction' }
    ])
  })

  it('round-trips rooms and optional guests through iCalendar', () => {
    const ics = generateIcs(
      { id: 'c', accountId: 'a', name: 'C', color: '#000', isVisible: true, isReadOnly: false, isDefault: false, createdAt: '', updatedAt: '' },
      [
        {
          id: 'e',
          calendarId: 'c',
          uid: 'e@x',
          title: 'Review',
          dtStartUtc: '2026-04-01T09:00:00.000Z',
          dtEndUtc: '2026-04-01T10:00:00.000Z',
          tzid: 'UTC',
          allDay: false,
          attendees: [
            { email: ME, isOrganizer: true },
            { email: 'opt@example.com', role: 'optional' },
            { email: 'room@example.com', role: 'room' },
            { email: 'projector@example.com', role: 'resource' }
          ],
          dirty: false,
          isDeleted: false,
          createdAt: '',
          updatedAt: ''
        }
      ]
    )
    const roles = parseIcsContent(ics, 'c').events[0].attendees!.map((a) => [a.email, a.role])
    expect(roles).toEqual([
      [ME, undefined],
      ['opt@example.com', 'optional'],
      ['room@example.com', 'room'],
      ['projector@example.com', 'resource']
    ])
  })
})

describe('replying to invitations', () => {
  let db: ISqliteDatabase
  let repo: EventsRepo

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)
    repo = new EventsRepo(db)
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO calendars (id, account_id, name, color, is_visible, is_read_only, is_default, created_at, updated_at)
       VALUES (?, 'account-local-primary', 'Inbox', '#000', 1, 0, 0, ?, ?)`
    ).run(CAL, now, now)
  })

  afterEach(() => vi.unstubAllGlobals())

  function invitation(): string {
    const created = repo.createEvent({
      calendarId: CAL,
      title: 'Review',
      dtStartUtc: '2026-04-01T09:00:00.000Z',
      dtEndUtc: '2026-04-01T10:00:00.000Z'
    })
    db.prepare(
      "UPDATE events SET provider_event_id = 'prov1', etag = 'e1', dirty = 0, attendees_synced = 1 WHERE id = ?"
    ).run(created.id)
    repo.replaceAttendees(created.id, [
      { email: 'boss@example.com', isOrganizer: true, responseStatus: 'accepted' },
      { email: ME, isSelf: true, responseStatus: 'needsAction' }
    ])
    return created.id
  }

  it('records the answer at once and queues it for the provider', () => {
    const id = invitation()
    const updated = repo.respondToInvite(id, 'accepted')
    expect(invitationSelf(updated.attendees)?.responseStatus).toBe('accepted')
    expect(repo.listPendingRsvps(CAL)).toEqual([expect.objectContaining({ response: 'accepted' })])

    repo.markRsvpSent(id, 'e2')
    expect(repo.listPendingRsvps(CAL)).toEqual([])
    expect(repo.getEventById(id)!.event.etag).toBe('e2')
  })

  it('refuses to answer an event that is not an invitation', () => {
    const own = repo.createEvent({
      calendarId: CAL,
      title: 'Mine',
      dtStartUtc: '2026-04-01T09:00:00.000Z',
      dtEndUtc: '2026-04-01T10:00:00.000Z'
    })
    expect(() => repo.respondToInvite(own.id, 'accepted')).toThrow(/not an invitation/)
  })

  it('answers on Google by patching a fresh guest list with only our entry changed', async () => {
    const id = invitation()
    repo.respondToInvite(id, 'declined')
    const calls: { url: string; method: string; body?: { attendees?: unknown } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
        if (init?.method === 'PATCH') {
          return jsonResponse({ etag: 'e9', attendees: [{ email: ME, self: true, responseStatus: 'declined' }] })
        }
        // Someone the organizer invited since our last pull.
        return jsonResponse({
          attendees: [
            { email: 'boss@example.com', organizer: true, responseStatus: 'accepted' },
            { email: ME, self: true, responseStatus: 'needsAction' },
            { email: 'new@example.com', responseStatus: 'needsAction' }
          ]
        })
      })
    )

    const res = await new GoogleSyncEngine(db).pushRsvps(CAL, 'token')

    expect(res.pushedCount).toBe(1)
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH'])
    expect(calls[1].url).toContain('/events/prov1')
    expect(calls[1].body?.attendees).toEqual([
      { email: 'boss@example.com', displayName: undefined, responseStatus: 'accepted' },
      { email: ME, displayName: undefined, responseStatus: 'declined' },
      { email: 'new@example.com', displayName: undefined, responseStatus: 'needsAction' }
    ])
    expect(repo.listPendingRsvps(CAL)).toEqual([])
    expect(repo.getEventById(id)!.event.etag).toBe('e9')
  })

  it('answers on Graph through its reply action and picks up the new etag', async () => {
    const id = invitation()
    repo.respondToInvite(id, 'tentative')
    const calls: { url: string; method: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET' })
        if (init?.method === 'POST') return { ok: true, status: 202, json: async () => ({}), text: async () => '' } as Response
        return jsonResponse({ '@odata.etag': 'W/"e5"' })
      })
    )

    await new MicrosoftSyncEngine(db).pushRsvps(CAL, 'token')

    expect(calls[0]).toEqual({ url: expect.stringContaining('/me/events/prov1/tentativelyAccept'), method: 'POST' })
    expect(repo.getEventById(id)!.event.etag).toBe('W/"e5"')
    expect(repo.listPendingRsvps(CAL)).toEqual([])
  })

  it('stops retrying a reply to a meeting the organizer has since cancelled', async () => {
    const id2 = invitation()
    repo.respondToInvite(id2, 'accepted')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'gone' }, 404)))
    expect((await new GoogleSyncEngine(db).pushRsvps(CAL, 'token')).errorCount).toBe(0)
    expect(repo.listPendingRsvps(CAL)).toEqual([])

    repo.respondToInvite(id2, 'declined')
    expect((await new MicrosoftSyncEngine(db).pushRsvps(CAL, 'token')).errorCount).toBe(0)
    expect(repo.listPendingRsvps(CAL)).toEqual([])
  })

  it('keeps a reply for the next poll when the provider is only busy', async () => {
    const id = invitation()
    repo.respondToInvite(id, 'accepted')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'slow down' }, 429)))
    await new GoogleSyncEngine(db).pushRsvps(CAL, 'token')
    await new MicrosoftSyncEngine(db).pushRsvps(CAL, 'token')
    expect(repo.listPendingRsvps(CAL)).toHaveLength(1)
  })

  it('shows Google\'s answer again when Google refuses a reply for good', async () => {
    const id = invitation()
    repo.respondToInvite(id, 'accepted')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'PATCH'
          ? jsonResponse({ error: 'bad' }, 400)
          : jsonResponse({
              attendees: [
                { email: 'boss@example.com', organizer: true, responseStatus: 'accepted' },
                { email: ME, self: true, responseStatus: 'needsAction' }
              ]
            })
      )
    )
    await new GoogleSyncEngine(db).pushRsvps(CAL, 'token')
    expect(repo.listPendingRsvps(CAL)).toEqual([])
    expect(invitationSelf(repo.getEventById(id)!.event.attendees)?.responseStatus).toBe('needsAction')
  })

  it('does not PUT a Google event without its guests when their list cannot be read', async () => {
    const created = repo.createEvent({
      calendarId: CAL,
      title: 'Old meeting',
      dtStartUtc: '2026-04-01T09:00:00.000Z',
      dtEndUtc: '2026-04-01T10:00:00.000Z'
    })
    db.prepare("UPDATE events SET provider_event_id = 'g9', etag = 'e1', attendees_synced = 0 WHERE id = ?").run(
      created.id
    )
    const methods: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET')
        return jsonResponse({ error: 'backend' }, 503)
      })
    )

    const res = await new GoogleSyncEngine(db).pushDirtyEvents(CAL, 'token')

    expect(methods).toEqual(['GET'])
    expect(res.errorCount).toBe(1)
    expect(repo.getEventById(created.id)!.event.dirty).toBe(true)
  })

  it('does not let a pull overwrite an answer that has not been delivered', async () => {
    const id = invitation()
    repo.respondToInvite(id, 'accepted')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          items: [
            {
              id: 'prov1',
              summary: 'Review (moved)',
              start: { dateTime: '2026-04-01T09:30:00Z' },
              end: { dateTime: '2026-04-01T10:30:00Z' },
              attendees: [{ email: ME, self: true, responseStatus: 'needsAction' }]
            }
          ],
          nextSyncToken: 's'
        })
      )
    )
    await new GoogleSyncEngine(db).pullCalendarEvents(CAL, 'token')

    const after = repo.getEventById(id)!.event
    // The rest of the event still comes through.
    expect(after.title).toBe('Review (moved)')
    expect(invitationSelf(after.attendees)?.responseStatus).toBe('accepted')
  })

  it('pushes a Graph event whose guests were never fetched without touching them', async () => {
    const created = repo.createEvent({
      calendarId: CAL,
      title: 'Old meeting',
      dtStartUtc: '2026-04-01T09:00:00.000Z',
      dtEndUtc: '2026-04-01T10:00:00.000Z'
    })
    // Synced before guest lists were: etag set, list never read.
    db.prepare("UPDATE events SET provider_event_id = 'm9', etag = 'W/\"1\"', attendees_synced = 0 WHERE id = ?").run(
      created.id
    )
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return jsonResponse({ id: 'm9', '@odata.etag': 'W/"2"' })
      })
    )

    await new MicrosoftSyncEngine(db).pushDirtyEvents(CAL, 'token', ME)

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toHaveProperty('attendees')
  })
})

describe('guests added to a CalDAV event', () => {
  const DAV_CAL = 'https://dav.example/me/personal/'
  const CREDS = { url: 'https://dav.example/me/', username: 'me', password: 'pw' }
  let db: ISqliteDatabase
  let repo: EventsRepo
  let bodies: string[]

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)
    repo = new EventsRepo(db)
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO calendars (id, account_id, name, color, is_visible, is_read_only, is_default, created_at, updated_at)
       VALUES (?, 'account-local-primary', 'Personal', '#000', 1, 0, 0, ?, ?)`
    ).run(DAV_CAL, now, now)
    bodies = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') bodies.push(String(init.body))
        return { ok: true, status: 204, url: '', text: async () => '', headers: new Headers({ etag: '"e1"' }) } as Response
      })
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  const withGuest = () =>
    repo.createEvent({
      calendarId: DAV_CAL,
      title: 'Lunch',
      dtStartUtc: '2026-04-01T05:00:00.000Z',
      dtEndUtc: '2026-04-01T06:00:00.000Z',
      attendees: [{ email: 'friend@example.com' }]
    })

  it('names the account as ORGANIZER, which iCalendar requires alongside ATTENDEEs', async () => {
    withGuest()
    await new CalDavSyncEngine(db).pushDirtyEvents(DAV_CAL, CREDS, ME)
    expect(bodies[0]).toContain(`ORGANIZER:mailto:${ME}`)
    expect(bodies[0]).toContain('mailto:friend@example.com')
  })

  it('leaves the organizer out when all it has is a username, not an address', async () => {
    withGuest()
    await new CalDavSyncEngine(db).pushDirtyEvents(DAV_CAL, CREDS, 'me')
    expect(bodies[0]).not.toContain('ORGANIZER')
  })
})
