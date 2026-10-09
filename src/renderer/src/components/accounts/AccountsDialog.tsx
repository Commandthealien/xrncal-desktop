import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, X } from 'lucide-react'
import type { Calendar, CalendarAccount } from '@shared/event-model'
import { LOCAL_ACCOUNT_ID } from '../../lib/account-display'
import type { AccountsPageProps, AccountsView } from './accounts-nav'
import { AccountDetailView, AccountListView, NewLocalCalendarView, RemoveAccountView } from './AccountViews'
import { ChooseCalendarsView, ConnectView, HolidaysView, ProviderPickView } from './AddAccountViews'

interface AccountsDialogProps {
  isOpen: boolean
  /** The pages to open on: just the list, an account's page, or straight into adding one. */
  start: AccountsView[]
  accounts: CalendarAccount[]
  calendars: Calendar[]
  onClose: () => void
  /** Reload accounts and calendars in App. */
  onRefresh: () => Promise<void>
  onToggleVisibility: (cal: Calendar) => void
  onChangeColor: (cal: Calendar, hex: string) => void
}

/**
 * Accounts and calendars in one place, replacing the old account modal (three
 * "Connect …" buttons and a list of letter avatars) and the CalDAV form it
 * stacked on top of itself. Modelled on OneCalendar's flow: a list of accounts,
 * one page per account, and adding as a few short steps.
 *
 * It owns Escape: one press steps back a page, the last one closes. App leaves
 * Escape to it (see `ownsEscape` there) so a press never closes two layers.
 */
export const AccountsDialog: React.FC<AccountsDialogProps> = (props) => {
  const { t } = useTranslation()
  const [stack, setStack] = useState<AccountsView[]>(props.start)
  const { isOpen, start, onClose } = props

  // Each opening starts where it was asked to, not where the last one ended.
  useEffect(() => {
    if (isOpen) setStack(start)
  }, [isOpen, start])

  const back = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
    if (stack.length <= 1) onClose()
  }, [stack.length, onClose])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, back])

  if (!isOpen) return null
  const view = stack[stack.length - 1] ?? { name: 'list' }

  const page: AccountsPageProps = {
    accounts: props.accounts,
    calendars: props.calendars,
    push: (v) => setStack((s) => [...s, v]),
    reset: (views) => setStack(views),
    back,
    close: onClose,
    refresh: props.onRefresh,
    onToggleVisibility: props.onToggleVisibility,
    onChangeColor: props.onChangeColor
  }

  const title =
    view.name === 'list'
      ? t('accounts.title')
      : view.name === 'account'
        ? // The page itself leads with the account's name; the header says what page this is.
          view.accountId === LOCAL_ACCOUNT_ID
          ? t('calendarList.thisComputer')
          : t('accounts.account')
        : view.name === 'remove'
          ? t('accounts.removeTitle')
          : view.name === 'add'
            ? t('addAccount.title')
            : view.name === 'connect'
              ? t(`addAccount.providers.${view.provider}.title`)
              : view.name === 'local'
                ? t('addAccount.providers.local.action')
                : view.name === 'holidays'
                  ? t('holidays.title')
                  : t('addAccount.allSet')

  return (
    <div className="gc-overlay select-none" onMouseDown={onClose}>
      <div
        className="gc-dialog flex max-h-[85vh] w-full max-w-lg flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-2.5">
          {stack.length > 1 && (
            <button type="button" className="gc-icon-btn" onClick={back} aria-label={t('common.back')}>
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          <h3 className={`flex-1 truncate text-sm font-semibold text-primary ${stack.length > 1 ? '' : 'px-2'}`}>{title}</h3>
          <button type="button" className="gc-icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {view.name === 'list' && <AccountListView {...page} />}
          {view.name === 'account' && <AccountDetailView {...page} accountId={view.accountId} />}
          {view.name === 'remove' && <RemoveAccountView {...page} accountId={view.accountId} />}
          {view.name === 'add' && <ProviderPickView {...page} />}
          {view.name === 'connect' && <ConnectView key={view.provider} {...page} provider={view.provider} />}
          {view.name === 'local' && <NewLocalCalendarView {...page} />}
          {view.name === 'holidays' && <HolidaysView {...page} />}
          {view.name === 'choose' && <ChooseCalendarsView {...page} accountId={view.accountId} />}
        </div>
      </div>
    </div>
  )
}

export default AccountsDialog
