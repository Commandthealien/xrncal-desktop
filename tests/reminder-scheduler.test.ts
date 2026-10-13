import { describe, it, expect, beforeEach, vi } from 'vitest'

const shown: { title: string; body: string; click?: () => void }[] = []

vi.mock('electron', () => ({
  Notification: class {
    static isSupported = () => true
    private entry: { title: string; body: string; click?: () => void }
    constructor(opts: { title: string; body: string }) {
      this.entry = { title: opts.title, body: opts.body }
    }
    on(event: string, cb: () => void) {
      if (event === 'click') this.entry.click = cb
    }
    show() {
      shown.push(this.entry)
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { createSqliteDriver } = await import('../src/main/db/sqlite-driver')
const { runMigrations, seedDefaultData } = await import('../src/main/db/database')
const { EventsRepo } = await import('../src/main/db/repos/events-repo')
const { SettingsRepo } = await import('../src/main/db/repos/settings-repo')
const { ReminderScheduler } = await import('../src/main/notifications/reminder-scheduler')

const CAL = 'calendar-local-default'
const MIN = 60_000

describe('ReminderScheduler', () => {
  let db: ReturnType<typeof createSqliteDriver>
  let events: InstanceType<typeof EventsRepo>
  let showMainWindow: ReturnType<typeof vi.fn>
  let scheduler: InstanceType<typeof ReminderScheduler>

  beforeEach(() => {
    shown.length = 0
    db = createSqliteDriver(':memory:')
    runMigrations(db)
    seedDefaultData(db)
    events = new EventsRepo(db)
    showMainWindow = vi.fn()
    scheduler = new ReminderScheduler(db, showMainWindow)
  })

  const timed = (startIso: string, reminders?: { minutesBefore: number }[] | null) =>
    events.createEvent({
      calendarId: CAL,
      title: 'Meeting',
      dtStartUtc: startIso,
      dtEndUtc: new Date(Date.parse(startIso) + 60 * MIN).toISOString(),
      reminders
    })

  it('rings the default ten minutes before a timed event, once', () => {
    timed('2026-04-01T09:00:00.000Z')
    const start = Date.parse('2026-04-01T09:00:00Z')

    scheduler.tick(start - 11 * MIN)
    expect(shown).toHaveLength(0)
    scheduler.tick(start - 10 * MIN)
    scheduler.tick(start - 9 * MIN)

    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('Meeting')
    expect(scheduler.listActive()).toHaveLength(1)
  })

  it('opens the main window - not whatever window happens to be first - on click', () => {
    timed('2026-04-01T09:00:00.000Z')
    scheduler.tick(Date.parse('2026-04-01T08:50:00Z'))
    shown[0].click?.()
    expect(showMainWindow).toHaveBeenCalledTimes(1)
  })

  it('honours an event\'s own list, including "none"', () => {
    timed('2026-04-01T09:00:00.000Z', [{ minutesBefore: 60 }])
    timed('2026-04-01T09:00:00.000Z', [])
    scheduler.tick(Date.parse('2026-04-01T08:00:00Z'))
    expect(shown).toHaveLength(1)
    scheduler.tick(Date.parse('2026-04-01T08:50:00Z'))
    expect(shown).toHaveLength(1)
  })

  it('rings an all-day event the day before when asked to', () => {
    events.createEvent({
      calendarId: CAL,
      title: 'Giỗ ông',
      dtStartUtc: '2026-09-24T00:00:00.000Z',
      dtEndUtc: '2026-09-24T23:59:59.999Z',
      allDay: true,
      reminders: [{ minutesBefore: 900 }]
    })
    const nineTheDayBefore = new Date(2026, 8, 23, 9, 0).getTime()
    scheduler.tick(nineTheDayBefore - MIN)
    expect(shown).toHaveLength(0)
    scheduler.tick(nineTheDayBefore)
    expect(shown.map((n) => n.title)).toEqual(['Giỗ ông'])
  })

  it('leaves all-day events silent by default, and follows the setting when there is one', () => {
    events.createEvent({
      calendarId: CAL,
      title: 'Holiday',
      dtStartUtc: '2026-09-24T00:00:00.000Z',
      dtEndUtc: '2026-09-24T23:59:59.999Z',
      allDay: true
    })
    const nineTheDayBefore = new Date(2026, 8, 23, 9, 0).getTime()
    scheduler.tick(nineTheDayBefore)
    expect(shown).toHaveLength(0)

    new SettingsRepo(db).setSetting('defaultAllDayReminderMinutes', 900)
    scheduler.tick(nineTheDayBefore + MIN)
    expect(shown).toHaveLength(1)
  })

  it('snoozes: off the list now, back when the snooze is up', () => {
    timed('2026-04-01T09:00:00.000Z')
    const t0 = Date.parse('2026-04-01T08:50:00Z')
    scheduler.tick(t0)
    const [entry] = scheduler.listActive()

    scheduler.snooze(entry.key, 5, t0)
    expect(scheduler.listActive()).toHaveLength(0)
    scheduler.tick(t0 + 4 * MIN)
    expect(shown).toHaveLength(1)
    scheduler.tick(t0 + 5 * MIN)
    expect(shown).toHaveLength(2)
    expect(scheduler.listActive()).toHaveLength(1)
  })

  it('drops a reminder from the list once dismissed, and once its event is over', () => {
    timed('2026-04-01T09:00:00.000Z')
    timed('2026-04-01T09:30:00.000Z')
    scheduler.tick(Date.parse('2026-04-01T08:50:00Z'))
    scheduler.tick(Date.parse('2026-04-01T09:20:00Z'))
    expect(scheduler.listActive()).toHaveLength(2)

    scheduler.dismiss(scheduler.listActive()[1].key)
    expect(scheduler.listActive()).toHaveLength(1)

    scheduler.tick(Date.parse('2026-04-01T10:01:00Z'))
    expect(scheduler.listActive()).toHaveLength(0)
  })

  it('reaches reminders with a long lead', () => {
    timed('2026-04-10T09:00:00.000Z', [{ minutesBefore: 10080 }])
    scheduler.tick(Date.parse('2026-04-03T09:00:00Z'))
    expect(shown).toHaveLength(1)
  })

  it('does not ring again after a restart a reminder that already rang', () => {
    // Due for the whole week before the event, so any launch that week used to ring it.
    timed('2026-04-10T09:00:00.000Z', [{ minutesBefore: 10080 }])
    scheduler.tick(Date.parse('2026-04-03T09:00:00Z'))
    expect(shown).toHaveLength(1)

    const restarted = new ReminderScheduler(db, showMainWindow)
    restarted.tick(Date.parse('2026-04-05T12:00:00Z'))
    expect(shown).toHaveLength(1)
  })

  it('keeps a snooze across a restart', () => {
    timed('2026-04-01T09:00:00.000Z')
    const t0 = Date.parse('2026-04-01T08:50:00Z')
    scheduler.tick(t0)
    scheduler.snooze(scheduler.listActive()[0].key, 5, t0)

    const restarted = new ReminderScheduler(db, showMainWindow)
    restarted.tick(t0 + 2 * MIN)
    expect(restarted.listActive()).toHaveLength(0)
    restarted.tick(t0 + 5 * MIN)
    expect(shown).toHaveLength(2)
    expect(restarted.listActive()).toHaveLength(1)
  })

  it('puts the cards still on screen back after a restart, without ringing them again', () => {
    timed('2026-04-01T09:00:00.000Z')
    timed('2026-04-01T09:05:00.000Z')
    scheduler.tick(Date.parse('2026-04-01T08:56:00Z'))
    expect(scheduler.listActive()).toHaveLength(2)
    scheduler.dismiss(scheduler.listActive()[0].key)

    const restarted = new ReminderScheduler(db, showMainWindow)
    restarted.tick(Date.parse('2026-04-01T08:58:00Z'))
    expect(restarted.listActive().map((a) => a.occurrence.startUtc)).toEqual(['2026-04-01T09:05:00.000Z'])
    expect(shown).toHaveLength(2)

    // Once its event is over it goes, and stays gone after another restart.
    restarted.tick(Date.parse('2026-04-01T10:06:00Z'))
    const again = new ReminderScheduler(db, showMainWindow)
    again.tick(Date.parse('2026-04-01T10:07:00Z'))
    expect(again.listActive()).toHaveLength(0)
  })

  it('still rings after a restart a reminder that came due while the app was closed', () => {
    timed('2026-04-01T09:00:00.000Z')
    const restarted = new ReminderScheduler(db, showMainWindow)
    restarted.tick(Date.parse('2026-04-01T08:55:00Z'))
    expect(shown).toHaveLength(1)
  })

  it('forgets fired reminders once their event is long past', () => {
    timed('2026-04-01T09:00:00.000Z')
    scheduler.tick(Date.parse('2026-04-01T08:50:00Z'))
    expect(db.prepare('SELECT COUNT(*) AS n FROM reminder_log').get<{ n: number }>()?.n).toBe(1)
    scheduler.tick(Date.parse('2026-04-03T09:00:00Z'))
    expect(db.prepare('SELECT COUNT(*) AS n FROM reminder_log').get<{ n: number }>()?.n).toBe(0)
  })

  it('takes a reminder off the list when its event is deleted, and keeps it up to date when renamed', () => {
    const a = timed('2026-04-01T09:00:00.000Z')
    const b = timed('2026-04-01T09:00:00.000Z')
    scheduler.tick(Date.parse('2026-04-01T08:50:00Z'))
    expect(scheduler.listActive()).toHaveLength(2)

    events.deleteEvent(a.id)
    events.updateEvent(b.id, { title: 'Renamed' })
    scheduler.tick(Date.parse('2026-04-01T08:51:00Z'))

    expect(scheduler.listActive().map((r) => r.occurrence.title)).toEqual(['Renamed'])
  })

  it('does not bring back a snoozed reminder whose event was deleted or is over', () => {
    const deleted = timed('2026-04-01T09:00:00.000Z')
    timed('2026-04-01T08:00:00.000Z') // ends 09:00
    const t0 = Date.parse('2026-04-01T07:50:00Z')
    scheduler.tick(t0)
    scheduler.tick(Date.parse('2026-04-01T08:50:00Z'))
    for (const r of scheduler.listActive()) scheduler.snooze(r.key, 60, Date.parse('2026-04-01T08:50:00Z'))
    expect(shown).toHaveLength(2)

    events.deleteEvent(deleted.id)
    scheduler.tick(Date.parse('2026-04-01T09:50:00Z'))

    expect(shown).toHaveLength(2)
    expect(scheduler.listActive()).toHaveLength(0)
  })
})
