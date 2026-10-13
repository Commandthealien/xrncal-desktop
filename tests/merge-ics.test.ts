import { describe, it, expect } from 'vitest'
import ICAL from 'ical.js'
import { mergeServerCopy } from '../src/main/ics/merge-ics'
import { generateIcs } from '../src/main/ics/write-ics'
import { parseIcsContent } from '../src/main/ics/parse-ics'
import type { Calendar, CalendarEvent, EventException } from '../src/shared/event-model'

/**
 * An edit here re-PUTs the whole CalDAV resource from the fields xrncal models.
 * Whatever else another client had stored - OneCal on the phone, Thunderbird,
 * Apple Calendar - used to be erased by it.
 */

const CALENDAR: Calendar = {
  id: 'https://dav.example/sonn/personal/',
  accountId: 'acc',
  name: 'Personal',
  color: '#000000',
  isVisible: true,
  isReadOnly: false,
  isDefault: false,
  createdAt: '',
  updatedAt: ''
}

const BERLIN = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE'
]

/** What the server holds: a weekly 09:00 Berlin series another client wrote. */
function serverCopy(extraMaster: string[] = [], extraOverride: string[] = []): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OneCal//EN',
    ...BERLIN,
    'BEGIN:VEVENT',
    'UID:series-1',
    'DTSTAMP:20261001T000000Z',
    'DTSTART;TZID=Europe/Berlin:20261005T090000',
    'DTEND;TZID=Europe/Berlin:20261005T100000',
    'RRULE:FREQ=WEEKLY',
    'SUMMARY:Standup',
    'DESCRIPTION:Old notes',
    'X-ALT-DESC;FMTTYPE=text/html:<p>Old notes</p>',
    'CATEGORIES:Work',
    'CATEGORIES:Team',
    'CLASS:PRIVATE',
    'TRANSP:TRANSPARENT',
    'SEQUENCE:3',
    'X-ONECAL-ID:abc123',
    'ORGANIZER;CN=Boss:mailto:boss@example.com',
    'ATTENDEE;CN=Boss;PARTSTAT=ACCEPTED:mailto:boss@example.com',
    'ATTENDEE;ROLE=OPT-PARTICIPANT;RSVP=TRUE;X-NUM-GUESTS=1;PARTSTAT=NEEDS-ACTION:mailto:sonn@example.com',
    ...extraMaster,
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:series-1',
    'DTSTAMP:20261001T000000Z',
    'RECURRENCE-ID;TZID=Europe/Berlin:20261012T090000',
    'DTSTART;TZID=Europe/Berlin:20261012T110000',
    'DTEND;TZID=Europe/Berlin:20261012T120000',
    'SUMMARY:Standup (moved)',
    'X-OVERRIDE-NOTE:kept',
    ...extraOverride,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n')
}

/** The same event as xrncal holds it after pulling the copy above. */
function pulled(): { event: CalendarEvent; exceptions: EventException[] } {
  const parsed = parseIcsContent(serverCopy(), CALENDAR.id)
  const e = parsed.events[0]
  const event: CalendarEvent = {
    id: 'series-1',
    calendarId: CALENDAR.id,
    uid: 'series-1',
    title: e.title,
    notes: e.notes,
    location: e.location,
    dtStartUtc: e.dtStartUtc,
    dtEndUtc: e.dtEndUtc,
    tzid: e.tzid ?? 'UTC',
    allDay: false,
    rrule: e.rrule,
    reminders: e.reminders ?? undefined,
    attendees: e.attendees,
    dirty: false,
    isDeleted: false,
    createdAt: '',
    updatedAt: ''
  }
  const exceptions = parsed.exceptions.map((x, i) => ({
    ...x,
    id: `x${i}`,
    masterEventId: 'series-1',
    createdAt: '',
    updatedAt: ''
  })) as EventException[]
  return { event, exceptions }
}

function vevents(ics: string): ICAL.Component[] {
  return new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents('vevent')
}

function merged(event: CalendarEvent, exceptions: EventException[], source = serverCopy()): string {
  return mergeServerCopy(generateIcs(CALENDAR, [event], exceptions), source, {
    tzid: event.tzid,
    reminders: event.reminders
  })
}

describe('mergeServerCopy', () => {
  it("keeps what xrncal does not model and takes xrncal's word for what it does", () => {
    const { event, exceptions } = pulled()
    const out = merged({ ...event, title: 'Daily standup' }, exceptions)
    const [master] = vevents(out)

    expect(master.getFirstPropertyValue('summary')).toBe('Daily standup')
    expect(master.getAllProperties('summary')).toHaveLength(1)
    expect(master.getAllProperties('categories').map((p) => p.getFirstValue())).toEqual(['Work', 'Team'])
    expect(master.getFirstPropertyValue('class')).toBe('PRIVATE')
    expect(master.getFirstPropertyValue('transp')).toBe('TRANSPARENT')
    expect(master.getFirstPropertyValue('x-onecal-id')).toBe('abc123')
    // The notes did not change, so their HTML twin still matches them.
    expect(master.getFirstPropertyValue('x-alt-desc')).toBe('<p>Old notes</p>')
    expect(out).not.toContain('METHOD')
  })

  it('drops the HTML twin of notes edited here', () => {
    const { event, exceptions } = pulled()
    const [master] = vevents(merged({ ...event, notes: 'New notes' }, exceptions))

    expect(master.getFirstPropertyValue('description')).toBe('New notes')
    expect(master.hasProperty('x-alt-desc')).toBe(false)
  })

  it('keeps the series in its own zone, so summer time does not move it', () => {
    const { event, exceptions } = pulled()
    const out = merged(event, exceptions)
    const master = vevents(out)[0]

    expect(out.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(out.indexOf('BEGIN:VEVENT'))
    expect(master.getFirstProperty('dtstart')!.getParameter('tzid')).toBe('Europe/Berlin')
    expect(master.getFirstProperty('dtstart')!.toICALString()).toBe('DTSTART;TZID=Europe/Berlin:20261005T090000')
    // Read back, it is the same instant it was.
    expect(parseIcsContent(out, CALENDAR.id).events[0].dtStartUtc).toBe(event.dtStartUtc)
  })

  it('leaves the times in UTC when the event was moved to another zone here', () => {
    const { event, exceptions } = pulled()
    const out = merged({ ...event, tzid: 'Asia/Ho_Chi_Minh' }, exceptions)

    expect(vevents(out)[0].getFirstProperty('dtstart')!.getParameter('tzid')).toBeUndefined()
    expect(out).not.toContain('VTIMEZONE')
  })

  it('raises SEQUENCE only when the time changes, so guests hear about a move', () => {
    const { event, exceptions } = pulled()
    expect(vevents(merged({ ...event, title: 'Renamed' }, exceptions))[0].getFirstPropertyValue('sequence')).toBe(3)

    const moved = { ...event, dtStartUtc: '2026-10-05T08:00:00.000Z', dtEndUtc: '2026-10-05T09:00:00.000Z' }
    expect(vevents(merged(moved, exceptions))[0].getFirstPropertyValue('sequence')).toBe(4)
  })

  it("matches a moved occurrence across zones and keeps what is on it", () => {
    const { event, exceptions } = pulled()
    const [, override] = vevents(merged(event, exceptions))

    expect(override.getFirstPropertyValue('summary')).toBe('Standup (moved)')
    expect(override.getFirstPropertyValue('x-override-note')).toBe('kept')
  })

  it("keeps a guest's RSVP and party size, but not a role changed here", () => {
    const { event, exceptions } = pulled()
    const attendees = event.attendees!.map((a) => (a.email === 'sonn@example.com' ? { ...a, role: undefined } : a))
    const [master] = vevents(merged({ ...event, attendees }, exceptions))
    const me = master.getAllProperties('attendee').find((p) => String(p.getFirstValue()).includes('sonn@'))!

    expect(me.getParameter('rsvp')).toBe('TRUE')
    expect(me.getParameter('x-num-guests')).toBe('1')
    expect(me.getParameter('role')).toBeUndefined()
  })

  it("keeps the server's guests when the list was never read here", () => {
    const { event, exceptions } = pulled()
    const out = mergeServerCopy(generateIcs(CALENDAR, [{ ...event, attendees: undefined }], exceptions), serverCopy(), {
      tzid: event.tzid,
      keepAttendees: true
    })

    expect(vevents(out)[0].getAllProperties('attendee')).toHaveLength(2)
  })

  describe('alarms', () => {
    const alarm = (lines: string[]) => ['BEGIN:VALARM', ...lines, 'END:VALARM']
    const source = serverCopy([
      ...alarm(['ACTION:AUDIO', 'TRIGGER:-PT10M', 'ATTACH;VALUE=URI:Chord']),
      ...alarm(['ACTION:EMAIL', 'TRIGGER:-PT1H', 'SUMMARY:Standup', 'DESCRIPTION:Soon', 'ATTENDEE:mailto:sonn@example.com']),
      ...alarm(['ACTION:DISPLAY', 'TRIGGER;VALUE=DATE-TIME:20261005T060000Z', 'DESCRIPTION:Fixed time']),
      ...alarm(['ACTION:DISPLAY', 'TRIGGER;RELATED=END:PT5M', 'DESCRIPTION:After'])
    ])
    const actions = (ics: string) =>
      vevents(ics)[0]
        .getAllSubcomponents('valarm')
        .map((a) => `${a.getFirstPropertyValue('action')} ${a.getFirstProperty('trigger')!.toICALString().split(':')[1]}`)
        .sort()

    it('keeps alarms xrncal cannot express, and the server version of those it can', () => {
      const { event, exceptions } = pulled()
      const out = merged({ ...event, reminders: [{ minutesBefore: 10 }, { minutesBefore: 60, method: 'email' }] }, exceptions, source)

      expect(actions(out)).toEqual(['AUDIO -PT10M', 'DISPLAY 20261005T060000Z', 'DISPLAY PT5M', 'EMAIL -PT1H'])
    })

    it('drops the alarm of a reminder removed here and writes one for a reminder added here', () => {
      const { event, exceptions } = pulled()
      const out = merged({ ...event, reminders: [{ minutesBefore: 30 }] }, exceptions, source)

      expect(actions(out)).toEqual(['DISPLAY -PT30M', 'DISPLAY 20261005T060000Z', 'DISPLAY PT5M'])
    })
  })
})
