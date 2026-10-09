import type { Calendar, CalendarAccount } from '@shared/event-model'

/** What can be added from the provider list. `graph` is Microsoft, as in `AccountType`. */
export type AddableProvider = 'google' | 'graph' | 'icloud' | 'caldav' | 'holidays' | 'local'

/**
 * One page of the accounts dialog. The dialog keeps a stack of these, so Back
 * and Escape step out one page at a time - the way OneCalendar walks Accounts →
 * Account type → Details → Configure.
 */
export type AccountsView =
  | { name: 'list' }
  | { name: 'account'; accountId: string }
  | { name: 'remove'; accountId: string }
  | { name: 'add' }
  | { name: 'connect'; provider: 'google' | 'graph' | 'icloud' | 'caldav' }
  | { name: 'local' }
  | { name: 'holidays' }
  | { name: 'choose'; accountId: string }

/** What every page gets: the data, and the ways to move and to change things. */
export interface AccountsPageProps {
  accounts: CalendarAccount[]
  calendars: Calendar[]
  push: (view: AccountsView) => void
  /** Replace the whole stack - e.g. "Add another account" after a connect. */
  reset: (views: AccountsView[]) => void
  back: () => void
  close: () => void
  /** Reload accounts and calendars in App; resolves once they are fresh. */
  refresh: () => Promise<void>
  onToggleVisibility: (cal: Calendar) => void
  onChangeColor: (cal: Calendar, hex: string) => void
}
