import { describe, it, expect } from 'vitest'
import {
  mapGoogleEventToDomain,
  mapDomainEventToGoogle,
  type GoogleReminders
} from '../src/main/sync/google-event-mapper'
import { mapGraphEventToDomain, mapDomainEventToGraph } from '../src/main/sync/microsoft-event-mapper'
import { parseIcsContent } from '../src/main/ics/parse-ics'
import { generateIcs } from '../src/main/ics/write-ics'
import type { Calendar, CalendarEvent } from '../src/shared/event-model'

/**
 * Reminders set on a provider used to be ignored on the way in and dropped on
 * the way out; a Google update (a PUT) even reset them, since the payload left
 * the field out. These pin each provider's mapping both ways.
 */

const base = {
  id: 'evt_1',
  calendarId: 'cal',
  uid: 'evt_1@xrncal.calendar',
  title: 'Standup',
  dtStartUtc: '2026-04-01T09:00:00.000Z',
  dtEndUtc: '2026-04-01T09:15:00.000Z',
  tzid: 'UTC',
  allDay: false
}

describe('Google reminders', () => {
  const gEvent = (reminders: GoogleReminders | undefined) =>
    mapGoogleEventToDomain(
      {
        id: 'g1',
        summary: 'x',
        start: { dateTime: '2026-04-01T09:00:00Z' },
        end: { dateTime: '2026-04-01T10:00:00Z' },
        reminders
      },
      'cal'
    ).event!.reminders

  it('reads "use default" (or no field) as the default, and overrides as a list', () => {
    expect(gEvent(undefined)).toBeUndefined()
    expect(gEvent({ useDefault: true })).toBeUndefined()
    expect(gEvent({ useDefault: false })).toEqual([])
    expect(
      gEvent({
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 30 },
          { method: 'email', minutes: 1440 }
        ]
      })
    ).toEqual([{ minutesBefore: 30 }, { minutesBefore: 1440, method: 'email' }])
  })

  it('always sends reminders, so a PUT never resets them', () => {
    expect(mapDomainEventToGoogle(base).reminders).toEqual({ useDefault: true })
    expect(mapDomainEventToGoogle({ ...base, reminders: [] }).reminders).toEqual({
      useDefault: false,
      overrides: []
    })
    expect(
      mapDomainEventToGoogle({ ...base, reminders: [{ minutesBefore: 10 }, { minutesBefore: 60, method: 'email' }] })
        .reminders
    ).toEqual({
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 10 },
        { method: 'email', minutes: 60 }
      ]
    })
  })
})

describe('Graph reminders', () => {
  const graphEvent = (extra: Record<string, unknown>) =>
    mapGraphEventToDomain(
      {
        id: 'm1',
        subject: 'x',
        start: { dateTime: '2026-04-01T09:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-04-01T10:00:00.0000000', timeZone: 'UTC' },
        ...extra
      },
      'cal'
    ).event!.reminders

  it('reads the single reminder Graph holds', () => {
    expect(graphEvent({})).toBeUndefined()
    expect(graphEvent({ isReminderOn: false, reminderMinutesBeforeStart: 15 })).toEqual([])
    expect(graphEvent({ isReminderOn: true, reminderMinutesBeforeStart: 1080 })).toEqual([
      { minutesBefore: 1080 }
    ])
  })

  it('sends the soonest display reminder, and nothing at all for the default', () => {
    expect(mapDomainEventToGraph(base).isReminderOn).toBeUndefined()
    expect(mapDomainEventToGraph({ ...base, reminders: [] }).isReminderOn).toBe(false)
    const payload = mapDomainEventToGraph({
      ...base,
      reminders: [{ minutesBefore: 60 }, { minutesBefore: 5, method: 'email' }, { minutesBefore: 15 }]
    })
    expect(payload.isReminderOn).toBe(true)
    expect(payload.reminderMinutesBeforeStart).toBe(15)
  })
})

describe('iCalendar alarms', () => {
  const calendar: Calendar = {
    id: 'cal',
    accountId: 'a',
    name: 'Cal',
    color: '#000000',
    isVisible: true,
    isReadOnly: false,
    isDefault: false,
    createdAt: '',
    updatedAt: ''
  }
  const event = (extra: Partial<CalendarEvent>): CalendarEvent => ({
    ...base,
    dirty: false,
    isDeleted: false,
    createdAt: '',
    updatedAt: '',
    ...extra
  })

  it('round-trips display reminders through VALARM', () => {
    const ics = generateIcs(calendar, [event({ reminders: [{ minutesBefore: 10 }, { minutesBefore: 2340 }] })])
    expect(ics).toContain('TRIGGER:-PT10M')
    expect(ics).toContain('TRIGGER:-P1DT15H')
    expect(parseIcsContent(ics, 'cal').events[0].reminders).toEqual([
      { minutesBefore: 10 },
      { minutesBefore: 2340 }
    ])
  })

  it('writes no alarm for the default and reads an alarm-less event as the default', () => {
    const ics = generateIcs(calendar, [event({})])
    expect(ics).not.toContain('VALARM')
    expect(parseIcsContent(ics, 'cal').events[0].reminders).toBeUndefined()
  })

  it('skips alarms it cannot express, and reads EMAIL alarms as email', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:x',
      'DTSTART:20260401T090000Z',
      'DTEND:20260401T100000Z',
      'SUMMARY:x',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER;VALUE=DATE-TIME:20260401T080000Z',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER;RELATED=END:-PT5M',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:EMAIL',
      'TRIGGER:-PT1H',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n')
    expect(parseIcsContent(ics, 'cal').events[0].reminders).toEqual([{ minutesBefore: 60, method: 'email' }])
  })

  it('reads back the meeting link and colour it writes', () => {
    const ics = generateIcs(calendar, [event({ meetingUrl: 'https://meet.example/abc', color: '#33b679' })])
    const parsed = parseIcsContent(ics, 'cal').events[0]
    expect(parsed.meetingUrl).toBe('https://meet.example/abc')
    expect(parsed.color).toBe('#33b679')
  })
})
