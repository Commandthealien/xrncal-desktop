import { DateTime } from 'luxon'
import {
  generateHolidayEvents,
  HOLIDAY_CALENDAR_META,
  type HolidayCalendarType
} from '../../shared/holiday-calendars'
import { CalendarsRepo } from '../db/repos/calendars-repo'
import { EventsRepo } from '../db/repos/events-repo'
import type { ISqliteDatabase } from '../db/sqlite-driver'

/** How far past the current year a subscription is generated. */
const YEARS_AHEAD = 2

export function subscribeHolidayCalendar(
  db: ISqliteDatabase,
  type: HolidayCalendarType,
  currentYear = DateTime.local().year
): { calendarId: string; count: number } {
  const calendarsRepo = new CalendarsRepo(db)
  const eventsRepo = new EventsRepo(db)
  const meta = HOLIDAY_CALENDAR_META[type]

  const existing = calendarsRepo.listCalendars().find((c) => c.name === meta.name)
  const holidayCal =
    existing ??
    calendarsRepo.createCalendar({
      name: meta.name,
      color: meta.color,
      isReadOnly: true
    })

  const years: number[] = []
  for (let y = currentYear - 1; y <= currentYear + YEARS_AHEAD; y++) years.push(y)
  const eventsToCreate = generateHolidayEvents(holidayCal.id, type, years)

  db.transaction(() => {
    eventsRepo.deleteEventsByCalendar(holidayCal.id)
    for (const evInput of eventsToCreate) {
      eventsRepo.createEvent(evInput, { allowReadOnly: true })
    }
  })()

  return {
    calendarId: holidayCal.id,
    count: eventsToCreate.length
  }
}

/**
 * Regenerate subscribed holiday calendars that no longer reach YEARS_AHEAD past
 * the current year.
 *
 * A subscription is generated once, for a fixed run of years, and nothing
 * extended it: one taken out in 2026 went quiet from 2029 on, with no sign that
 * anything had run out. Run at startup; a calendar that still covers the years
 * ahead is left untouched, so this costs one query per subscription.
 */
export function refreshHolidayCalendars(
  db: ISqliteDatabase,
  currentYear = DateTime.local().year
): HolidayCalendarType[] {
  const calendars = new CalendarsRepo(db).listCalendars()
  const refreshed: HolidayCalendarType[] = []

  for (const type of Object.keys(HOLIDAY_CALENDAR_META) as HolidayCalendarType[]) {
    const cal = calendars.find((c) => c.name === HOLIDAY_CALENDAR_META[type].name)
    if (!cal) continue
    const last = db
      .prepare('SELECT MAX(dtstart_utc) AS last FROM events WHERE calendar_id = ? AND is_deleted = 0')
      .get<{ last: string | null }>(cal.id)?.last
    const lastYear = last ? Number(last.slice(0, 4)) : 0
    if (lastYear >= currentYear + YEARS_AHEAD) continue
    subscribeHolidayCalendar(db, type, currentYear)
    refreshed.push(type)
  }

  return refreshed
}

export function unsubscribeHolidayCalendar(db: ISqliteDatabase, type: HolidayCalendarType): boolean {
  const calendarsRepo = new CalendarsRepo(db)
  const meta = HOLIDAY_CALENDAR_META[type]
  const holidayCal = calendarsRepo.listCalendars().find((c) => c.name === meta.name)
  if (!holidayCal) return false
  return calendarsRepo.deleteCalendar(holidayCal.id)
}
