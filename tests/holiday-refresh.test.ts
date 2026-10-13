import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteDriver, type ISqliteDatabase } from '../src/main/db/sqlite-driver'
import { runMigrations, seedDefaultData } from '../src/main/db/database'
import {
  subscribeHolidayCalendar,
  refreshHolidayCalendars
} from '../src/main/holidays/holiday-subscription'

/**
 * A holiday subscription was generated once, last year through two years
 * ahead, and never extended - so one taken out in 2026 was empty from 2029.
 */
describe('refreshHolidayCalendars', () => {
  let db: ISqliteDatabase

  const yearsIn = (calendarId: string): number[] =>
    db
      .prepare(
        "SELECT DISTINCT CAST(substr(dtstart_utc, 1, 4) AS INTEGER) AS y FROM events WHERE calendar_id = ? ORDER BY y"
      )
      .all<{ y: number }>(calendarId)
      .map((r) => r.y)

  beforeEach(() => {
    db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)
  })

  it('leaves a subscription that still covers the years ahead alone', () => {
    const { calendarId } = subscribeHolidayCalendar(db, 'vietnam', 2026)
    expect(yearsIn(calendarId)).toEqual([2025, 2026, 2027, 2028])

    expect(refreshHolidayCalendars(db, 2026)).toEqual([])
  })

  it('extends a subscription once the calendar has moved past its first year', () => {
    const { calendarId } = subscribeHolidayCalendar(db, 'vietnam', 2026)
    subscribeHolidayCalendar(db, 'international', 2026)

    expect(refreshHolidayCalendars(db, 2029).sort()).toEqual(['international', 'vietnam'])
    expect(yearsIn(calendarId)).toEqual([2028, 2029, 2030, 2031])
  })

  it('does nothing without a subscription', () => {
    expect(refreshHolidayCalendars(db, 2030)).toEqual([])
    expect(db.prepare('SELECT COUNT(*) c FROM events').get<{ c: number }>()!.c).toBe(0)
  })
})
