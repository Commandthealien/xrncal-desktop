import { DateTime } from 'luxon'
import { inclusiveEndToExclusiveDate } from '@shared/all-day'
import type { Attendee, Calendar, CalendarEvent, EventException } from '@shared/event-model'
import { remindersForProvider, type EventReminder } from '@shared/reminders'

function formatIcsDateTime(isoUtc: string, isAllDay: boolean): string {
  const dt = DateTime.fromISO(isoUtc, { zone: 'utc' })
  if (isAllDay) {
    return dt.toFormat('yyyyMMdd')
  }
  return dt.toFormat("yyyyMMdd'T'HHmmss'Z'")
}

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

/** `-P1DT15H` for 2340 minutes before; `PT0S` for the start itself. */
function formatTriggerDuration(minutesBefore: number): string {
  if (minutesBefore <= 0) return 'PT0S'
  const days = Math.floor(minutesBefore / 1440)
  const hours = Math.floor((minutesBefore % 1440) / 60)
  const minutes = minutesBefore % 60
  const time = `${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}`
  return `-P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`
}

/**
 * One DISPLAY alarm per reminder. Email alarms need an address to send to,
 * which this app does not have, so they stay local (see remindersForProvider).
 * An override component gets the same alarms: in iCalendar it does not inherit
 * them from the series, so without this a moved occurrence would ring nowhere.
 */
function pushAlarmLines(lines: string[], reminders: EventReminder[] | undefined, title: string): void {
  if (!reminders) return
  for (const r of remindersForProvider('caldav', reminders)) {
    lines.push('BEGIN:VALARM')
    lines.push('ACTION:DISPLAY')
    lines.push(`DESCRIPTION:${escapeIcsText(title)}`)
    lines.push(`TRIGGER:${formatTriggerDuration(r.minutesBefore)}`)
    lines.push('END:VALARM')
  }
}

const PARTSTAT: Record<NonNullable<Attendee['responseStatus']>, string> = {
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  tentative: 'TENTATIVE',
  needsAction: 'NEEDS-ACTION'
}

/** A quoted parameter value; RFC 5545 has no escape for a double quote. */
function paramValue(text: string): string {
  return `"${text.replace(/"/g, "'")}"`
}

/**
 * ORGANIZER and ATTENDEE lines. A CalDAV push replaces the whole resource, so
 * leaving these out deleted the guest list on the server - and a guest's reply
 * travels as their own PARTSTAT here, for the server to pass on.
 */
function pushAttendeeLines(lines: string[], attendees: Attendee[] | undefined): void {
  if (!attendees || attendees.length === 0) return
  const organizer = attendees.find((a) => a.isOrganizer)
  if (organizer) {
    const cn = organizer.displayName ? `;CN=${paramValue(organizer.displayName)}` : ''
    lines.push(`ORGANIZER${cn}:mailto:${organizer.email}`)
  }
  for (const a of attendees) {
    const cn = a.displayName ? `;CN=${paramValue(a.displayName)}` : ''
    const role =
      a.role === 'room'
        ? ';CUTYPE=ROOM'
        : a.role === 'resource'
          ? ';CUTYPE=RESOURCE'
          : a.role === 'optional'
            ? ';ROLE=OPT-PARTICIPANT'
            : ''
    lines.push(`ATTENDEE${cn}${role};PARTSTAT=${PARTSTAT[a.responseStatus || 'needsAction']}:mailto:${a.email}`)
  }
}

/**
 * Generate RFC 5545 iCalendar (.ics) string for a calendar and its events
 */
export function generateIcs(
  calendar: Calendar,
  events: CalendarEvent[],
  exceptions: EventException[] = []
): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//xrncal//xrncal Desktop//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendar.name)}`
  ]

  const exceptionsByMaster = new Map<string, EventException[]>()
  for (const ex of exceptions) {
    const list = exceptionsByMaster.get(ex.masterEventId) || []
    list.push(ex)
    exceptionsByMaster.set(ex.masterEventId, list)
  }

  for (const event of events) {
    if (event.isDeleted) continue

    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${event.uid}`)
    lines.push(`DTSTAMP:${DateTime.utc().toFormat("yyyyMMdd'T'HHmmss'Z'")}`)

    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatIcsDateTime(event.dtStartUtc, true)}`)
      // DTEND is exclusive for DATE values per RFC 5545.
      lines.push(
        `DTEND;VALUE=DATE:${inclusiveEndToExclusiveDate(event.dtStartUtc, event.dtEndUtc).replace(/-/g, '')}`
      )
    } else {
      lines.push(`DTSTART:${formatIcsDateTime(event.dtStartUtc, false)}`)
      lines.push(`DTEND:${formatIcsDateTime(event.dtEndUtc, false)}`)
    }

    lines.push(`SUMMARY:${escapeIcsText(event.title)}`)
    if (event.notes) {
      lines.push(`DESCRIPTION:${escapeIcsText(event.notes)}`)
    }
    if (event.location) {
      lines.push(`LOCATION:${escapeIcsText(event.location)}`)
    }
    // URL and COLOR are both RFC-defined (5545 / 7986) and round-trip through
    // CalDAV servers, so a meeting link or per-event colour survives a push.
    if (event.meetingUrl) {
      lines.push(`URL:${escapeIcsText(event.meetingUrl)}`)
    }
    if (event.color) {
      lines.push(`COLOR:${escapeIcsText(event.color)}`)
    }
    if (event.rrule) {
      lines.push(`RRULE:${event.rrule}`)
    }
    if (event.exdate) {
      const formattedExdates = event.exdate
        .split(',')
        .map((d) => formatIcsDateTime(d.trim(), event.allDay))
        .join(',')
      lines.push(
        event.allDay ? `EXDATE;VALUE=DATE:${formattedExdates}` : `EXDATE:${formattedExdates}`
      )
    }
    pushAttendeeLines(lines, event.attendees)
    pushAlarmLines(lines, event.reminders, event.title)

    lines.push('END:VEVENT')

    // Append recurrence exceptions (RECURRENCE-ID)
    const eventExceptions = exceptionsByMaster.get(event.id) || []
    for (const ex of eventExceptions) {
      lines.push('BEGIN:VEVENT')
      lines.push(`UID:${event.uid}`)
      lines.push(`DTSTAMP:${DateTime.utc().toFormat("yyyyMMdd'T'HHmmss'Z'")}`)

      const recIdFormatted = formatIcsDateTime(ex.originalStartUtc, event.allDay)
      lines.push(
        event.allDay ? `RECURRENCE-ID;VALUE=DATE:${recIdFormatted}` : `RECURRENCE-ID:${recIdFormatted}`
      )

      if (ex.isCancelled) {
        lines.push('STATUS:CANCELLED')
      } else {
        const startIso = ex.dtStartUtc || ex.originalStartUtc
        const endIso = ex.dtEndUtc || startIso
        if (event.allDay) {
          lines.push(`DTSTART;VALUE=DATE:${formatIcsDateTime(startIso, true)}`)
          lines.push(
            `DTEND;VALUE=DATE:${inclusiveEndToExclusiveDate(startIso, endIso).replace(/-/g, '')}`
          )
        } else {
          lines.push(`DTSTART:${formatIcsDateTime(startIso, false)}`)
          lines.push(`DTEND:${formatIcsDateTime(endIso, false)}`)
        }

        lines.push(`SUMMARY:${escapeIcsText(ex.title || event.title)}`)
        if (ex.notes || event.notes) {
          lines.push(`DESCRIPTION:${escapeIcsText(ex.notes || event.notes || '')}`)
        }
        if (ex.location || event.location) {
          lines.push(`LOCATION:${escapeIcsText(ex.location || event.location || '')}`)
        }
        pushAttendeeLines(lines, event.attendees)
        pushAlarmLines(lines, event.reminders, ex.title || event.title)
      }

      lines.push('END:VEVENT')
    }
  }

  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}
