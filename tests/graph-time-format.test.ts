import { describe, it, expect } from 'vitest'
import { ianaZoneFor, windowsZoneFor } from '../src/main/sync/graph-time-zones'
import { mapDomainEventToGraph, mapGraphEventToDomain } from '../src/main/sync/microsoft-event-mapper'
import { rruleToGraphRecurrence } from '../src/main/sync/graph-recurrence-map'
import type { CalendarEvent } from '../src/shared/event-model'

/**
 * Graph documents `dateTime` as clock time with no offset and `timeZone` as a
 * Windows name or one of a fixed list of IANA names. Pushes sent the UTC instant
 * with a "Z" and the event's own IANA zone - Asia/Ho_Chi_Minh is not on the list.
 */

const base: CalendarEvent = {
  id: 'evt_1',
  calendarId: 'cal',
  uid: 'evt_1@xrncal.calendar',
  title: 'Standup',
  dtStartUtc: '2026-04-06T02:00:00.000Z',
  dtEndUtc: '2026-04-06T02:30:00.000Z',
  tzid: 'Asia/Ho_Chi_Minh',
  allDay: false,
  dirty: true,
  isDeleted: false,
  createdAt: '',
  updatedAt: ''
}

describe('windowsZoneFor', () => {
  it('names the Windows zone that keeps the same clock', () => {
    expect(windowsZoneFor('Asia/Ho_Chi_Minh')).toBe('SE Asia Standard Time')
    expect(windowsZoneFor('Asia/Saigon')).toBe('SE Asia Standard Time')
    expect(windowsZoneFor('Europe/Amsterdam')).toBe('W. Europe Standard Time')
    expect(windowsZoneFor('America/Toronto')).toBe('Eastern Standard Time')
    expect(windowsZoneFor('Asia/Kolkata')).toBe('India Standard Time')
    expect(windowsZoneFor('UTC')).toBe('UTC')
  })

  it('has no answer for a zone it does not know', () => {
    expect(windowsZoneFor('Not/A_Zone')).toBeNull()
    expect(windowsZoneFor(undefined)).toBeNull()
  })
})

describe('Graph event times', () => {
  it('sends the clock time in a Windows zone, with no offset', () => {
    const payload = mapDomainEventToGraph(base)

    expect(payload.start).toEqual({ dateTime: '2026-04-06T09:00:00', timeZone: 'SE Asia Standard Time' })
    expect(payload.end).toEqual({ dateTime: '2026-04-06T09:30:00', timeZone: 'SE Asia Standard Time' })
  })

  it('falls back to UTC clock time for a zone with no Windows name', () => {
    const payload = mapDomainEventToGraph({ ...base, tzid: 'Not/A_Zone' })

    expect(payload.start).toEqual({ dateTime: '2026-04-06T02:00:00', timeZone: 'UTC' })
  })

  it('sends an all-day event as UTC midnights', () => {
    const payload = mapDomainEventToGraph({
      ...base,
      allDay: true,
      dtStartUtc: '2026-04-06T00:00:00.000Z',
      dtEndUtc: '2026-04-06T00:00:00.000Z'
    })

    expect(payload.start).toEqual({ dateTime: '2026-04-06T00:00:00', timeZone: 'UTC' })
    expect(payload.end).toEqual({ dateTime: '2026-04-07T00:00:00', timeZone: 'UTC' })
  })

  it("starts a series on its local date, repeating on the start's own weekday", () => {
    // 06:00 Monday in Hanoi is 23:00 Sunday in UTC.
    const payload = mapDomainEventToGraph({
      ...base,
      dtStartUtc: '2026-04-05T23:00:00.000Z',
      dtEndUtc: '2026-04-05T23:30:00.000Z',
      rrule: 'FREQ=WEEKLY;UNTIL=20260427T165959Z'
    })

    expect(payload.start!.dateTime).toBe('2026-04-06T06:00:00')
    expect(payload.recurrence!.pattern.daysOfWeek).toEqual(['monday'])
    expect(payload.recurrence!.range).toEqual({ type: 'endDate', startDate: '2026-04-06', endDate: '2026-04-27' })
  })
})

describe('rruleToGraphRecurrence', () => {
  it('takes the day a rule leaves out from the start, as RFC 5545 does', () => {
    expect(rruleToGraphRecurrence('FREQ=MONTHLY', '2026-04-17').pattern).toMatchObject({
      type: 'absoluteMonthly',
      dayOfMonth: 17
    })
    expect(rruleToGraphRecurrence('FREQ=YEARLY', '2026-04-17').pattern).toMatchObject({
      type: 'absoluteYearly',
      month: 4,
      dayOfMonth: 17
    })
    expect(rruleToGraphRecurrence('FREQ=WEEKLY', '2026-04-17').pattern.daysOfWeek).toEqual(['friday'])
  })
})

describe('Graph pulls', () => {
  const pulled = {
    id: 'AAMk1',
    subject: 'Planning',
    start: { dateTime: '2026-04-06T13:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-04-06T14:00:00.0000000', timeZone: 'UTC' },
    originalStartTimeZone: 'Eastern Standard Time',
    bodyPreview: 'Agenda: '.padEnd(255, 'x'),
    body: { contentType: 'text', content: 'Agenda: '.padEnd(900, 'x') }
  }

  it("keep the zone the organiser made the event in, so a series keeps its clock", () => {
    const { event } = mapGraphEventToDomain(pulled, 'cal')

    expect(event!.tzid).toBe('America/New_York')
    expect(event!.dtStartUtc).toBe('2026-04-06T13:00:00.000Z')
  })

  it('keep notes past the 255 characters of the preview', () => {
    expect(mapGraphEventToDomain(pulled, 'cal').event!.notes).toHaveLength(900)
    const html = { ...pulled, body: { contentType: 'html', content: '<p>Agenda</p>' } }
    expect(mapGraphEventToDomain(html, 'cal').event!.notes).toBe(pulled.bodyPreview)
  })

  it('read Windows and IANA zone names, and nothing else', () => {
    expect(ianaZoneFor('SE Asia Standard Time')).toBe('Asia/Bangkok')
    expect(ianaZoneFor('Europe/Paris')).toBe('Europe/Paris')
    expect(ianaZoneFor('tzone://Microsoft/Custom')).toBeNull()
  })
})
