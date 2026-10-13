import type { TFunction } from 'i18next'
import {
  ALL_DAY_REMINDER_PRESETS,
  TIMED_REMINDER_PRESETS,
  describeReminderOffset,
  describeReminderWhen,
  type EventReminder
} from '@shared/reminders'
import { formatClockTime, formatClockTimeStr, type TimeFormatPref } from '@shared/time-format'

/** "10 minutes before", "The day before at 09:00", "Email, 1 hour before". */
export function reminderLabel(
  t: TFunction,
  reminder: EventReminder,
  allDay: boolean,
  timeFormat: TimeFormatPref
): string {
  const offset = describeReminderOffset(reminder.minutesBefore, allDay)
  let label: string
  switch (offset.kind) {
    case 'atStart':
      label = t('reminders.atStart')
      break
    case 'onDayAt':
      label = t('reminders.onDayAt', { time: formatClockTimeStr(offset.time, timeFormat) })
      break
    case 'daysBeforeAt': {
      const time = formatClockTimeStr(offset.time, timeFormat)
      label =
        offset.days % 7 === 0
          ? t('reminders.weeksBeforeAt', { count: offset.days / 7, time })
          : t('reminders.daysBeforeAt', { count: offset.days, time })
      break
    }
    default:
      label = t(`reminders.${offset.kind}`, { count: offset.count })
  }
  return reminder.method === 'email' ? t('reminders.email', { label }) : label
}

/** Choices for one reminder's picker: the presets for its kind of event, plus
 *  whatever value it already holds, so a reminder set elsewhere is never lost. */
export function reminderOptions(
  t: TFunction,
  allDay: boolean,
  timeFormat: TimeFormatPref,
  current?: number
): { value: string; label: string }[] {
  const presets = allDay ? ALL_DAY_REMINDER_PRESETS : TIMED_REMINDER_PRESETS
  const values = current !== undefined && !presets.includes(current) ? [...presets, current] : presets
  return [...values]
    .sort((a, b) => a - b)
    .map((m) => ({ value: String(m), label: reminderLabel(t, { minutesBefore: m }, allDay, timeFormat) }))
}

/** How far off a reminded occurrence is: "In 10 min", "Tomorrow at 09:00". */
export function reminderWhenLabel(
  t: TFunction,
  occurrence: { startUtc: string; allDay: boolean },
  nowMs: number,
  timeFormat: TimeFormatPref,
  locale: string
): string {
  const when = describeReminderWhen(occurrence.startUtc, occurrence.allDay, nowMs)
  if (when.kind === 'now') return t('reminders.whenNow')
  const time = formatClockTime(when.start, timeFormat)
  const date = when.start.setLocale(locale).toFormat('ccc d LLL')
  switch (when.kind) {
    case 'inMinutes':
      return t('reminders.whenInMinutes', { count: when.minutes })
    case 'todayAt':
      return t('reminders.whenTodayAt', { time })
    case 'tomorrowAt':
      return t('reminders.whenTomorrowAt', { time })
    case 'onDateAt':
      return t('reminders.whenOnDateAt', { date, time })
    case 'today':
      return t('reminders.whenToday')
    case 'tomorrow':
      return t('reminders.whenTomorrow')
    case 'onDate':
      return t('reminders.whenOnDate', { date })
  }
}
