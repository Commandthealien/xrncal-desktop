import type { Calendar, CalendarAccount } from '@shared/event-model'
import { HOLIDAY_CALENDAR_META } from '@shared/holiday-calendars'

/**
 * How accounts and calendars are presented: grouped the way OneCalendar does it,
 * one heading per account with its calendars underneath, so "which calendars do
 * I have and where do they come from" has one answer everywhere - the sidebar,
 * the accounts dialog and the add-account flow all read these helpers.
 */

/** What a group is, for its icon and label. `icloud` is a CalDAV account on Apple's server. */
export type ProviderKind = 'local' | 'google' | 'graph' | 'caldav' | 'icloud' | 'holidays'

export interface CalendarGroup {
  /** The account id, or `holidays` for the subscribed holiday calendars. */
  key: string
  kind: ProviderKind
  /** Absent only for the holidays group. */
  account?: CalendarAccount
  calendars: Calendar[]
}

/** The account seeded for calendars that live only on this computer. */
export const LOCAL_ACCOUNT_ID = 'account-local-primary'

const HOLIDAY_NAMES = new Set<string>(Object.values(HOLIDAY_CALENDAR_META).map((meta) => meta.name))

/** Holiday subscriptions are local calendars recognised by name, as HolidayCalendarToggle does. */
export function isHolidayCalendar(cal: Calendar): boolean {
  return HOLIDAY_NAMES.has(cal.name)
}

export function providerKind(account: CalendarAccount): ProviderKind {
  if (account.type === 'caldav' && /icloud/i.test(`${account.name} ${account.email ?? ''}`)) return 'icloud'
  return account.type
}

/** A remote account is one the sync worker talks to; it can be synced and removed. */
export function isRemoteAccount(account: CalendarAccount): boolean {
  return account.type !== 'local'
}

/**
 * Calendars grouped under their accounts: this computer first, then each
 * connected account in the order it was added, then holidays. Within a group
 * the default calendar leads and the rest are alphabetical. Every account gets
 * a group even with no calendars yet - the accounts dialog lists it while its
 * first sync runs; the sidebar skips empty groups itself.
 */
export function groupCalendars(accounts: CalendarAccount[], calendars: Calendar[]): CalendarGroup[] {
  const byAccount = new Map<string, Calendar[]>()
  const holidays: Calendar[] = []
  const known = new Set(accounts.map((a) => a.id))

  for (const cal of calendars) {
    if (isHolidayCalendar(cal)) {
      holidays.push(cal)
      continue
    }
    // A calendar whose account row is gone still has to show somewhere.
    const key = known.has(cal.accountId) ? cal.accountId : LOCAL_ACCOUNT_ID
    const list = byAccount.get(key) ?? []
    list.push(cal)
    byAccount.set(key, list)
  }

  const sortCalendars = (list: Calendar[]) =>
    [...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))

  const ordered = [...accounts].sort((a, b) => {
    if (a.type === 'local' && b.type !== 'local') return -1
    if (b.type === 'local' && a.type !== 'local') return 1
    return a.createdAt.localeCompare(b.createdAt)
  })

  const groups: CalendarGroup[] = ordered.map((account) => ({
    key: account.id,
    kind: providerKind(account),
    account,
    calendars: sortCalendars(byAccount.get(account.id) ?? [])
  }))

  // Calendars filed under the local account when it is not in `accounts` at all.
  const orphans = byAccount.get(LOCAL_ACCOUNT_ID)
  if (orphans && !known.has(LOCAL_ACCOUNT_ID)) {
    groups.unshift({ key: LOCAL_ACCOUNT_ID, kind: 'local', calendars: sortCalendars(orphans) })
  }

  if (holidays.length > 0) {
    groups.push({ key: 'holidays', kind: 'holidays', calendars: sortCalendars(holidays) })
  }
  return groups
}

/**
 * The visibility changes that leave only `calendarId` showing - the sidebar's
 * "Show only this". Only calendars whose state actually changes are returned,
 * so a press costs as many writes as it has to.
 */
export function showOnlyChanges(calendars: Calendar[], calendarId: string): { id: string; isVisible: boolean }[] {
  return calendars
    .filter((cal) => cal.isVisible !== (cal.id === calendarId))
    .map((cal) => ({ id: cal.id, isVisible: cal.id === calendarId }))
}

/** Everything hidden turned back on. */
export function showAllChanges(calendars: Calendar[]): { id: string; isVisible: boolean }[] {
  return calendars.filter((cal) => !cal.isVisible).map((cal) => ({ id: cal.id, isVisible: true }))
}

/** Why connecting failed, in terms the person at the keyboard can act on. */
export type ConnectProblem =
  | 'auth'
  | 'notFound'
  | 'unreachable'
  | 'certificate'
  | 'noCalendars'
  | 'keyring'
  | 'notConfigured'
  | 'cancelled'
  | 'unknown'

/**
 * Sort a connect failure into something to tell the user. The messages come
 * from the main process (fetch, the CalDAV adapter, the OAuth managers) and are
 * matched loosely on purpose: the raw text is still shown underneath, so an
 * unrecognised one degrades to "here is what the server said".
 */
export function classifyConnectError(message: string | undefined): ConnectProblem {
  const text = (message ?? '').toLowerCase()
  if (!text) return 'unknown'
  if (text.includes('no calendars found')) return 'noCalendars'
  if (text.includes("isn't configured") || text.includes('not configured')) return 'notConfigured'
  if (text.includes('keyring') || text.includes('safestorage') || text.includes('encryption is unavailable')) return 'keyring'
  if (/\b401\b/.test(text) || text.includes('unauthorized') || text.includes('invalid_grant') || text.includes('authentication failed')) return 'auth'
  if (text.includes('cancel') || text.includes('denied') || text.includes('access_denied')) return 'cancelled'
  if (text.includes('certificate') || text.includes('cert_') || text.includes('self-signed') || text.includes('self signed')) return 'certificate'
  if (text.includes('enotfound') || text.includes('getaddrinfo') || text.includes('could not resolve') || text.includes('invalid url')) return 'notFound'
  if (
    text.includes('econnrefused') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('fetch failed') ||
    text.includes('network') ||
    text.includes('econnreset') ||
    text.includes('ehostunreach')
  ) return 'unreachable'
  return 'unknown'
}

/** `https://` added when a bare host was typed - what the main process does too. */
export function normaliseServerInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** The host an address points at, or '' while it is not a URL yet - for the default account name. */
export function hostOf(raw: string): string {
  try {
    return new URL(normaliseServerInput(raw)).hostname
  } catch {
    return ''
  }
}
