import { DateTime } from 'luxon'
import { exclusiveEndToInclusive, inclusiveEndToExclusiveDate } from '@shared/all-day'
import type {
  Attendee,
  AttendeeResponseStatus,
  CalendarEvent,
  EventException,
  CreateEventInput
} from '@shared/event-model'
import { normalizeReminders, remindersForProvider, type EventReminder } from '@shared/reminders'
import { EVENT_COLORS } from '@shared/event-colors'

const GOOGLE_COLOR_MAP: Record<string, string> = Object.fromEntries(EVENT_COLORS.map((c) => [c.googleId, c.hex]))

interface GoogleEventDateTime {
  dateTime?: string
  date?: string
  timeZone?: string
}

/**
 * What we send to Google. The id is deliberately not part of this shape: on an
 * update it lives in the request URL, and on an insert Google assigns it. Typing
 * the write payload separately is what stops an id being put back by accident.
 */
type GoogleEventWritePayload = Omit<GoogleCalendarApiEvent, 'id'>

export interface GoogleCalendarApiEvent {
  id: string
  status?: string
  summary?: string
  description?: string
  location?: string
  start?: GoogleEventDateTime
  end?: GoogleEventDateTime
  recurrence?: string[]
  recurringEventId?: string
  originalStartTime?: GoogleEventDateTime
  colorId?: string
  etag?: string
  hangoutLink?: string
  conferenceData?: {
    entryPoints?: { entryPointType: string; uri: string }[]
  }
  extendedProperties?: {
    private?: Record<string, string>
  }
  reminders?: GoogleReminders
  attendees?: GoogleAttendee[]
}

export interface GoogleAttendee {
  email?: string
  displayName?: string
  responseStatus?: string
  organizer?: boolean
  /** Google marks the entry that is the calendar's own user. */
  self?: boolean
  /** A meeting room or other bookable resource. Read-only: Google works it
   *  out from the address, so a push only has to keep the entry. */
  resource?: boolean
  optional?: boolean
}

const GOOGLE_RESPONSES = new Set<AttendeeResponseStatus>(['accepted', 'declined', 'tentative', 'needsAction'])

export function googleAttendeesToDomain(attendees?: GoogleAttendee[]): Attendee[] {
  return (attendees || [])
    .filter((a) => a.email)
    .map((a) => ({
      email: a.email!,
      displayName: a.displayName || undefined,
      responseStatus: GOOGLE_RESPONSES.has(a.responseStatus as AttendeeResponseStatus)
        ? (a.responseStatus as AttendeeResponseStatus)
        : 'needsAction',
      isOrganizer: a.organizer === true,
      isSelf: a.self === true,
      // Rooms stay in the list: a PUT without one would cancel its booking.
      role: a.resource ? 'room' : a.optional ? 'optional' : undefined
    }))
}

/** Ours as Google's. Email, name, response and `optional` are writable;
 *  Google works out the organizer, `self` and rooms on its side. */
export function domainAttendeesToGoogle(attendees: readonly Attendee[]): GoogleAttendee[] {
  return attendees.map((a) => ({
    email: a.email,
    displayName: a.displayName,
    responseStatus: a.responseStatus || 'needsAction',
    ...(a.role === 'optional' ? { optional: true } : {})
  }))
}

interface GoogleReminderOverride {
  method?: string
  minutes?: number
}

/** `useDefault` means the calendar's defaultReminders apply. */
export interface GoogleReminders {
  useDefault?: boolean
  overrides?: GoogleReminderOverride[]
}

/** Google's `reminders` (or a calendar's `defaultReminders`) as ours; undefined
 *  when the calendar default applies. A missing field means the same thing. */
export function googleRemindersToDomain(reminders?: GoogleReminders): EventReminder[] | undefined {
  if (!reminders || reminders.useDefault !== false) return undefined
  return googleOverridesToDomain(reminders.overrides)
}

export function googleOverridesToDomain(overrides?: GoogleReminderOverride[]): EventReminder[] {
  return normalizeReminders(
    (overrides || [])
      .filter((o) => typeof o.minutes === 'number')
      .map((o): EventReminder =>
        o.method === 'email' ? { minutesBefore: o.minutes!, method: 'email' } : { minutesBefore: o.minutes! }
      )
  )
}

function domainRemindersToGoogle(reminders: EventReminder[] | null | undefined): GoogleReminders {
  if (!reminders) return { useDefault: true }
  return {
    useDefault: false,
    overrides: remindersForProvider('google', reminders).map((r) => ({
      method: r.method === 'email' ? 'email' : 'popup',
      minutes: r.minutesBefore
    }))
  }
}

/** Reverse of GOOGLE_COLOR_MAP, for pushing a local hex colour back as a colorId. */
const GOOGLE_COLOR_ID_BY_HEX: Record<string, string> = Object.fromEntries(
  Object.entries(GOOGLE_COLOR_MAP).map(([id, hex]) => [hex.toLowerCase(), id])
)

/**
 * Google exposes no writable field for an arbitrary meeting link - `hangoutLink`
 * and `conferenceData` are server-owned (conferenceData only accepts a Meet
 * create-request, not a URL). Private extended properties are the documented
 * per-client escape hatch and round-trip losslessly, so the link survives a
 * push/pull cycle instead of being dropped on the way out.
 */
const XRNCAL_MEETING_URL_PROP = 'xrncalMeetingUrl'

/** The same property under the app's former name. Events pushed before the
 *  rename still carry it, so pulls read it as a fallback; pushes never write it. */
const LEGACY_MEETING_URL_PROP = 'goneMeetingUrl'

/**
 * Format Google Event DateTime to ISO UTC and determine all-day status
 */
/**
 * All-day ends arrive exclusive from Google; the app stores them inclusive.
 * Timed events are unaffected.
 */
function normaliseEnd(
  startInfo: { iso: string; allDay: boolean },
  endInfo: { iso: string }
): string {
  return startInfo.allDay
    ? exclusiveEndToInclusive(startInfo.iso, endInfo.iso)
    : endInfo.iso
}

function parseGoogleDateTime(dt?: GoogleEventDateTime): {
  iso: string
  allDay: boolean
  tzid: string
} {
  if (!dt) {
    const now = DateTime.utc().toISO()!
    return { iso: now, allDay: false, tzid: 'UTC' }
  }

  if (dt.date) {
    // All-day event: YYYY-MM-DD
    const iso = `${dt.date}T00:00:00.000Z`
    return { iso, allDay: true, tzid: dt.timeZone || 'UTC' }
  }

  if (dt.dateTime) {
    const parsed = DateTime.fromISO(dt.dateTime, { setZone: true })
    const iso = parsed.toUTC().toISO() || dt.dateTime
    return { iso, allDay: false, tzid: dt.timeZone || parsed.zoneName || 'UTC' }
  }

  const now = DateTime.utc().toISO()!
  return { iso: now, allDay: false, tzid: 'UTC' }
}

/**
 * Map Google API event to Canonical CalendarEvent / EventException
 */
export function mapGoogleEventToDomain(
  gEvent: GoogleCalendarApiEvent,
  calendarId: string
): {
  isException: boolean
  event?: CreateEventInput & { id: string; etag?: string; isDeleted?: boolean }
  exception?: Omit<EventException, 'id' | 'createdAt' | 'updatedAt'> & { etag?: string }
} {
  const startInfo = parseGoogleDateTime(gEvent.start)
  const endInfo = parseGoogleDateTime(gEvent.end)

  const color = gEvent.colorId ? GOOGLE_COLOR_MAP[gEvent.colorId] : undefined

  let meetingUrl = gEvent.hangoutLink
  if (!meetingUrl && gEvent.conferenceData?.entryPoints) {
    const videoEntry = gEvent.conferenceData.entryPoints.find(
      (ep) => ep.entryPointType === 'video' || ep.entryPointType === 'web'
    )
    if (videoEntry) meetingUrl = videoEntry.uri
  }
  // A link we pushed ourselves comes back here rather than as a real conference.
  if (!meetingUrl) meetingUrl = gEvent.extendedProperties?.private?.[XRNCAL_MEETING_URL_PROP]
  if (!meetingUrl) meetingUrl = gEvent.extendedProperties?.private?.[LEGACY_MEETING_URL_PROP]

  const isCancelled = gEvent.status === 'cancelled'

  // If recurringEventId is present, this item is an exception / occurrence override
  if (gEvent.recurringEventId && gEvent.originalStartTime) {
    const origStartInfo = parseGoogleDateTime(gEvent.originalStartTime)

    return {
      isException: true,
      exception: {
        masterEventId: gEvent.recurringEventId,
        originalStartUtc: origStartInfo.iso,
        isCancelled,
        title: gEvent.summary || 'Untitled Event',
        notes: gEvent.description || undefined,
        location: gEvent.location || undefined,
        dtStartUtc: startInfo.iso,
        dtEndUtc: normaliseEnd(startInfo, endInfo),
        tzid: startInfo.tzid,
        // An occurrence can be timed while its series is all-day (and back).
        allDay: startInfo.allDay,
        color
      }
    }
  }

  // Master event
  let rruleString: string | undefined
  if (gEvent.recurrence && gEvent.recurrence.length > 0) {
    for (const rule of gEvent.recurrence) {
      if (rule.startsWith('RRULE:')) {
        rruleString = rule.substring(6)
      } else if (!rule.startsWith('EXDATE:') && !rule.startsWith('RDATE:')) {
        rruleString = rule
      }
    }
  }

  return {
    isException: false,
    event: {
      id: gEvent.id,
      calendarId,
      uid: `${gEvent.id}@google.com`,
      title: gEvent.summary || 'Untitled Event',
      notes: gEvent.description || undefined,
      location: gEvent.location || undefined,
      dtStartUtc: startInfo.iso,
      dtEndUtc: normaliseEnd(startInfo, endInfo),
      tzid: startInfo.tzid,
      allDay: startInfo.allDay,
      rrule: rruleString,
      color,
      meetingUrl,
      reminders: googleRemindersToDomain(gEvent.reminders),
      attendees: googleAttendeesToDomain(gEvent.attendees),
      etag: gEvent.etag,
      isDeleted: isCancelled
    }
  }
}

/**
 * Map Canonical Domain Event to Google Calendar API v3 format for push
 */
/**
 * `event.attendees` must be the complete guest list, or left undefined when
 * it is not known: an update is a PUT, which replaces the whole resource, so a
 * list that is merely empty here removes every guest on Google.
 */
export function mapDomainEventToGoogle(
  event: CalendarEvent | (CreateEventInput & { id?: string })
): GoogleEventWritePayload {
  const isAllDay = Boolean(event.allDay)
  let start: GoogleEventDateTime
  let end: GoogleEventDateTime

  if (isAllDay) {
    start = { date: event.dtStartUtc.split('T')[0] }
    // Google wants the exclusive end date back.
    end = { date: inclusiveEndToExclusiveDate(event.dtStartUtc, event.dtEndUtc) }
  } else {
    start = {
      dateTime: event.dtStartUtc,
      timeZone: event.tzid || 'UTC'
    }
    end = {
      dateTime: event.dtEndUtc,
      timeZone: event.tzid || 'UTC'
    }
  }

  const gEvent: GoogleEventWritePayload = {
    // No `id`. On an update the id is in the request URL, so sending it again is
    // redundant; on an insert it is actively harmful. Google only accepts
    // base32hex ids - lowercase a-v and digits - and ours look like
    // `evt_1789396326299_uqqwff`, so every insert came back 400 and no event
    // created here ever reached Google. Let the provider assign the id; the
    // engine already re-keys the local row when the response id differs.
    summary: event.title,
    description: event.notes || undefined,
    location: event.location || undefined,
    start,
    end,
    // Always sent: an update is a PUT, which replaces the whole resource, so
    // leaving this out would reset the event's reminders on Google.
    reminders: domainRemindersToGoogle(event.reminders)
  }

  if (event.rrule) {
    gEvent.recurrence = [`RRULE:${event.rrule}`]
  }
  if (event.attendees) {
    gEvent.attendees = domainAttendeesToGoogle(event.attendees)
  }

  const hex = event.color?.toLowerCase()
  if (hex && GOOGLE_COLOR_ID_BY_HEX[hex]) {
    gEvent.colorId = GOOGLE_COLOR_ID_BY_HEX[hex]
  }
  if (event.meetingUrl) {
    gEvent.extendedProperties = {
      private: { [XRNCAL_MEETING_URL_PROP]: event.meetingUrl }
    }
  }

  if ((event as CalendarEvent).etag) {
    gEvent.etag = (event as CalendarEvent).etag
  }

  return gEvent
}
