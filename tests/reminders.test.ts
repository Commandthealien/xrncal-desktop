import { describe, it, expect } from 'vitest'
import {
  normalizeReminders,
  parseRemindersJson,
  serializeReminders,
  effectiveReminders,
  reminderAnchorMs,
  dueReminders,
  describeReminderWhen,
  describeReminderOffset,
  remindersForProvider,
  mergePulledReminders
} from '../src/shared/reminders'

const MIN = 60_000
const defaults = { timed: 10, allDay: null }

describe('reminder lists', () => {
  it('normalizes: whole minutes, no duplicates, no negatives, soonest first', () => {
    expect(
      normalizeReminders([
        { minutesBefore: 30 },
        { minutesBefore: 10.4 },
        { minutesBefore: 10 },
        { minutesBefore: -5 },
        { minutesBefore: 30, method: 'email' },
        { minutesBefore: 99999 }
      ])
    ).toEqual([
      { minutesBefore: 10 },
      { minutesBefore: 30 },
      { minutesBefore: 30, method: 'email' },
      { minutesBefore: 40320 }
    ])
  })

  it('tells "use the default" (NULL) apart from "none" ([])', () => {
    expect(parseRemindersJson(null)).toBeUndefined()
    expect(parseRemindersJson('[]')).toEqual([])
    expect(parseRemindersJson('not json')).toBeUndefined()
    expect(serializeReminders(undefined)).toBeNull()
    expect(serializeReminders([])).toBe('[]')
  })

  it('resolves what rings: own list, then calendar default, then the setting', () => {
    expect(effectiveReminders([], false, [{ minutesBefore: 30 }], defaults)).toEqual([])
    expect(effectiveReminders(undefined, false, [{ minutesBefore: 30 }], defaults)).toEqual([
      { minutesBefore: 30 }
    ])
    expect(effectiveReminders(undefined, false, undefined, defaults)).toEqual([{ minutesBefore: 10 }])
    // A calendar's timed default never applies to all-day events.
    expect(effectiveReminders(undefined, true, [{ minutesBefore: 30 }], defaults)).toEqual([])
    expect(effectiveReminders(undefined, true, undefined, { timed: null, allDay: 900 })).toEqual([
      { minutesBefore: 900 }
    ])
  })
})

describe('when reminders ring', () => {
  it('counts all-day reminders back from local midnight on the date', () => {
    const anchor = reminderAnchorMs('2026-09-24T00:00:00.000Z', true, 'Asia/Ho_Chi_Minh')
    expect(new Date(anchor).toISOString()).toBe('2026-09-23T17:00:00.000Z')
    // 900 minutes before = the day before at 09:00 local.
    expect(new Date(anchor - 900 * MIN).toISOString()).toBe('2026-09-23T02:00:00.000Z')
  })

  it('rings a reminder from its time until the event starts', () => {
    const start = Date.parse('2026-04-01T09:00:00Z')
    const list = [{ minutesBefore: 10 }]
    expect(dueReminders(start, list, start - 11 * MIN, 2 * MIN).ring).toBeUndefined()
    expect(dueReminders(start, list, start - 10 * MIN, 2 * MIN).ring?.minutesBefore).toBe(10)
    // Asleep at 08:50, awake at 08:55: still worth saying.
    expect(dueReminders(start, list, start - 5 * MIN, 2 * MIN).ring?.minutesBefore).toBe(10)
    expect(dueReminders(start, list, start + MIN, 2 * MIN).ring).toBeUndefined()
  })

  it('gives an at-start reminder a short grace period', () => {
    const start = Date.parse('2026-04-01T09:00:00Z')
    expect(dueReminders(start, [{ minutesBefore: 0 }], start + MIN, 2 * MIN).ring).toBeDefined()
    expect(dueReminders(start, [{ minutesBefore: 0 }], start + 3 * MIN, 2 * MIN).ring).toBeUndefined()
  })

  it('rings only the latest of several overdue reminders, and never an email one', () => {
    const start = Date.parse('2026-04-01T09:00:00Z')
    const { ring, handled } = dueReminders(
      start,
      [{ minutesBefore: 1440 }, { minutesBefore: 60 }, { minutesBefore: 30, method: 'email' }],
      start - 20 * MIN,
      2 * MIN
    )
    expect(ring?.minutesBefore).toBe(60)
    expect(handled.map((d) => d.minutesBefore).sort((a, b) => a - b)).toEqual([60, 1440])
  })
})

describe('reminder wording', () => {
  const zone = 'UTC'
  const now = Date.parse('2026-04-01T08:00:00Z')

  it('describes how far off an occurrence is', () => {
    expect(describeReminderWhen('2026-04-01T07:59:00.000Z', false, now, zone).kind).toBe('now')
    expect(describeReminderWhen('2026-04-01T08:10:00.000Z', false, now, zone)).toMatchObject({
      kind: 'inMinutes',
      minutes: 10
    })
    expect(describeReminderWhen('2026-04-01T15:00:00.000Z', false, now, zone).kind).toBe('todayAt')
    expect(describeReminderWhen('2026-04-02T09:00:00.000Z', false, now, zone).kind).toBe('tomorrowAt')
    expect(describeReminderWhen('2026-04-05T09:00:00.000Z', false, now, zone).kind).toBe('onDateAt')
    expect(describeReminderWhen('2026-04-01T00:00:00.000Z', true, now, zone).kind).toBe('today')
    expect(describeReminderWhen('2026-04-02T00:00:00.000Z', true, now, zone).kind).toBe('tomorrow')
  })

  it('describes offsets in the largest whole unit, and all-day ones as a day and a time', () => {
    expect(describeReminderOffset(0, false)).toEqual({ kind: 'atStart' })
    expect(describeReminderOffset(45, false)).toEqual({ kind: 'minutes', count: 45 })
    expect(describeReminderOffset(120, false)).toEqual({ kind: 'hours', count: 2 })
    expect(describeReminderOffset(2880, false)).toEqual({ kind: 'days', count: 2 })
    expect(describeReminderOffset(10080, false)).toEqual({ kind: 'weeks', count: 1 })
    expect(describeReminderOffset(900, true)).toEqual({ kind: 'daysBeforeAt', days: 1, time: '09:00' })
    expect(describeReminderOffset(360, true)).toEqual({ kind: 'daysBeforeAt', days: 1, time: '18:00' })
    expect(describeReminderOffset(9540, true)).toEqual({ kind: 'daysBeforeAt', days: 7, time: '09:00' })
    expect(describeReminderOffset(0, true)).toEqual({ kind: 'onDayAt', time: '00:00' })
  })
})

describe('reminders across providers', () => {
  const local = [{ minutesBefore: 10 }, { minutesBefore: 60 }, { minutesBefore: 30, method: 'email' as const }]

  it('knows what each provider can hold', () => {
    expect(remindersForProvider('graph', local)).toEqual([{ minutesBefore: 10 }])
    expect(remindersForProvider('caldav', local)).toEqual([{ minutesBefore: 10 }, { minutesBefore: 60 }])
    expect(remindersForProvider('google', local)).toHaveLength(3)
  })

  it('keeps the local list when the provider sends back exactly its share of it', () => {
    expect(mergePulledReminders('graph', local, [{ minutesBefore: 10 }])).toEqual(local)
    expect(mergePulledReminders('caldav', local, [{ minutesBefore: 60 }, { minutesBefore: 10 }])).toEqual(local)
  })

  it('takes the provider\'s list when it was changed over there', () => {
    expect(mergePulledReminders('graph', local, [{ minutesBefore: 15 }])).toEqual([{ minutesBefore: 15 }])
    expect(mergePulledReminders('graph', local, [])).toEqual([])
    expect(mergePulledReminders('google', local, undefined)).toBeUndefined()
  })

  it('reads a CalDAV event with no alarm as "none" when that is what was written', () => {
    expect(mergePulledReminders('caldav', [], undefined)).toEqual([])
    expect(mergePulledReminders('caldav', [{ minutesBefore: 30, method: 'email' }], undefined)).toEqual([
      { minutesBefore: 30, method: 'email' }
    ])
    // Alarms removed on another device: back to the default.
    expect(mergePulledReminders('caldav', [{ minutesBefore: 10 }], undefined)).toBeUndefined()
  })
})
