import type { ISqliteDatabase } from '../db/sqlite-driver'
import { SecureStore } from '../secure-store'
import { CalDavAdapter, type CalDavCredentials, type CalDavItem } from './caldav-adapter'
import { describeError } from './http'
import { parseIcsContent } from '../ics/parse-ics'
import { EventsRepo } from '../db/repos/events-repo'
import { SyncStateRepo } from '../db/repos/sync-state-repo'
import type { Attendee, Calendar, SyncResult } from '@shared/event-model'
import { markSelfAttendee } from '@shared/event-model'
import { mergePulledReminders, parseRemindersJson, serializeReminders } from '@shared/reminders'

/**
 * Changed resources fetched by name (calendar-multiget) up to this many; past
 * it one full query costs less than the batches would.
 */
const MULTIGET_MAX = 500

/** Stored as the pull state of a calendar whose server reports no ctag. */
const PULLED_WITHOUT_CTAG = 'pulled'

export class CalDavSyncEngine {
  private secureStore: SecureStore
  private eventsRepo: EventsRepo
  private syncStateRepo: SyncStateRepo

  constructor(private db: ISqliteDatabase) {
    this.secureStore = new SecureStore(db)
    this.eventsRepo = new EventsRepo(db)
    this.syncStateRepo = new SyncStateRepo(db)
  }

  /**
   * Sync calendar list from CalDAV server. Returns each calendar with its ctag,
   * which changes whenever anything in the calendar does.
   */
  async syncCalendarList(
    accountId: string,
    creds: CalDavCredentials
  ): Promise<{ id: string; ctag?: string }[]> {
    const adapter = new CalDavAdapter(creds)
    const descriptors = await adapter.discoverCalendars()
    const now = new Date().toISOString()
    const syncedCalendars: { id: string; ctag?: string }[] = []

    for (const desc of descriptors) {
      const calId = desc.href
      const name = desc.displayName || 'CalDAV Calendar'
      const color = desc.color || '#10b981'
      const isReadOnly = desc.isReadOnly === true

      const existing = this.db
        .prepare('SELECT id FROM calendars WHERE id = ?')
        .get<{ id: string }>(calId)

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO calendars (id, account_id, name, color, is_visible, is_read_only, is_default, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?)`
          )
          .run(calId, accountId, name, color, isReadOnly ? 1 : 0, now, now)
      } else {
        this.db
          .prepare(
            // Colour is local-only: the provider seeds it when the calendar is
            // first discovered and never overwrites it again, so what you pick
            // here stays picked.
            `UPDATE calendars
             SET name = ?, is_read_only = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(name, isReadOnly ? 1 : 0, now, calId)
      }

      syncedCalendars.push({ id: calId, ctag: desc.ctag })
    }

    return syncedCalendars
  }

  /**
   * Pull events from a CalDAV calendar collection.
   *
   * The listing is the whole calendar, so it also says what is gone: a row that
   * has been on the server and is no longer listed was deleted elsewhere (OneCal,
   * another client) and is deleted here too.
   */
  async pullCalendarEvents(
    calendarId: string,
    creds: CalDavCredentials,
    /** The account's address, to find its own entry in each guest list. */
    selfEmail?: string
  ): Promise<{ pulledCount: number }> {
    const adapter = new CalDavAdapter(creds)
    const { items: rawIcsList, unchanged, missing } = await this.downloadChanged(adapter, calendarId)
    let pulledCount = 0

    // An event created here keeps its own id, and one pulled before its href was
    // recorded is keyed by its UID, so looking a pulled event up by id alone
    // missed every event xrncal had pushed and inserted a second copy. Prefer the
    // href, then the locally created row, which exceptions and lunar links name.
    // Two lookups, not one with an OR: that could use neither index and scanned
    // the calendar for every event, which on a whole-calendar pull is n².
    const findLocalId = (href: string, uid: string): string | undefined =>
      this.db
        .prepare('SELECT id FROM events WHERE calendar_id = ? AND provider_event_id = ?')
        .get<{ id: string }>(calendarId, href)?.id ??
      this.db
        .prepare('SELECT id FROM events WHERE calendar_id = ? AND uid = ? ORDER BY (id <> uid) DESC LIMIT 1')
        .get<{ id: string }>(calendarId, uid)?.id

    // A new event is keyed by its UID, but ids span every calendar and a UID
    // only has to be unique within one: the same event can sit in two calendars
    // (an invitation copied across). Upserting onto the other calendar's row
    // would have overwritten it, so that case gets an id of its own.
    const newLocalId = (uid: string): string =>
      this.db.prepare('SELECT 1 AS taken FROM events WHERE id = ?').get<{ taken: number }>(uid)
        ? `evt_${Math.random().toString(36).slice(2, 10)}`
        : uid

    this.db.transaction(() => {
      const listedIds = new Set<string>()
      // A resource that went between the listing and the download proves nothing either way.
      let unreadable = missing

      // Resources listed with the etag they were last read at are left as they are.
      if (unchanged.size > 0) {
        const known = this.db
          .prepare('SELECT id, provider_event_id FROM events WHERE calendar_id = ? AND provider_event_id IS NOT NULL')
          .all<{ id: string; provider_event_id: string }>(calendarId)
        for (const row of known) {
          if (unchanged.has(row.provider_event_id)) listedIds.add(row.id)
        }
      }

      for (const item of rawIcsList) {
        try {
          const parsed = parseIcsContent(item.ics ?? '', calendarId)
          const now = new Date().toISOString()

          const idByUid = new Map<string, string>()
          for (const evt of parsed.events) {
            const uid = evt.uid || `evt_${Math.random().toString(36).slice(2, 10)}`
            const eventId = findLocalId(item.href, uid) ?? newLocalId(uid)
            listedIds.add(eventId)
            idByUid.set(uid, eventId)
            const stored = this.db
              .prepare('SELECT reminders, rsvp_pending FROM events WHERE id = ?')
              .get<{ reminders: string | null; rsvp_pending: string | null }>(eventId)
            const reminders = mergePulledReminders(
              'caldav',
              stored ? parseRemindersJson(stored.reminders) : undefined,
              evt.reminders ?? undefined
            )
            const applied = this.db
              .prepare(
                `INSERT INTO events (
                  id, provider_event_id, calendar_id, uid, title, notes, location,
                  dtstart_utc, dtend_utc, tzid, all_day, rrule, exdate, color,
                  meeting_url, reminders, etag, dirty, is_deleted, attendees_synced, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  provider_event_id = excluded.provider_event_id,
                  uid = excluded.uid,
                  title = excluded.title,
                  notes = excluded.notes,
                  location = excluded.location,
                  dtstart_utc = excluded.dtstart_utc,
                  dtend_utc = excluded.dtend_utc,
                  tzid = excluded.tzid,
                  all_day = excluded.all_day,
                  rrule = excluded.rrule,
                  exdate = excluded.exdate,
                  color = excluded.color,
                  meeting_url = excluded.meeting_url,
                  reminders = excluded.reminders,
                  etag = excluded.etag,
                  dirty = 0,
                  is_deleted = 0,
                  attendees_synced = 1,
                  updated_at = excluded.updated_at
                WHERE events.dirty = 0 AND events.has_conflict = 0`
              )
              .run(
                eventId,
                item.href,
                calendarId,
                uid,
                evt.title,
                evt.notes || null,
                evt.location || null,
                evt.dtStartUtc,
                evt.dtEndUtc,
                evt.tzid || 'UTC',
                evt.allDay ? 1 : 0,
                evt.rrule || null,
                evt.exdate || null,
                evt.color || null,
                evt.meetingUrl || null,
                serializeReminders(reminders),
                item.etag || null,
                now,
                now
              )
            // A reply still on its way would be overwritten by the old answer.
            if (applied.changes > 0 && !stored?.rsvp_pending) {
              this.eventsRepo.replaceAttendees(eventId, markSelfAttendee(evt.attendees ?? [], selfEmail))
            }
            // What an edit here has to keep of what other clients stored.
            if (applied.changes > 0) this.saveServerCopy(eventId, item.ics ?? '')
            pulledCount++
          }

          this.pullOccurrenceExceptions(parsed.exceptions, idByUid, now)
        } catch {
          // An item that will not parse is skipped; the rest of the calendar still syncs.
          unreadable++
        }
      }

      // Unsent edits and conflicts stay, as does anything that has never reached
      // the server, and lunar masters, which never leave this machine. An item
      // that would not parse could be any row, so then nothing is removed.
      if (unreadable === 0) {
        const synced = this.db
          .prepare(
            `SELECT id FROM events
             WHERE calendar_id = ? AND dirty = 0 AND has_conflict = 0 AND lunar_rule IS NULL
               AND (etag IS NOT NULL OR provider_event_id IS NOT NULL)`
          )
          .all<{ id: string }>(calendarId)
        for (const row of synced) {
          if (listedIds.has(row.id)) continue
          this.db.prepare('DELETE FROM events WHERE id = ?').run(row.id)
          pulledCount++
        }
      }
    })()

    return { pulledCount }
  }

  /**
   * The resources to write, and the hrefs listed with the etag they were last
   * read at.
   *
   * One event edited on the phone changes the calendar's ctag, and the pull used
   * to download every event and rewrite every row for it: ~3.7 s of FTS
   * re-indexing on ~8,000 events, with the main process blocked throughout. Now
   * the etags are listed first and only resources whose etag differs from the
   * stored one are downloaded. A calendar with no pull state - its first sync,
   * or a migration cleared `sync_token` so stored rows are read again - is
   * downloaded and written whole.
   */
  private async downloadChanged(
    adapter: CalDavAdapter,
    calendarId: string
  ): Promise<{ items: CalDavItem[]; unchanged: Set<string>; missing: number }> {
    if (this.syncStateRepo.getSyncToken(calendarId) === null) {
      return { items: (await adapter.pullCalendarEvents(calendarId)).rawIcsList, unchanged: new Set(), missing: 0 }
    }

    const stored = new Map<string, string | null>()
    const rows = this.db
      .prepare('SELECT provider_event_id, etag FROM events WHERE calendar_id = ? AND provider_event_id IS NOT NULL')
      .all<{ provider_event_id: string; etag: string | null }>(calendarId)
    for (const { provider_event_id: href, etag } of rows) {
      // Rows read from one resource that disagree get it read again.
      stored.set(href, stored.has(href) && stored.get(href) !== etag ? null : etag)
    }
    const isUnchanged = (item: { href: string; etag?: string }): boolean =>
      Boolean(item.etag) && stored.get(item.href) === item.etag

    const listing = await adapter.listEventEtags(calendarId)
    const unchanged = new Set(listing.filter(isUnchanged).map((l) => l.href))
    const changed = listing.filter((l) => !unchanged.has(l.href)).map((l) => l.href)
    if (changed.length === 0) return { items: [], unchanged, missing: 0 }

    const fetched = changed.length <= MULTIGET_MAX ? await adapter.fetchEvents(calendarId, changed) : null
    if (fetched) {
      const got = new Set(fetched.map((i) => i.href))
      return { items: fetched, unchanged, missing: changed.filter((href) => !got.has(href)).length }
    }

    // Too many to name one by one, or a server without multiget: the whole
    // calendar, written only where it changed.
    const all = (await adapter.pullCalendarEvents(calendarId)).rawIcsList
    return {
      items: all.filter((i) => !isUnchanged(i)),
      unchanged: new Set(all.filter(isUnchanged).map((i) => i.href)),
      missing: 0
    }
  }

  /**
   * A series' changed and cancelled occurrences are RECURRENCE-ID components in
   * the same resource as its master. The pull used to drop them, so a moved
   * occurrence showed at its old time - and the next push of that series from
   * here re-PUT it without them, erasing them on the server for every client.
   * Overrides the server no longer has are dropped too, unless they or their
   * series have unsent edits.
   */
  private pullOccurrenceExceptions(
    exceptions: ReturnType<typeof parseIcsContent>['exceptions'],
    idByUid: Map<string, string>,
    now: string
  ): void {
    const listed = new Map<string, Set<string>>()

    for (const exc of exceptions) {
      const masterId = exc.masterUid ? idByUid.get(exc.masterUid) : undefined
      if (!masterId) continue
      if (!listed.has(masterId)) listed.set(masterId, new Set())
      listed.get(masterId)!.add(exc.originalStartUtc)

      this.db
        .prepare(
          `INSERT INTO event_exceptions (
            id, master_event_id, original_start_utc, is_cancelled,
            title, notes, location, dtstart_utc, dtend_utc, tzid, all_day, color,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(master_event_id, original_start_utc) DO UPDATE SET
            is_cancelled = excluded.is_cancelled,
            title = excluded.title,
            notes = excluded.notes,
            location = excluded.location,
            dtstart_utc = excluded.dtstart_utc,
            dtend_utc = excluded.dtend_utc,
            tzid = excluded.tzid,
            all_day = excluded.all_day,
            color = excluded.color,
            updated_at = excluded.updated_at
          WHERE event_exceptions.dirty = 0`
        )
        .run(
          `exc_${masterId}_${exc.originalStartUtc.replace(/[:.]/g, '')}`,
          masterId,
          exc.originalStartUtc,
          exc.isCancelled ? 1 : 0,
          exc.title || null,
          exc.notes || null,
          exc.location || null,
          exc.dtStartUtc || null,
          exc.dtEndUtc || null,
          exc.tzid || null,
          exc.allDay === undefined ? null : exc.allDay ? 1 : 0,
          exc.color || null,
          now,
          now
        )
    }

    for (const masterId of new Set(idByUid.values())) {
      const keep = listed.get(masterId)
      const stale = this.db
        .prepare(
          `SELECT x.id, x.original_start_utc FROM event_exceptions x
           JOIN events e ON e.id = x.master_event_id
           WHERE x.master_event_id = ? AND x.dirty = 0 AND e.dirty = 0`
        )
        .all<{ id: string; original_start_utc: string }>(masterId)
      for (const row of stale) {
        if (!keep?.has(row.original_start_utc)) {
          this.db.prepare('DELETE FROM event_exceptions WHERE id = ?').run(row.id)
        }
      }
    }
  }

  /**
   * Push local dirty modifications to CalDAV server
   */
  async pushDirtyEvents(
    calendarId: string,
    creds: CalDavCredentials,
    /** The account's address: the ORGANIZER of guests added here. */
    selfEmail?: string
  ): Promise<{ pushedCount: number; errorCount: number; lastError?: string }> {
    const adapter = new CalDavAdapter(creds)
    const calRow = this.db
      .prepare('SELECT * FROM calendars WHERE id = ?')
      .get<any>(calendarId)

    if (!calRow) return { pushedCount: 0, errorCount: 0 }

    const calendar: Calendar = {
      id: calRow.id,
      accountId: calRow.account_id,
      name: calRow.name,
      color: calRow.color,
      isVisible: calRow.is_visible === 1,
      isReadOnly: calRow.is_read_only === 1,
      isDefault: calRow.is_default === 1,
      createdAt: calRow.created_at,
      updatedAt: calRow.updated_at
    }

    // A reply to an invitation is a PUT like any edit here: the server reads
    // the new PARTSTAT and passes it on to the organizer.
    const dirtyRows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE calendar_id = ? AND (dirty = 1 OR rsvp_pending IS NOT NULL) AND has_conflict = 0`
      )
      .all<any>(calendarId)

    // A series whose master is clean but which has a pending occurrence override
    // or cancellation still needs re-PUTting: CalDAV keeps the whole series in
    // one resource, so the exception rides along with the master.
    const dirtyIds = new Set(dirtyRows.map((r) => r.id))
    for (const master of this.eventsRepo.listMastersWithDirtyExceptions(calendarId)) {
      if (dirtyIds.has(master.id)) continue
      const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get<any>(master.id)
      if (row) dirtyRows.push(row)
    }

    let pushedCount = 0
    let errorCount = 0
    /** Why the last push failed; conflicts are left out, as they have their own way out. */
    let lastError: string | undefined

    for (const row of dirtyRows) {
      try {
        const isDeleted = row.is_deleted === 1

        if (isDeleted) {
          const ok = await adapter.deleteEvent(calendarId, row.uid || row.id, row.provider_event_id || undefined)
          if (ok) {
            this.db.prepare('DELETE FROM events WHERE id = ?').run(row.id)
            pushedCount++
          } else {
            lastError = 'The server refused to delete an event'
            errorCount++
          }
        } else {
          const serverCopy = this.db
            .prepare('SELECT ics FROM event_sources WHERE event_id = ?')
            .get<{ ics: string }>(row.id)?.ics
          const sendsGuests = row.attendees_synced === 1 || !row.etag
          const pushRes = await adapter.pushEvent(
            calendar,
            {
              id: row.id,
              providerEventId: row.provider_event_id || undefined,
              calendarId: row.calendar_id,
              uid: row.uid,
              title: row.title,
              notes: row.notes,
              location: row.location,
              dtStartUtc: row.dtstart_utc,
              dtEndUtc: row.dtend_utc,
              tzid: row.tzid,
              allDay: row.all_day === 1,
              rrule: row.rrule,
              exdate: row.exdate,
              color: row.color,
              meetingUrl: row.meeting_url,
              reminders: parseRemindersJson(row.reminders),
              // An unknown guest list is not sent; the server's copy keeps its
              // guests when there is one, and without it the PUT has none.
              attendees: sendsGuests
                ? withOrganizer(this.eventsRepo.getEventById(row.id)?.event.attendees ?? [], selfEmail)
                : undefined,
              etag: row.etag,
              dirty: false,
              isDeleted: false,
              createdAt: row.created_at,
              updatedAt: row.updated_at
            },
            this.eventsRepo.getExceptionsForEvent(row.id),
            serverCopy ? { ics: serverCopy, keepAttendees: !sendsGuests } : undefined
          )

          if (pushRes.success) {
            const now = new Date().toISOString()
            this.db
              .prepare(
                `UPDATE events SET provider_event_id = ?, etag = ?, dirty = 0, has_conflict = 0,
                   rsvp_pending = NULL, updated_at = ?
                 WHERE id = ?`
              )
              .run(pushRes.href || row.provider_event_id, pushRes.etag || row.etag, now, row.id)
            if (serverCopy && pushRes.body) this.saveServerCopy(row.id, pushRes.body)
            this.eventsRepo.markExceptionsSyncedForMaster(row.id)
            pushedCount++
          } else if (pushRes.conflict) {
            this.db.prepare('UPDATE events SET has_conflict = 1 WHERE id = ?').run(row.id)
            errorCount++
          } else {
            errorCount++
          }
        }
      } catch (err) {
        lastError = describeError(err)
        errorCount++
      }
    }

    return { pushedCount, errorCount, lastError }
  }

  /**
   * Sync all connected CalDAV accounts
   */
  async syncAll(): Promise<SyncResult> {
    const activeAccounts = this.db
      .prepare("SELECT * FROM accounts WHERE type = 'caldav' AND is_active = 1")
      .all<any>()

    if (activeAccounts.length === 0) {
      return { success: true, pulledCount: 0, pushedCount: 0, errorCount: 0, message: 'No CalDAV accounts connected' }
    }

    let totalPulled = 0
    let totalPushed = 0
    let totalErrors = 0
    const accountErrors: Record<string, string> = {}

    for (const acc of activeAccounts) {
      try {
        const creds = this.secureStore.getToken<CalDavCredentials>(acc.id)
        if (!creds) {
          // Skipping it quietly left "connected" showing on an account that had
          // not synced since the keyring went away.
          throw new Error('The saved password could not be read: the system keyring is locked or unavailable')
        }

        const calendars = await this.syncCalendarList(acc.id, creds)
        let firstFailure: string | undefined
        for (const { id: calId, ctag } of calendars) {
          // One calendar failing - a server error on one collection - no longer
          // skips the calendars after it.
          try {
            const pushRes = await this.pushDirtyEvents(calId, creds, acc.email || creds.username)
            totalPushed += pushRes.pushedCount
            totalErrors += pushRes.errorCount
            // Edits that cannot reach the server matter as much as a failed pull.
            if (pushRes.lastError) firstFailure ??= pushRes.lastError

            // A pull downloads the whole calendar, and polls run every 20 s. An
            // unchanged ctag, with nothing pushed since it was read, means the
            // server has nothing new. The ctag stored is the one read before the
            // pull, so a change landing mid-pull is fetched again next time.
            if (ctag && pushRes.pushedCount === 0 && ctag === this.syncStateRepo.getSyncToken(calId)) {
              this.recordOutcome(calId, pushRes, 0)
              continue
            }

            const pullRes = await this.pullCalendarEvents(calId, creds, acc.email || creds.username)
            totalPulled += pullRes.pulledCount
            // Without a ctag every poll pulls, but the stored state still lets
            // that pull download only what changed.
            this.syncStateRepo.saveSyncToken(calId, ctag ?? PULLED_WITHOUT_CTAG)
            this.recordOutcome(calId, pushRes, pullRes.pulledCount)
          } catch (calErr) {
            this.syncStateRepo.recordFailure(calId, describeError(calErr))
            firstFailure ??= describeError(calErr)
            totalErrors++
          }
        }
        if (firstFailure) accountErrors[acc.id] = firstFailure
      } catch (err) {
        accountErrors[acc.id] = describeError(err)
        totalErrors++
      }
    }

    return {
      success: totalErrors === 0,
      pulledCount: totalPulled,
      pushedCount: totalPushed,
      errorCount: totalErrors,
      message: `CalDAV sync finished: pulled ${totalPulled}, pushed ${totalPushed}`,
      accountErrors
    }
  }

  private saveServerCopy(eventId: string, ics: string): void {
    this.db
      .prepare(
        `INSERT INTO event_sources (event_id, ics) VALUES (?, ?)
         ON CONFLICT(event_id) DO UPDATE SET ics = excluded.ics`
      )
      .run(eventId, ics)
  }

  /** A calendar that pulled but could not push is not "ok". */
  private recordOutcome(calendarId: string, pushRes: { errorCount: number; lastError?: string }, pulled: number): void {
    if (pushRes.errorCount > 0) {
      this.syncStateRepo.recordFailure(
        calendarId,
        `push failed for ${pushRes.errorCount} event(s): ${pushRes.lastError ?? 'changed on the server meanwhile'}`
      )
    } else {
      this.syncStateRepo.recordSuccess(calendarId, pulled)
    }
  }
}

/**
 * iCalendar requires an ORGANIZER wherever there are ATTENDEEs, and a server
 * that schedules (iCloud, Nextcloud, Fastmail) works out from it who sends the
 * invitations. Guests added here come with no organizer entry, so the account
 * is named - when its address is known; a bare username is not an address.
 */
function withOrganizer(attendees: Attendee[], selfEmail: string | undefined): Attendee[] {
  const email = selfEmail?.trim()
  if (attendees.length === 0 || attendees.some((a) => a.isOrganizer) || !email?.includes('@')) return attendees
  const own = attendees.find((a) => a.email.toLowerCase() === email.toLowerCase())
  return own
    ? attendees.map((a) => (a === own ? { ...a, isOrganizer: true, isSelf: true } : a))
    : [{ email, responseStatus: 'accepted', isOrganizer: true, isSelf: true }, ...attendees]
}
