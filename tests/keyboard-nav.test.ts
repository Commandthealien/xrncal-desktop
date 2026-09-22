import { describe, it, expect } from 'vitest'
import { DateTime, Settings } from 'luxon'
import {
  sortForCursor,
  stepCursor,
  nudgedRange,
  resizedRange
} from '../src/shared/keyboard-nav'
import type { ExpandedOccurrence } from '../src/shared/event-model'

/**
 * Driving the calendar from the keyboard means a cursor walks the occurrences
 * on screen and the arrow keys move whichever one it sits on. Both halves are
 * pure maths over the occurrence list, so both are checked here without a DOM.
 */
function occ(
  id: string,
  startUtc: string,
  endUtc: string,
  allDay = false,
  eventId = id
): ExpandedOccurrence {
  return {
    id,
    eventId,
    calendarId: 'cal',
    title: id,
    startUtc,
    endUtc,
    tzid: 'UTC',
    allDay,
    isRecurring: false,
    isException: false,
    originalStartUtc: startUtc
  }
}

const ids = (list: ExpandedOccurrence[]): string[] => list.map((o) => o.id)

describe('sortForCursor', () => {
  it('walks day by day, all-day entries first within a day', () => {
    const list = [
      occ('tue-14:00', '2026-09-15T14:00:00.000Z', '2026-09-15T15:00:00.000Z'),
      occ('mon-allday', '2026-09-14T00:00:00.000Z', '2026-09-14T23:59:59.000Z', true),
      occ('mon-09:00', '2026-09-14T09:00:00.000Z', '2026-09-14T10:00:00.000Z'),
      occ('mon-16:00', '2026-09-14T16:00:00.000Z', '2026-09-14T17:00:00.000Z')
    ]
    expect(ids(sortForCursor(list))).toEqual([
      'mon-allday',
      'mon-09:00',
      'mon-16:00',
      'tue-14:00'
    ])
  })

  it('leaves its input untouched', () => {
    const list = [
      occ('b', '2026-09-15T14:00:00.000Z', '2026-09-15T15:00:00.000Z'),
      occ('a', '2026-09-14T09:00:00.000Z', '2026-09-14T10:00:00.000Z')
    ]
    sortForCursor(list)
    expect(ids(list)).toEqual(['b', 'a'])
  })
})

describe('stepCursor', () => {
  const ordered = sortForCursor([
    occ('mon', '2026-09-14T09:00:00.000Z', '2026-09-14T10:00:00.000Z'),
    occ('wed', '2026-09-16T09:00:00.000Z', '2026-09-16T10:00:00.000Z'),
    occ('fri', '2026-09-18T09:00:00.000Z', '2026-09-18T10:00:00.000Z')
  ])

  it('moves one step in the asked direction', () => {
    expect(stepCursor(ordered, 'wed', 1, '2026-09-16')?.id).toBe('fri')
    expect(stepCursor(ordered, 'wed', -1, '2026-09-16')?.id).toBe('mon')
  })

  it('stays put at either end instead of wrapping', () => {
    expect(stepCursor(ordered, 'fri', 1, '2026-09-18')?.id).toBe('fri')
    expect(stepCursor(ordered, 'mon', -1, '2026-09-14')?.id).toBe('mon')
  })

  it('enters the list at the anchor date, not at its oldest entry', () => {
    // List view keeps weeks of events loaded either side of the anchor; a first
    // press of the down arrow should land on the next one from where the user
    // is looking.
    expect(stepCursor(ordered, null, 1, '2026-09-15')?.id).toBe('wed')
    expect(stepCursor(ordered, null, -1, '2026-09-17')?.id).toBe('wed')
  })

  it('falls back to the nearest end when the anchor is outside the range', () => {
    expect(stepCursor(ordered, null, 1, '2026-10-01')?.id).toBe('fri')
    expect(stepCursor(ordered, null, -1, '2026-01-01')?.id).toBe('mon')
  })

  it('has nowhere to go in an empty range', () => {
    expect(stepCursor([], null, 1, '2026-09-15')).toBeNull()
  })

  it('re-enters at the anchor when the selected occurrence is gone', () => {
    expect(stepCursor(ordered, 'deleted_2026-09-16', 1, '2026-09-15')?.id).toBe('wed')
  })
})

describe('nudgedRange', () => {
  const timed = occ('timed', '2026-09-14T09:00:00.000Z', '2026-09-14T10:00:00.000Z')
  const allDay = occ('allday', '2026-09-14T00:00:00.000Z', '2026-09-14T23:59:59.000Z', true)

  it('moves a timed occurrence by whole minutes, keeping its length', () => {
    const moved = nudgedRange(timed, { minutes: 15 })!
    expect(moved.start.toUTC().toISO()).toBe('2026-09-14T09:15:00.000Z')
    expect(moved.end.toUTC().toISO()).toBe('2026-09-14T10:15:00.000Z')
  })

  it('moves by days too', () => {
    const moved = nudgedRange(timed, { days: -1 })!
    expect(moved.start.toUTC().toISO()).toBe('2026-09-13T09:00:00.000Z')
  })

  it('keeps an all-day span on its own dates, whatever the local zone', () => {
    // A floating date parked at UTC midnight read in a zone east of GMT would
    // land on the previous day before anything had been asked of it.
    const previous = Settings.defaultZone
    Settings.defaultZone = 'Asia/Ho_Chi_Minh'
    try {
      const moved = nudgedRange(allDay, { days: 1 })!
      expect(moved.start.toUTC().toISODate()).toBe('2026-09-15')
      expect(moved.end.toUTC().toISODate()).toBe('2026-09-15')
    } finally {
      Settings.defaultZone = previous
    }
  })

  it('refuses a by-the-minute nudge on an all-day entry', () => {
    expect(nudgedRange(allDay, { minutes: 30 })).toBeNull()
  })

  it('reports no change for a zero nudge', () => {
    expect(nudgedRange(timed, {})).toBeNull()
  })

  it('keeps the clock time across a daylight-saving change', () => {
    const previous = Settings.defaultZone
    Settings.defaultZone = 'Europe/Berlin'
    try {
      // 2026-03-29 is the spring-forward date; 09:00 the day before must stay
      // 09:00 the day after rather than becoming 10:00.
      const before = occ('dst', '2026-03-28T08:00:00.000Z', '2026-03-28T09:00:00.000Z')
      const moved = nudgedRange(before, { days: 1 })!
      expect(moved.start.setZone('Europe/Berlin').hour).toBe(
        DateTime.fromISO('2026-03-28T08:00:00.000Z').setZone('Europe/Berlin').hour
      )
    } finally {
      Settings.defaultZone = previous
    }
  })
})

describe('resizedRange', () => {
  const timed = occ('timed', '2026-09-14T09:00:00.000Z', '2026-09-14T10:00:00.000Z')

  it('moves the end only', () => {
    const resized = resizedRange(timed, 30)!
    expect(resized.start.toUTC().toISO()).toBe('2026-09-14T09:00:00.000Z')
    expect(resized.end.toUTC().toISO()).toBe('2026-09-14T10:30:00.000Z')
  })

  it('stops at the minimum duration instead of inverting the event', () => {
    const resized = resizedRange(timed, -120, 15)!
    expect(resized.end.toUTC().toISO()).toBe('2026-09-14T09:15:00.000Z')
  })

  it('reports no change once it is already at the floor', () => {
    const short = occ('short', '2026-09-14T09:00:00.000Z', '2026-09-14T09:15:00.000Z')
    expect(resizedRange(short, -30, 15)).toBeNull()
  })

  it('refuses to resize an all-day entry by minutes', () => {
    const allDay = occ('allday', '2026-09-14T00:00:00.000Z', '2026-09-14T23:59:59.000Z', true)
    expect(resizedRange(allDay, 30)).toBeNull()
  })
})
