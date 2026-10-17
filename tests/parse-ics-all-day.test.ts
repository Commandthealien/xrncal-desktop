import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { parseIcsContent } from '../src/main/ics/parse-ics'

/**
 * An all-day DATE went through toJSDate(), which puts it at midnight in the
 * machine's zone: east of UTC that is the previous day once stored as UTC, so
 * every all-day event pulled over CalDAV or imported from .ics in Sydney began
 * at 14:00Z the day before and drew across two days.
 */
describe('all-day dates in .ics', () => {
  const previousTz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'Australia/Sydney'
  })
  afterAll(() => {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  })

  const ics = (lines: string[]): string =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', 'UID:day', 'DTSTAMP:20250101T000000Z',
      ...lines, 'SUMMARY:Pay day', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')

  it('keeps the calendar day, whatever the machine zone', () => {
    const [event] = parseIcsContent(ics(['DTSTART;VALUE=DATE:20250721', 'DTEND;VALUE=DATE:20250722']), 'cal').events
    expect(event.allDay).toBe(true)
    expect(event.dtStartUtc).toBe('2025-07-21T00:00:00.000Z')
    expect(event.dtEndUtc).toBe('2025-07-21T23:59:59.999Z')
  })

  it('keeps the day of a cancelled date in an all-day series', () => {
    const [event] = parseIcsContent(
      ics(['DTSTART;VALUE=DATE:20250721', 'DTEND;VALUE=DATE:20250722', 'RRULE:FREQ=WEEKLY', 'EXDATE;VALUE=DATE:20250728']),
      'cal'
    ).events
    expect(event.exdate).toBe('2025-07-28T00:00:00.000Z')
  })

  it('still reads a timed event in its own zone', () => {
    const [event] = parseIcsContent(
      ics(['DTSTART:20250721T010000Z', 'DTEND:20250721T020000Z']),
      'cal'
    ).events
    expect(event.dtStartUtc).toBe('2025-07-21T01:00:00.000Z')
  })
})
