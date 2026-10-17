/**
 * Canonical Calendar, Event, Recurrence, and Sync Domain Models
 */

import type { EventReminder } from './reminders'

export type { EventReminder }

type AccountType = 'local' | 'google' | 'graph' | 'caldav'

export interface CalendarAccount {
  id: string
  type: AccountType
  name: string
  email?: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface Calendar {
  id: string
  accountId: string
  name: string
  color: string
  isVisible: boolean
  isReadOnly: boolean
  isDefault: boolean
  /** True once the user has picked this calendar's colour themselves; provider
   *  syncs then stop overwriting it. */
  colorIsCustom?: boolean
  /** Reminders a timed event in this calendar gets when it names none of its
   *  own. Only Google publishes one; undefined everywhere else. */
  defaultReminders?: EventReminder[]
  /** The .ics feed a subscribed calendar is refreshed from (read-only, local). */
  subscriptionUrl?: string
  subscriptionRefreshedAt?: string
  syncToken?: string
  createdAt: string
  updatedAt: string
}

export type AttendeeResponseStatus = 'accepted' | 'declined' | 'tentative' | 'needsAction'

/** The answers a guest can give an invitation. */
export type RsvpResponse = 'accepted' | 'tentative' | 'declined'

export interface Attendee {
  email: string
  displayName?: string
  responseStatus?: AttendeeResponseStatus
  isOrganizer?: boolean
  /** This attendee is the account's own user. Only set by a provider pull. */
  isSelf?: boolean
  /** Unset for a required guest. Kept so a push sends the guest back as what
   *  they were: a list without the room would cancel its booking. */
  role?: AttendeeRole
}

/** 'room' and 'resource' are booked, not invited: a meeting room, or other
 *  equipment (iCalendar's CUTYPE). Google and Graph call both a resource. */
export type AttendeeRole = 'optional' | 'room' | 'resource'

/** Flag the account's own entry in a guest list a provider sent. Addresses
 *  are compared without case; `selfEmail` may be absent (no known address). */
export function markSelfAttendee(attendees: Attendee[], selfEmail: string | undefined): Attendee[] {
  const self = selfEmail?.trim().toLowerCase()
  if (!self) return attendees
  return attendees.map((a) => (a.email.toLowerCase() === self ? { ...a, isSelf: true } : a))
}

/** The account's own attendee entry when the event is an invitation from
 *  someone else - the case where there is something to reply to. */
export function invitationSelf(attendees: readonly Attendee[] | undefined): Attendee | undefined {
  const self = attendees?.find((a) => a.isSelf)
  return self && !self.isOrganizer ? self : undefined
}

/**
 * Compact spec for an anniversary that repeats on the same Vietnamese lunar
 * (âm lịch) date every year — e.g. a death anniversary (giỗ). Stored as JSON in
 * the `lunar_rule` column. An event carrying this never has an `rrule`; the
 * occurrence expander resolves one all-day instance per Gregorian year.
 */
export interface LunarRecurrenceSpec {
  day: number   // lunar day of month, 1-30
  month: number // lunar month, 1-12
  leap: boolean // true if the anniversary falls in a leap month
}

export interface CalendarEvent {
  /** The id the provider knows this event by. Absent until the event has been
   *  pushed once; `id` is ours and never changes. */
  providerEventId?: string
  id: string
  calendarId: string
  uid: string
  title: string
  notes?: string
  location?: string
  dtStartUtc: string // ISO 8601 UTC string (e.g. 2026-08-18T10:00:00.000Z) or YYYY-MM-DD for allDay
  dtEndUtc: string   // ISO 8601 UTC string or YYYY-MM-DD for allDay
  tzid: string       // e.g. "Asia/Ho_Chi_Minh", "UTC"
  allDay: boolean
  rrule?: string     // RFC 5545 RRULE string e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR"
  rdate?: string     // Comma-separated ISO strings
  exdate?: string    // Comma-separated ISO strings
  lunarRule?: LunarRecurrenceSpec       // Yearly lunar-date recurrence (mutually exclusive with rrule)
  lunarSourceEventId?: string           // Set on a materialized instance: the lunar master it came from
  color?: string     // Hex or theme color override
  meetingUrl?: string
  attendees?: Attendee[]
  /** Undefined: the default applies (see effectiveReminders). `[]`: none. */
  reminders?: EventReminder[]
  etag?: string
  dirty: boolean
  /** A push to the provider hit a 412 (someone else changed it first) - unresolved until the user picks a side. */
  hasConflict?: boolean
  isDeleted: boolean
  createdAt: string
  updatedAt: string
}

/** One unresolved sync conflict, ready to show in a resolution list. */
export interface SyncConflict {
  eventId: string
  calendarId: string
  calendarName: string
  title: string
  updatedAt: string
}

export interface EventException {
  id: string
  masterEventId: string
  originalStartUtc: string // ISO 8601 UTC matching the occurrence instance start
  isCancelled: boolean
  title?: string
  notes?: string
  location?: string
  dtStartUtc?: string
  dtEndUtc?: string
  tzid?: string
  /** Overrides the master's all-day flag for this occurrence only; undefined inherits it. */
  allDay?: boolean
  color?: string
  createdAt: string
  updatedAt: string
}

export interface ExpandedOccurrence {
  id: string               // Unique ID: `${eventId}_${originalStartUtc}`
  eventId: string          // Master event ID
  calendarId: string
  title: string
  notes?: string
  location?: string
  startUtc: string         // Effective start time in UTC ISO
  endUtc: string           // Effective end time in UTC ISO
  tzid: string
  allDay: boolean
  color?: string
  meetingUrl?: string
  isRecurring: boolean
  isException: boolean
  isLunar?: boolean        // True when produced by a yearly lunar-date master
  originalStartUtc: string // Original recurrence start in UTC ISO
}

export interface CreateEventInput {
  calendarId: string
  title: string
  notes?: string
  location?: string
  dtStartUtc: string
  dtEndUtc: string
  tzid?: string
  allDay?: boolean
  rrule?: string
  exdate?: string
  lunarRule?: LunarRecurrenceSpec | null
  lunarSourceEventId?: string
  color?: string
  meetingUrl?: string
  attendees?: Attendee[]
  /** Omitted or null: the default applies. */
  reminders?: EventReminder[] | null
  uid?: string
}

export interface UpdateEventInput {
  /** Move the event to another calendar. Omitted leaves it where it is. */
  calendarId?: string
  title?: string
  notes?: string
  location?: string
  dtStartUtc?: string
  dtEndUtc?: string
  tzid?: string
  allDay?: boolean
  rrule?: string
  exdate?: string
  lunarRule?: LunarRecurrenceSpec | null
  color?: string
  meetingUrl?: string
  attendees?: Attendee[]
  /** Omitted: unchanged. null: back to the default. */
  reminders?: EventReminder[] | null
  isDeleted?: boolean
}

export interface MaterializeLunarInput {
  masterEventId: string
  targetCalendarId: string
  throughYear: number
}

export interface DetachLunarInput {
  masterEventId: string
}

export type RecurringEditScope = 'this' | 'future' | 'all'

export interface MoveEventInput {
  eventId: string
  dtStartUtc: string
  dtEndUtc: string
  targetCalendarId?: string
  /** Set when the move also changes all-day-ness (dropping onto the time grid). */
  allDay?: boolean
}

export interface CopyEventInput {
  sourceEventId: string
  dtStartUtc: string
  dtEndUtc: string
  targetCalendarId?: string
  copyInstanceOnly?: boolean
  /** Override the source's all-day-ness - set when an all-day event is
   *  alt-dragged onto the hourly grid. Omitted keeps the source's. */
  allDay?: boolean
  /** Keep only the title and the calendar. Drag-copy makes a fresh event rather
   *  than a duplicate carrying the original's notes, location and meeting link. */
  bare?: boolean
}

export interface UpdateRecurringScopeInput {
  masterEventId: string
  originalStartUtc: string
  scope: RecurringEditScope
  updateInput: UpdateEventInput
}

export interface DeleteRecurringScopeInput {
  masterEventId: string
  originalStartUtc: string
  scope: RecurringEditScope
}

export interface SyncStatus {
  lastSyncTime?: string
  isSyncing: boolean
  lastError?: string
  pendingPushesCount: number
  connectedAccounts: CalendarAccount[]
  /** Accounts whose last sync failed, by account id: the error as one line. */
  accountErrors?: Record<string, string>
}

export interface SyncResult {
  success: boolean
  pulledCount: number
  pushedCount: number
  errorCount: number
  message?: string
  /** Accounts that could not be synced this round, by account id. */
  accountErrors?: Record<string, string>
}
