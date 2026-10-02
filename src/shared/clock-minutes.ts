import type { DateTime } from 'luxon'

/**
 * The hour grid is a clock face: row 17 is 17:00, whatever the day's length.
 *
 * Elapsed time and clock time part on the two days a zone changes offset. On
 * the day Sydney springs forward (4 Oct 2026) 17:00 is only 16 hours after
 * midnight, so an event placed by `diff(startOfDay)` drew on the 16:00 row,
 * and a time built with `startOf('day').plus({ minutes })` landed an hour
 * late; on the day it falls back, both erred the other way. Everything that
 * maps between a time and a position on the grid goes through these two.
 */

const DAY_MINUTES = 24 * 60

/**
 * Minutes from the top of `day`'s grid to `dt` by its clock face: 0 for
 * anything before the day, 1440 for anything after it (an exclusive end at
 * the next midnight included).
 */
export function clockMinutesOfDay(dt: DateTime, day: DateTime): number {
  const dayStart = day.startOf('day')
  if (dt <= dayStart) return 0
  if (!dt.hasSame(dayStart, 'day')) return DAY_MINUTES
  return Math.round(dt.hour * 60 + dt.minute + dt.second / 60 + dt.millisecond / 60_000)
}

/**
 * The time on `day` whose clock face reads `minutes` past midnight; Luxon
 * resolves the offset. 1440 means the end of the day, which is midnight on
 * the next one.
 */
export function atClockMinutes(day: DateTime, minutes: number): DateTime {
  const base = day.startOf('day')
  if (minutes >= DAY_MINUTES) return base.plus({ days: 1 }).startOf('day')
  return base.set({
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    second: 0,
    millisecond: 0
  })
}
