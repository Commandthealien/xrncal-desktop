import { DateTime } from 'luxon'

/**
 * Event reminders, shared by the main process (which rings and syncs them) and
 * the renderer (which edits and shows them).
 *
 * A reminder is an offset before the event starts. An all-day event starts at
 * local midnight on its first day, so 900 minutes is "the day before at 09:00".
 * That is how Google, Graph and iCalendar all count it, and none of them can
 * hold a reminder after the start, so an offset is never negative.
 */
export interface EventReminder {
  minutesBefore: number
  /** Google and CalDAV can also hold an email reminder. It is kept so a push
   *  does not delete it, but only display reminders ring here. */
  method?: 'email'
}

/** Google's ceiling: four weeks. */
export const MAX_REMINDER_MINUTES = 40320

export const TIMED_REMINDER_PRESETS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080]

/** The day before at 09:00 and at 18:00, two and three days before at 09:00,
 *  and a week before at 09:00. */
export const ALL_DAY_REMINDER_PRESETS = [900, 360, 2340, 3780, 9540]

/** What a new lunar anniversary starts with when no all-day default is set. A
 *  giỗ needs a day's notice - the offerings are bought the day before. */
export const LUNAR_ANNIVERSARY_REMINDER = 900

/** Whole minutes in range, duplicates dropped, soonest-to-the-start first. */
export function normalizeReminders(list: readonly EventReminder[]): EventReminder[] {
  const seen = new Set<string>()
  const out: EventReminder[] = []
  for (const r of list) {
    const m = Math.round(Number(r?.minutesBefore))
    if (!Number.isFinite(m) || m < 0) continue
    const minutesBefore = Math.min(m, MAX_REMINDER_MINUTES)
    const method = r.method === 'email' ? 'email' : undefined
    const key = `${method ?? 'display'}:${minutesBefore}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(method ? { minutesBefore, method } : { minutesBefore })
  }
  return out.sort(
    (a, b) => a.minutesBefore - b.minutesBefore || (a.method ? 1 : 0) - (b.method ? 1 : 0)
  )
}

/** The `reminders` column: NULL means "use the default", `[]` means "none". */
export function parseRemindersJson(raw: string | null | undefined): EventReminder[] | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? normalizeReminders(parsed) : undefined
  } catch {
    return undefined
  }
}

export function serializeReminders(list: readonly EventReminder[] | null | undefined): string | null {
  return list ? JSON.stringify(normalizeReminders(list)) : null
}

export function remindersEqual(a: readonly EventReminder[], b: readonly EventReminder[]): boolean {
  return JSON.stringify(normalizeReminders(a)) === JSON.stringify(normalizeReminders(b))
}

export interface ReminderDefaults {
  /** Minutes before a timed event, or null for none. */
  timed: number | null
  /** Minutes before an all-day event's day begins, or null for none. */
  allDay: number | null
}

/**
 * What actually rings for an event. Its own list wins, `[]` included; without
 * one, a timed event takes its calendar's default (Google publishes one per
 * calendar) and then the app setting, and an all-day event the app setting.
 */
export function effectiveReminders(
  eventReminders: readonly EventReminder[] | undefined,
  allDay: boolean,
  calendarDefault: readonly EventReminder[] | undefined,
  defaults: ReminderDefaults
): EventReminder[] {
  if (eventReminders !== undefined) return [...eventReminders]
  if (allDay) return defaults.allDay === null ? [] : [{ minutesBefore: defaults.allDay }]
  if (calendarDefault !== undefined) return [...calendarDefault]
  return defaults.timed === null ? [] : [{ minutesBefore: defaults.timed }]
}

/**
 * The instant reminders count back from: a timed event's start, or local
 * midnight on an all-day event's date. All-day dates are floating and stored at
 * UTC midnight, so only the date part of `startUtc` means anything for them.
 */
export function reminderAnchorMs(startUtc: string, allDay: boolean, zone = 'local'): number {
  if (!allDay) return DateTime.fromISO(startUtc, { zone: 'utc' }).toMillis()
  return DateTime.fromISO(startUtc.slice(0, 10), { zone }).startOf('day').toMillis()
}

export interface DueReminder {
  minutesBefore: number
  fireAtMs: number
}

/**
 * Which of an occurrence's display reminders should ring at `nowMs`.
 *
 * A reminder stays due from its fire time until the occurrence starts (or
 * `graceMs` past the fire time, for one set at the start itself), so a machine
 * that slept through 08:50 still says something at 08:55 about a 09:00 meeting.
 * When several are overdue together only the latest rings - the earlier ones
 * are stale news - but all of them are returned as handled so none rings later.
 */
export function dueReminders(
  anchorMs: number,
  reminders: readonly EventReminder[],
  nowMs: number,
  graceMs: number
): { ring?: DueReminder; handled: DueReminder[] } {
  const handled: DueReminder[] = []
  for (const r of reminders) {
    if (r.method) continue
    const fireAtMs = anchorMs - r.minutesBefore * 60_000
    if (fireAtMs <= nowMs && nowMs < Math.max(anchorMs, fireAtMs + graceMs)) {
      handled.push({ minutesBefore: r.minutesBefore, fireAtMs })
    }
  }
  let ring: DueReminder | undefined
  for (const d of handled) if (!ring || d.fireAtMs > ring.fireAtMs) ring = d
  return { ring, handled }
}

export type ReminderWhen =
  | { kind: 'now' }
  | { kind: 'inMinutes'; minutes: number; start: DateTime }
  | { kind: 'todayAt' | 'tomorrowAt' | 'onDateAt'; start: DateTime }
  | { kind: 'today' | 'tomorrow' | 'onDate'; start: DateTime }

/** How far off an occurrence is, in the words a reminder uses for it. */
export function describeReminderWhen(
  startUtc: string,
  allDay: boolean,
  nowMs: number,
  zone = 'local'
): ReminderWhen {
  const now = DateTime.fromMillis(nowMs, { zone })
  if (allDay) {
    const start = DateTime.fromISO(startUtc.slice(0, 10), { zone }).startOf('day')
    const days = Math.round(start.diff(now.startOf('day'), 'days').days)
    if (days <= 0) return { kind: 'today', start }
    return { kind: days === 1 ? 'tomorrow' : 'onDate', start }
  }

  const start = DateTime.fromISO(startUtc, { zone: 'utc' }).setZone(zone)
  const minutes = Math.ceil((start.toMillis() - nowMs) / 60_000)
  if (minutes <= 0) return { kind: 'now' }
  if (minutes < 60) return { kind: 'inMinutes', minutes, start }
  const days = Math.round(start.startOf('day').diff(now.startOf('day'), 'days').days)
  if (days === 0) return { kind: 'todayAt', start }
  return { kind: days === 1 ? 'tomorrowAt' : 'onDateAt', start }
}

export type ReminderOffsetLabel =
  | { kind: 'atStart' }
  | { kind: 'minutes' | 'hours' | 'days' | 'weeks'; count: number }
  /** All-day: on the event's own day, at `time` (24h "HH:mm"). */
  | { kind: 'onDayAt'; time: string }
  /** All-day: `days` days before, at `time` (24h "HH:mm"). */
  | { kind: 'daysBeforeAt'; days: number; time: string }

/** A reminder offset in words, for the editor and settings. */
export function describeReminderOffset(minutesBefore: number, allDay: boolean): ReminderOffsetLabel {
  const m = Math.max(0, Math.round(minutesBefore))
  if (allDay) {
    if (m === 0) return { kind: 'onDayAt', time: '00:00' }
    const days = Math.ceil(m / 1440)
    const clock = days * 1440 - m
    const time = `${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}`
    return { kind: 'daysBeforeAt', days, time }
  }
  if (m === 0) return { kind: 'atStart' }
  if (m % 10080 === 0) return { kind: 'weeks', count: m / 10080 }
  if (m % 1440 === 0) return { kind: 'days', count: m / 1440 }
  if (m % 60 === 0) return { kind: 'hours', count: m / 60 }
  return { kind: 'minutes', count: m }
}

export type ReminderProvider = 'google' | 'graph' | 'caldav'

/** The part of a reminder list a provider can store: Google keeps five of any
 *  kind, Graph one display reminder, CalDAV (as written here) display ones. */
export function remindersForProvider(
  provider: ReminderProvider,
  list: readonly EventReminder[]
): EventReminder[] {
  const normalized = normalizeReminders(list)
  if (provider === 'google') return normalized.slice(0, 5)
  const display = normalized.filter((r) => !r.method)
  return provider === 'graph' ? display.slice(0, 1) : display
}

/**
 * What a pull should store, given what the row holds and what came back.
 *
 * Providers hold less than this app does, so a pulled list that is exactly the
 * provider's share of the local one means nothing changed over there - the
 * local list, with the parts the provider could not keep, stays. Anything else
 * is a real change made elsewhere, and the provider's version wins.
 */
export function mergePulledReminders(
  provider: ReminderProvider,
  local: readonly EventReminder[] | undefined,
  pulled: readonly EventReminder[] | undefined
): EventReminder[] | undefined {
  if (local === undefined) return pulled ? [...pulled] : undefined
  if (pulled === undefined) {
    // An event with nothing CalDAV can hold is written with no VALARM at all,
    // and reads back as having none - which is not the same as "use the default".
    return provider === 'caldav' && remindersForProvider(provider, local).length === 0
      ? [...local]
      : undefined
  }
  return remindersEqual(remindersForProvider(provider, local), pulled) ? [...local] : [...pulled]
}
