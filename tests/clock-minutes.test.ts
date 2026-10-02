import { describe, it, expect } from 'vitest'
import { DateTime, Settings } from 'luxon'
import { atClockMinutes, clockMinutesOfDay } from '../src/shared/clock-minutes'
import { segmentDayMinutes, segmentTimedOccurrence } from '../src/shared/timed-event-segments'
import type { ExpandedOccurrence } from '../src/shared/event-model'

/**
 * The hour grid is a clock face. In Sydney the clocks spring forward on
 * 4 Oct 2026 (a 23-hour day) and fall back on 4 Apr 2027 (25 hours); on both,
 * measuring elapsed minutes from midnight put a 17:00 event on the wrong row.
 */
function inSydney<T>(fn: () => T): T {
  const previous = Settings.defaultZone
  Settings.defaultZone = 'Australia/Sydney'
  try {
    return fn()
  } finally {
    Settings.defaultZone = previous
  }
}

const SPRING_FORWARD = '2026-10-04'
const FALL_BACK = '2027-04-04'

function occurrence(startLocal: string, endLocal: string): ExpandedOccurrence {
  const start = DateTime.fromISO(startLocal).toUTC().toISO()!
  return {
    id: 'o1',
    eventId: 'e1',
    calendarId: 'c1',
    title: 'Pizza',
    startUtc: start,
    endUtc: DateTime.fromISO(endLocal).toUTC().toISO()!,
    tzid: 'Australia/Sydney',
    allDay: false,
    isRecurring: false,
    isException: false,
    originalStartUtc: start
  }
}

describe('clockMinutesOfDay', () => {
  it('reads 17:00 as row 17 on both clock-change days', () =>
    inSydney(() => {
      for (const date of [SPRING_FORWARD, FALL_BACK]) {
        const day = DateTime.fromISO(date)
        expect(clockMinutesOfDay(DateTime.fromISO(`${date}T17:00`), day)).toBe(17 * 60)
      }
    }))

  it('clamps to the day: 0 before it, 1440 at the next midnight and after', () =>
    inSydney(() => {
      const day = DateTime.fromISO(SPRING_FORWARD)
      expect(clockMinutesOfDay(day.minus({ hours: 3 }), day)).toBe(0)
      expect(clockMinutesOfDay(day.startOf('day'), day)).toBe(0)
      expect(clockMinutesOfDay(day.plus({ days: 1 }).startOf('day'), day)).toBe(24 * 60)
      expect(clockMinutesOfDay(day.endOf('day'), day)).toBe(24 * 60)
    }))
})

describe('atClockMinutes', () => {
  it('puts row 10 at 10:00 on the day the clocks spring forward', () =>
    inSydney(() => {
      const t = atClockMinutes(DateTime.fromISO(SPRING_FORWARD), 10 * 60)
      expect(t.toFormat('yyyy-MM-dd HH:mm')).toBe(`${SPRING_FORWARD} 10:00`)
    }))

  it('reads 1440 as the next midnight', () =>
    inSydney(() => {
      const t = atClockMinutes(DateTime.fromISO(FALL_BACK), 24 * 60)
      expect(t.toFormat('yyyy-MM-dd HH:mm')).toBe('2027-04-05 00:00')
    }))

  it('round-trips with clockMinutesOfDay through the day', () =>
    inSydney(() => {
      const day = DateTime.fromISO(SPRING_FORWARD)
      for (const minutes of [0, 90, 6 * 60, 17 * 60 + 30, 23 * 60 + 45]) {
        expect(clockMinutesOfDay(atClockMinutes(day, minutes), day)).toBe(minutes)
      }
    }))
})

describe('segmentDayMinutes on a clock-change day', () => {
  // The event the emulator showed on the 16:00 row.
  it('places a 17:00-21:30 event at 17:00 the day the clocks spring forward', () =>
    inSydney(() => {
      const [segment] = segmentTimedOccurrence(occurrence(`${SPRING_FORWARD}T17:00`, `${SPRING_FORWARD}T21:30`))
      expect(segmentDayMinutes(segment)).toEqual({ startMin: 17 * 60, endMin: 21 * 60 + 30 })
    }))

  it('places it at 17:00 the day they fall back, too', () =>
    inSydney(() => {
      const [segment] = segmentTimedOccurrence(occurrence(`${FALL_BACK}T17:00`, `${FALL_BACK}T21:30`))
      expect(segmentDayMinutes(segment)).toEqual({ startMin: 17 * 60, endMin: 21 * 60 + 30 })
    }))

  it('runs an event that ends at midnight to the bottom of the grid', () =>
    inSydney(() => {
      const [segment] = segmentTimedOccurrence(occurrence(`${SPRING_FORWARD}T22:00`, '2026-10-05T00:00'))
      expect(segmentDayMinutes(segment)).toEqual({ startMin: 22 * 60, endMin: 24 * 60 })
    }))
})
