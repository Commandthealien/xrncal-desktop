import { createHash } from 'node:crypto'
import type { ISqliteDatabase } from '../db/sqlite-driver'
import type { Calendar } from '@shared/event-model'
import { CalendarsRepo } from '../db/repos/calendars-repo'
import { EventsRepo } from '../db/repos/events-repo'
import { SyncStateRepo } from '../db/repos/sync-state-repo'
import { fetchWithTimeout, readTextWithin, ResponseTooLargeError } from '../sync/http'
import { MAX_ICS_SIZE_BYTES, parseIcsContent } from '../ics/parse-ics'

/**
 * Calendars subscribed to by URL: a published .ics feed - a school timetable,
 * a team's fixtures, an Outlook or Google calendar shared as a link.
 *
 * A subscription is a local, read-only calendar refreshed from its feed. The
 * feed is the whole calendar every time, so a refresh replaces the events
 * wholesale; each event keeps an id derived from its UID, so the selection in
 * the view and the reminders that already rang survive it.
 */

/** How often a feed is fetched again. Publishers update these a few times a
 *  day at most, and some rate-limit clients that ask more often. */
export const SUBSCRIPTION_REFRESH_MS = 6 * 60 * 60 * 1000

const SUBSCRIPTION_COLOR = '#9b6dd8'

/**
 * `webcal://` is how these links are usually published - it only means "a
 * calendar to subscribe to", and is fetched over HTTPS. Anything other than
 * HTTP(S) is refused: the URL is fetched from the main process.
 */
export function normaliseSubscriptionUrl(raw: string): string {
  const trimmed = raw.trim()
  const withScheme = /^webcals?:\/\//i.test(trimmed)
    ? trimmed.replace(/^webcals?:\/\//i, 'https://')
    : /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`Not a calendar link: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Calendar links must be web addresses (https://, http:// or webcal://): ${raw}`)
  }
  return url.toString()
}

async function fetchFeed(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'text/calendar, */*;q=0.5' } })
  if (!res.ok) throw new Error(`The calendar link answered HTTP ${res.status}`)
  const tooLarge = new Error('The calendar at that link is too large to subscribe to')
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > MAX_ICS_SIZE_BYTES) throw tooLarge
  // Read under a cap and a deadline: the feed's server is anyone's, and a body
  // that never finishes would otherwise hold up every account's sync.
  let text: string
  try {
    text = await readTextWithin(res, url, MAX_ICS_SIZE_BYTES)
  } catch (err) {
    throw err instanceof ResponseTooLargeError ? tooLarge : err
  }
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link does not lead to a calendar (.ics) file')
  return text
}

/** X-WR-CALNAME, the name most publishers give their feed. */
function feedName(ics: string): string | undefined {
  const match = ics.match(/^X-WR-CALNAME[^:\r\n]*:(.*(?:\r?\n[ \t].*)*)/im)
  if (!match) return undefined
  const name = match[1]
    .replace(/\r?\n[ \t]/g, '')
    .replace(/\\([,;\\])/g, '$1')
    .replace(/\\n/gi, ' ')
    .trim()
  return name || undefined
}

function stableEventId(calendarId: string, uid: string): string {
  return `sub_${createHash('sha1').update(`${calendarId}\n${uid}`).digest('hex').slice(0, 24)}`
}

function contentHash(ics: string): string {
  return createHash('sha1').update(ics).digest('hex')
}

/** Replace a subscribed calendar's events with what the feed holds now. */
function storeFeed(db: ISqliteDatabase, calendarId: string, ics: string): number {
  const parsed = parseIcsContent(ics, calendarId)
  const eventsRepo = new EventsRepo(db)
  let stored = 0

  db.transaction(() => {
    eventsRepo.deleteEventsByCalendar(calendarId)
    const idByUid = new Map<string, string>()
    for (const ev of parsed.events) {
      const uid = ev.uid || `${ev.title}|${ev.dtStartUtc}`
      const id = stableEventId(calendarId, uid)
      // Two VEVENTs with one UID and no RECURRENCE-ID: keep the first.
      if (idByUid.has(uid)) continue
      try {
        eventsRepo.createEvent({ ...ev, uid }, { allowReadOnly: true, id })
        idByUid.set(uid, id)
        stored++
      } catch {
        // One bad event does not cost the rest of the feed.
      }
    }
    for (const ex of parsed.exceptions) {
      const masterEventId = ex.masterUid ? idByUid.get(ex.masterUid) : undefined
      if (!masterEventId) continue
      try {
        eventsRepo.upsertException({ ...ex, masterEventId }, { allowReadOnly: true })
      } catch {
        // The series still shows, without that one change.
      }
    }
    db.prepare('UPDATE calendars SET subscription_refreshed_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      calendarId
    )
  })()

  return stored
}

/** Subscribe to a feed. It is fetched once before anything is created, so a
 *  bad link is refused rather than leaving an empty calendar behind. */
export async function addSubscription(db: ISqliteDatabase, rawUrl: string, name?: string): Promise<Calendar> {
  const url = normaliseSubscriptionUrl(rawUrl)
  const ics = await fetchFeed(url)
  // Parse before creating anything, for the same reason.
  parseIcsContent(ics, 'probe')

  const calendarsRepo = new CalendarsRepo(db)
  const calendar = calendarsRepo.createCalendar({
    name: name?.trim() || feedName(ics) || new URL(url).hostname,
    color: SUBSCRIPTION_COLOR,
    isReadOnly: true,
    subscriptionUrl: url
  })
  storeFeed(db, calendar.id, ics)
  new SyncStateRepo(db).saveSyncToken(calendar.id, contentHash(ics))
  return calendarsRepo.getCalendarById(calendar.id)!
}

/**
 * Fetch a subscription again. An unchanged feed - the usual case - costs one
 * request and no writes; the stored hash of the last copy decides.
 * Returns how many events were stored, 0 when nothing changed.
 */
export async function refreshSubscription(db: ISqliteDatabase, calendarId: string): Promise<number> {
  const calendar = new CalendarsRepo(db).getCalendarById(calendarId)
  if (!calendar?.subscriptionUrl) throw new Error(`Not a subscribed calendar: ${calendarId}`)
  const syncState = new SyncStateRepo(db)

  try {
    const ics = await fetchFeed(calendar.subscriptionUrl)
    const hash = contentHash(ics)
    let stored = 0
    if (hash === syncState.getSyncToken(calendarId)) {
      db.prepare('UPDATE calendars SET subscription_refreshed_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        calendarId
      )
    } else {
      stored = storeFeed(db, calendarId, ics)
      syncState.saveSyncToken(calendarId, hash)
    }
    syncState.recordSuccess(calendarId, stored)
    return stored
  } catch (err) {
    syncState.recordFailure(calendarId, err)
    throw err
  }
}

/** Refresh every subscription last fetched more than SUBSCRIPTION_REFRESH_MS
 *  ago. Run from the sync loop; one feed failing does not stop the rest. */
export async function refreshDueSubscriptions(
  db: ISqliteDatabase,
  nowMs = Date.now()
): Promise<{ pulledCount: number; errorCount: number }> {
  const due = new CalendarsRepo(db)
    .listCalendars()
    .filter(
      (c) =>
        c.subscriptionUrl &&
        (!c.subscriptionRefreshedAt || nowMs - Date.parse(c.subscriptionRefreshedAt) >= SUBSCRIPTION_REFRESH_MS)
    )

  let pulledCount = 0
  let errorCount = 0
  for (const calendar of due) {
    try {
      pulledCount += await refreshSubscription(db, calendar.id)
    } catch {
      // Recorded in sync_state by refreshSubscription. Not retried until it is
      // due again: a dead link should not be hit every poll.
      db.prepare('UPDATE calendars SET subscription_refreshed_at = ? WHERE id = ?').run(
        new Date(nowMs).toISOString(),
        calendar.id
      )
      errorCount++
    }
  }
  return { pulledCount, errorCount }
}
