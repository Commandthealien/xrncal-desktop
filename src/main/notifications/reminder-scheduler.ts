import { Notification, BrowserWindow } from 'electron'
import { DateTime } from 'luxon'
import type { ISqliteDatabase } from '../db/sqlite-driver'
import { EventsRepo } from '../db/repos/events-repo'
import { CalendarsRepo } from '../db/repos/calendars-repo'
import { SettingsRepo } from '../db/repos/settings-repo'
import { ReminderLogRepo, ReminderStateRepo } from '../db/repos/reminder-log-repo'
import { mt, getMainLocale } from '../i18n-main'
import { IPC_CHANNELS, type ActiveReminder } from '@shared/ipc-contract'
import type { ExpandedOccurrence } from '@shared/event-model'
import {
  effectiveReminders,
  reminderAnchorMs,
  dueReminders,
  describeReminderWhen,
  type ReminderDefaults
} from '@shared/reminders'
import { formatClockTime } from '@shared/time-format'

const TICK_MS = 30_000
/** How long past its fire time an at-start reminder may still ring. Longer
 *  than a tick, so one late timer never swallows it. */
const GRACE_MS = 2 * 60_000
const DAY_MS = 24 * 60 * 60_000
const NO_DEFAULTS: ReminderDefaults = { timed: null, allDay: null }

/**
 * Rings event reminders and keeps the ones that have rung until the user deals
 * with them.
 *
 * It used to give every timed event a single notification ten minutes before,
 * ignore all-day events entirely, and focus `BrowserWindow.getAllWindows()[0]`
 * when a notification was clicked - which, once the main window had been
 * closed to the tray, was the hidden mini window or nothing at all.
 *
 * Native notifications cannot carry buttons on Linux, so snooze and "join"
 * live in the app: every reminder that rings also goes into an active list the
 * renderer shows, and clicking the notification opens the window onto it.
 *
 * What has rung is kept in `reminder_log`, since a reminder stays due until its
 * event starts and a restart would otherwise ring it again. The cards on screen
 * and the snoozed reminders are kept in `reminder_state`, so a restart brings
 * them back as they were (without ringing the cards again).
 */
export class ReminderScheduler {
  private eventsRepo: EventsRepo
  private calendarsRepo: CalendarsRepo
  private settingsRepo: SettingsRepo
  private reminderLog: ReminderLogRepo
  private timer: NodeJS.Timeout | null = null
  /** `${occurrenceId}|${minutesBefore}` -> the occurrence's anchor, so entries
   *  can be dropped once they can no longer come due. Mirrors `reminder_log`. */
  private fired: Map<string, number>
  private active = new Map<string, ActiveReminder>()
  /** Occurrence id -> when its snooze is up. */
  private snoozed: Map<string, number>
  private state: ReminderStateRepo
  /** Cards on screen at the last quit, put back by the first tick that finds their occurrences. */
  private toRestore: string[]

  constructor(
    db: ISqliteDatabase,
    private showMainWindow: () => void
  ) {
    this.eventsRepo = new EventsRepo(db)
    this.calendarsRepo = new CalendarsRepo(db)
    this.settingsRepo = new SettingsRepo(db)
    this.reminderLog = new ReminderLogRepo(db)
    this.fired = this.reminderLog.load()
    this.state = new ReminderStateRepo(db)
    const saved = this.state.load()
    this.snoozed = saved.snoozed
    this.toRestore = saved.showing
  }

  start(): void {
    if (this.timer) clearInterval(this.timer)
    this.safeTick()
    this.timer = setInterval(() => this.safeTick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  listActive(): ActiveReminder[] {
    return [...this.active.values()].sort((a, b) =>
      a.occurrence.startUtc.localeCompare(b.occurrence.startUtc)
    )
  }

  dismiss(key: string): void {
    this.state.remove(key)
    if (this.active.delete(key)) this.broadcast()
  }

  snooze(key: string, minutes: number, nowMs = Date.now()): void {
    const entry = this.active.get(key)
    if (!entry || !(minutes > 0)) return
    this.active.delete(key)
    this.snoozed.set(key, nowMs + minutes * 60_000)
    this.state.save(key, nowMs + minutes * 60_000)
    this.broadcast()
  }

  /** A tick that throws (say, the database closing under it at quit) must not
   *  take the interval with it. */
  private safeTick(): void {
    try {
      this.tick()
    } catch {
      // Next tick tries again.
    }
  }

  tick(nowMs = Date.now()): void {
    const calendars = this.calendarsRepo.listCalendars()
    const visibleIds = calendars.filter((c) => c.isVisible).map((c) => c.id)
    const defaults = this.readDefaults()
    // A day either side: an all-day event's anchor is local midnight, which
    // can sit up to fourteen hours away from the UTC midnight it is stored at.
    // The range query returns what overlaps it, so anything still under way is
    // in it too.
    const occurrences =
      visibleIds.length === 0
        ? []
        : this.eventsRepo.queryEventsByRange(
            visibleIds,
            new Date(nowMs - DAY_MS).toISOString(),
            new Date(nowMs + this.maxLeadMinutes(defaults) * 60_000 + DAY_MS).toISOString()
          )
    const current = new Map(occurrences.map((o) => [o.id, o]))

    let changed = this.prune(nowMs, current)

    // Back on screen as they were at the last quit; they have rung already.
    for (const key of this.toRestore) {
      const occ = current.get(key)
      if (occ && endMs(occ) > nowMs) {
        this.active.set(key, { key, occurrence: occ })
        changed = true
      } else {
        this.state.remove(key)
      }
    }
    this.toRestore = []

    for (const [key, untilMs] of this.snoozed) {
      if (untilMs > nowMs) continue
      this.snoozed.delete(key)
      this.state.remove(key)
      const occ = current.get(key)
      // Over by the time the snooze is up: nothing left to remind of.
      if (!occ || endMs(occ) <= nowMs) continue
      this.ring(occ, nowMs)
      changed = true
    }

    const sources = this.eventsRepo.getReminderSources(occurrences.map((o) => o.eventId))
    const calendarDefaults = new Map(calendars.map((c) => [c.id, c.defaultReminders]))
    const readOnlyIds = new Set(calendars.filter((c) => c.isReadOnly).map((c) => c.id))
    const newlyFired: { key: string; anchorMs: number }[] = []

    for (const occ of occurrences) {
      const source = sources.get(occ.eventId)
      // An invitation the user turned down is not something to be reminded of.
      if (source?.declined) continue
      // The app's default is for the user's own calendars. A feed, a holiday
      // list or a colleague's shared calendar rings only where the event (or
      // the provider's default for that calendar) asks to.
      const reminders = effectiveReminders(
        source?.reminders,
        occ.allDay,
        calendarDefaults.get(occ.calendarId),
        readOnlyIds.has(occ.calendarId) ? NO_DEFAULTS : defaults
      )
      if (reminders.length === 0) continue

      const anchorMs = reminderAnchorMs(occ.startUtc, occ.allDay)
      const { ring, handled } = dueReminders(anchorMs, reminders, nowMs, GRACE_MS)
      if (!ring) continue

      const isNew = !this.fired.has(`${occ.id}|${ring.minutesBefore}`)
      for (const d of handled) {
        const key = `${occ.id}|${d.minutesBefore}`
        if (this.fired.has(key)) continue
        this.fired.set(key, anchorMs)
        newlyFired.push({ key, anchorMs })
      }
      // A snoozed reminder rings when its snooze is up, not before.
      if (!isNew || this.snoozed.has(occ.id)) continue

      this.ring(occ, nowMs)
      changed = true
    }

    this.reminderLog.add(newlyFired)
    if (changed) this.broadcast()
  }

  private ring(occurrence: ExpandedOccurrence, nowMs: number): void {
    this.active.set(occurrence.id, { key: occurrence.id, occurrence })
    this.state.save(occurrence.id, null)
    this.notify(occurrence, nowMs)
  }

  /**
   * Drop what can no longer matter, and catch up with edits: a reminder whose
   * event is over, deleted, moved (an occurrence's id carries its start) or
   * hidden goes, and one whose event was renamed shows the new name. Fired
   * markers go once their occurrence is long past. Returns whether the active
   * list changed.
   */
  private prune(nowMs: number, current: Map<string, ExpandedOccurrence>): boolean {
    let forgot = false
    for (const [key, anchorMs] of this.fired) {
      if (anchorMs >= nowMs - DAY_MS) continue
      this.fired.delete(key)
      forgot = true
    }
    if (forgot) this.reminderLog.pruneBefore(nowMs - DAY_MS)

    let changed = false
    for (const [key, entry] of this.active) {
      const fresh = current.get(key)
      if (!fresh || endMs(fresh) <= nowMs) {
        this.active.delete(key)
        this.state.remove(key)
        changed = true
      } else if (JSON.stringify(fresh) !== JSON.stringify(entry.occurrence)) {
        this.active.set(key, { key, occurrence: fresh })
        changed = true
      }
    }
    for (const key of this.snoozed.keys()) {
      if (current.has(key)) continue
      this.snoozed.delete(key)
      this.state.remove(key)
    }
    return changed
  }

  private readDefaults(): ReminderDefaults {
    return {
      timed: this.settingsRepo.getSetting('defaultReminderMinutes'),
      allDay: this.settingsRepo.getSetting('defaultAllDayReminderMinutes')
    }
  }

  /** The longest lead any reminder in use has, so the query window reaches
   *  every occurrence that could come due. */
  private maxLeadMinutes(defaults: ReminderDefaults): number {
    let max = Math.max(defaults.timed ?? 0, defaults.allDay ?? 0)
    for (const list of this.eventsRepo.listReminderListsInUse()) {
      for (const r of list) max = Math.max(max, r.minutesBefore)
    }
    return max
  }

  private notify(occ: ExpandedOccurrence, nowMs: number): void {
    if (!Notification.isSupported()) return
    const location = occ.location ? ` · ${occ.location}` : ''
    const notification = new Notification({
      title: occ.title,
      body: `${this.describeWhen(occ, nowMs)}${location}`,
      silent: false
    })
    notification.on('click', () => this.showMainWindow())
    notification.show()
  }

  private describeWhen(occ: ExpandedOccurrence, nowMs: number): string {
    const when = describeReminderWhen(occ.startUtc, occ.allDay, nowMs)
    if (when.kind === 'now') return mt('notify.now')
    const timeFormat = this.settingsRepo.getSetting('timeFormat')
    const time = formatClockTime(when.start, timeFormat)
    const date = when.start.setLocale(getMainLocale()).toFormat('ccc d LLL')
    switch (when.kind) {
      case 'inMinutes':
        return mt('notify.inMinutes', { n: when.minutes, time })
      case 'todayAt':
        return mt('notify.todayAt', { time })
      case 'tomorrowAt':
        return mt('notify.tomorrowAt', { time })
      case 'onDateAt':
        return mt('notify.onDateAt', { date, time })
      case 'today':
        return mt('notify.today')
      case 'tomorrow':
        return mt('notify.tomorrow')
      case 'onDate':
        return mt('notify.onDate', { date })
    }
  }

  private broadcast(): void {
    const active = this.listActive()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.REMINDERS.CHANGED, active)
    }
  }
}

/** When a reminder stops being worth showing: the event's end, or for an
 *  all-day event the end of its last local day. */
function endMs(occ: ExpandedOccurrence): number {
  if (!occ.allDay) return DateTime.fromISO(occ.endUtc, { zone: 'utc' }).toMillis()
  return DateTime.fromISO(occ.endUtc.slice(0, 10), { zone: 'local' }).endOf('day').toMillis()
}
