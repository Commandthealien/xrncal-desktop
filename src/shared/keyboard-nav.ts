/**
 * Cursor and nudge maths for driving the calendar from the keyboard alone.
 *
 * Pure on purpose: the renderer owns *when* a key moves the cursor or an event,
 * this module owns *where* it lands, so both can be checked without a DOM.
 */

import { DateTime } from 'luxon'
import type { ExpandedOccurrence } from './event-model'
import { compareOccurrencesWithinDay } from './occurrence-order'
import { occurrenceDateKey } from './all-day'

export type CursorDirection = 1 | -1

/**
 * The order the keyboard cursor walks occurrences in: day by day, and inside a
 * day the same all-day-first order the views themselves draw, so ↓ always goes
 * to the block the eye would call "the next one".
 */
export function sortForCursor(occurrences: ExpandedOccurrence[]): ExpandedOccurrence[] {
  return [...occurrences].sort((a, b) => {
    const byDay = occurrenceDateKey(a.allDay, a.startUtc).localeCompare(
      occurrenceDateKey(b.allDay, b.startUtc)
    )
    return byDay !== 0 ? byDay : compareOccurrencesWithinDay(a, b)
  })
}

/**
 * Where the cursor goes next.
 *
 * With nothing selected the cursor enters the list at `anchorDateKey` rather
 * than at its first entry — List view keeps weeks of events loaded either side
 * of the anchor, and jumping to the oldest of them is never what ↓ meant.
 * At either end it stays put instead of wrapping.
 */
export function stepCursor(
  ordered: ExpandedOccurrence[],
  currentId: string | null,
  direction: CursorDirection,
  anchorDateKey: string
): ExpandedOccurrence | null {
  if (ordered.length === 0) return null

  const index = currentId ? ordered.findIndex((occ) => occ.id === currentId) : -1
  if (index >= 0) {
    const next = index + direction
    return next < 0 || next >= ordered.length ? ordered[index] : ordered[next]
  }

  if (direction === 1) {
    return (
      ordered.find((occ) => occurrenceDateKey(occ.allDay, occ.startUtc) >= anchorDateKey) ??
      ordered[ordered.length - 1]
    )
  }
  const before = ordered.filter(
    (occ) => occurrenceDateKey(occ.allDay, occ.startUtc) <= anchorDateKey
  )
  return before.length > 0 ? before[before.length - 1] : ordered[0]
}

export interface OccurrenceRange {
  start: DateTime
  end: DateTime
}

/**
 * Read an occurrence's span back as the two DateTimes a move wants.
 *
 * All-day spans are floating dates parked at UTC midnight, so they are read in
 * UTC and shifted there; converting one to the local zone would slide it onto
 * the wrong date before anything had been asked of it. A timed occurrence is a
 * real instant, and shifting it in local time is what makes "one day later"
 * mean the same clock time across a daylight-saving change.
 */
function rangeOf(occ: ExpandedOccurrence): OccurrenceRange {
  const read = (iso: string): DateTime => {
    const utc = DateTime.fromISO(iso, { zone: 'utc' })
    return occ.allDay ? utc : utc.toLocal()
  }
  return { start: read(occ.startUtc), end: read(occ.endUtc) }
}

/**
 * The span an occurrence would take after a keyboard nudge, or null when the
 * nudge does not apply to it — an all-day entry has no minutes to move by.
 */
export function nudgedRange(
  occ: ExpandedOccurrence,
  delta: { days?: number; minutes?: number }
): OccurrenceRange | null {
  const days = delta.days ?? 0
  const minutes = delta.minutes ?? 0
  if (days === 0 && minutes === 0) return null
  if (occ.allDay && days === 0) return null

  const shift = occ.allDay ? { days } : { days, minutes }
  const { start, end } = rangeOf(occ)
  return { start: start.plus(shift), end: end.plus(shift) }
}

/**
 * The span an occurrence would take after its end is dragged by the keyboard.
 * Never shorter than `minDurationMinutes`, and refused for all-day entries,
 * whose length is a whole number of days rather than minutes.
 */
export function resizedRange(
  occ: ExpandedOccurrence,
  deltaMinutes: number,
  minDurationMinutes = 15
): OccurrenceRange | null {
  if (occ.allDay || deltaMinutes === 0) return null

  const { start, end } = rangeOf(occ)
  const floor = start.plus({ minutes: minDurationMinutes })
  const next = end.plus({ minutes: deltaMinutes })
  if (next <= floor) {
    // Already at the floor: report no change rather than a no-op round trip.
    return end <= floor ? null : { start, end: floor }
  }
  return { start, end: next }
}
