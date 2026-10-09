import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DateTime } from 'luxon'
import { AlertTriangle, ChevronRight, Loader2, Palette, Plus, RotateCw, Trash2 } from 'lucide-react'
import type { Calendar, SyncStatus } from '@shared/event-model'
import { CALENDAR_COLOR_PALETTE } from '../../lib/calendar-colors'
import {
  groupCalendars,
  isRemoteAccount,
  LOCAL_ACCOUNT_ID,
  providerKind,
  type CalendarGroup
} from '../../lib/account-display'
import { TextInput, toast, showFriendlyError } from '../ui'
import { CalendarRow, ColorPalette } from './CalendarToggle'
import ProviderMark from './ProviderMark'
import type { AccountsPageProps } from './accounts-nav'

/** The provider's name, e.g. "Google" - used in subtitles and the remove wording. */
function useProviderLabel() {
  const { t } = useTranslation()
  return (kind: CalendarGroup['kind']) =>
    kind === 'local' ? t('calendarList.thisComputer') : t(`addAccount.providers.${kind}.title`)
}

/** A row that leads somewhere: icon, two lines, chevron. Shared with the provider picker. */
export const NavRow: React.FC<{
  icon: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  onClick: () => void
  trailing?: React.ReactNode
}> = ({ icon, title, subtitle, onClick, trailing }) => (
  <button
    type="button"
    onClick={onClick}
    className="gc-focus-ring flex w-full items-center gap-3 px-2.5 py-2.5 text-left transition-colors hover:bg-hover"
    style={{ borderRadius: 'var(--radius-control)' }}
  >
    {icon}
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm text-primary">{title}</span>
      {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
    </span>
    {trailing}
    <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
  </button>
)

/* ------------------------------------------------------------------ list */

export const AccountListView: React.FC<AccountsPageProps> = (props) => {
  const { t } = useTranslation()
  const label = useProviderLabel()
  const groups = groupCalendars(props.accounts, props.calendars)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        {groups.map((group) => {
          const count = t('accounts.calendarCount', { count: group.calendars.length })
          if (group.kind === 'holidays') {
            return (
              <NavRow
                key={group.key}
                icon={<ProviderMark kind="holidays" />}
                title={t('holidays.title')}
                subtitle={count}
                onClick={() => props.push({ name: 'holidays' })}
              />
            )
          }
          const account = group.account
          const inactive = account && isRemoteAccount(account) && !account.isActive
          return (
            <NavRow
              key={group.key}
              icon={<ProviderMark kind={group.kind} />}
              title={group.kind === 'local' ? t('calendarList.thisComputer') : account?.name}
              subtitle={
                inactive ? (
                  <span className="text-today">{t('accounts.notSyncing')}</span>
                ) : group.kind === 'local' ? (
                  `${t('accounts.localDetail')} · ${count}`
                ) : (
                  [label(group.kind), account?.email, count].filter(Boolean).join(' · ')
                )
              }
              onClick={() => props.push({ name: 'account', accountId: group.key })}
            />
          )
        })}
      </div>

      <button type="button" className="gc-btn-primary justify-center" onClick={() => props.push({ name: 'add' })}>
        <Plus className="h-4 w-4" />
        {t('addAccount.title')}
      </button>

      <SyncFooter refresh={props.refresh} />
    </div>
  )
}

/** Last sync, what is waiting, and Sync now - for all accounts at once, as the worker syncs them together. */
const SyncFooter: React.FC<{ refresh: () => Promise<void> }> = ({ refresh }) => {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus((await window.xrncal?.sync?.getStatus()) ?? null)
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const syncNow = async () => {
    if (!window.xrncal?.sync) return
    setBusy(true)
    try {
      const res = await window.xrncal.sync.triggerNow()
      await refresh()
      if (!res.success && res.message) toast.error(t('accounts.syncFailed'), { description: res.message })
    } catch (err) {
      showFriendlyError(err, t('accounts.syncFailed'))
    } finally {
      setBusy(false)
      void load()
    }
  }

  const when = status?.lastSyncTime
    ? DateTime.fromISO(status.lastSyncTime).toRelative({ locale: i18n.language }) ?? ''
    : null
  const remotes = status?.connectedAccounts?.length ?? 0

  return (
    <div
      className="flex items-center gap-3 border border-hairline px-3 py-2.5"
      style={{ borderRadius: 'var(--radius-control)' }}
    >
      <div className="min-w-0 flex-1 text-xs">
        <div className="text-primary">
          {remotes === 0 ? t('accounts.nothingToSync') : when ? t('accounts.lastSynced', { when }) : t('accounts.neverSynced')}
        </div>
        {status?.lastError && <div className="truncate text-today" title={status.lastError}>{t('accounts.lastSyncFailed')}</div>}
        {!!status?.pendingPushesCount && (
          <div className="text-muted">{t('accounts.waiting', { count: status.pendingPushesCount })}</div>
        )}
      </div>
      {remotes > 0 && (
        <button type="button" className="gc-btn shrink-0" onClick={syncNow} disabled={busy}>
          <RotateCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          {busy ? t('accounts.syncing') : t('accounts.syncNow')}
        </button>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- account */

export const AccountDetailView: React.FC<AccountsPageProps & { accountId: string }> = (props) => {
  const { t } = useTranslation()
  const label = useProviderLabel()
  const [paletteFor, setPaletteFor] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const account = props.accounts.find((a) => a.id === props.accountId)
  const group = groupCalendars(props.accounts, props.calendars).find((g) => g.key === props.accountId)
  const calendars = group?.calendars ?? []
  const isLocal = props.accountId === LOCAL_ACCOUNT_ID || account?.type === 'local'
  const kind = account ? providerKind(account) : 'local'

  const syncNow = async () => {
    setSyncing(true)
    try {
      await window.xrncal?.sync?.triggerNow()
      await props.refresh()
    } catch (err) {
      showFriendlyError(err, t('accounts.syncFailed'))
    } finally {
      setSyncing(false)
    }
  }

  const deleteCalendar = async (cal: Calendar) => {
    try {
      await window.xrncal?.calendars?.delete(cal.id)
      setDeleting(null)
      await props.refresh()
      toast.success(t('accounts.calendarDeleted'), { description: cal.name })
    } catch (err) {
      showFriendlyError(err, t('accounts.calendarDeleteFailed'))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <ProviderMark kind={kind} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-primary">
            {isLocal ? t('calendarList.thisComputer') : account?.name}
          </div>
          <div className="truncate text-xs text-muted">
            {isLocal ? t('accounts.localDetail') : [label(kind), account?.email].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>

      {account && isRemoteAccount(account) && !account.isActive && (
        <div
          className="flex gap-2 border border-today/40 px-3 py-2 text-xs text-primary"
          style={{ borderRadius: 'var(--radius-control)' }}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-today" />
          <span>{t('accounts.notSyncingDetail')}</span>
        </div>
      )}

      <div>
        <div className="mb-1 px-2 text-[11px] font-medium text-muted">{t('calendarList.title')}</div>
        {calendars.length === 0 && (
          <div className="px-2 py-2 text-xs text-muted">{t('accounts.noCalendarsYet')}</div>
        )}
        {calendars.map((cal) => (
          <div key={cal.id}>
            <CalendarRow
              calendar={cal}
              onToggle={() => props.onToggleVisibility(cal)}
              trailing={
                <span className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    className="gc-icon-btn h-6 w-6"
                    title={t('calendarList.color')}
                    aria-label={t('calendarList.color')}
                    aria-expanded={paletteFor === cal.id}
                    onClick={() => setPaletteFor(paletteFor === cal.id ? null : cal.id)}
                  >
                    <Palette className="h-3.5 w-3.5" />
                  </button>
                  {isLocal && !cal.isDefault && (
                    <button
                      type="button"
                      className="gc-icon-btn h-6 w-6 hover:text-today"
                      title={t('accounts.deleteCalendar')}
                      aria-label={t('accounts.deleteCalendar')}
                      onClick={() => setDeleting(deleting === cal.id ? null : cal.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              }
            />
            {paletteFor === cal.id && (
              <ColorPalette
                calendar={cal}
                calendars={props.calendars}
                onPick={(hex) => {
                  props.onChangeColor(cal, hex)
                  setPaletteFor(null)
                }}
              />
            )}
            {deleting === cal.id && (
              <div
                className="mx-2 mb-2 flex items-center gap-2 border border-today/40 px-3 py-2 text-xs"
                style={{ borderRadius: 'var(--radius-control)' }}
              >
                <span className="flex-1 text-primary">{t('accounts.deleteCalendarConfirm', { name: cal.name })}</span>
                <button type="button" className="gc-btn" onClick={() => setDeleting(null)}>
                  {t('common.cancel')}
                </button>
                <button type="button" className="gc-btn text-today" onClick={() => deleteCalendar(cal)}>
                  {t('common.delete')}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {isLocal ? (
        <button type="button" className="gc-btn justify-center" onClick={() => props.push({ name: 'local' })}>
          <Plus className="h-4 w-4" />
          {t('addAccount.providers.local.action')}
        </button>
      ) : (
        <div className="flex gap-2">
          <button type="button" className="gc-btn flex-1 justify-center" onClick={syncNow} disabled={syncing || !account?.isActive}>
            <RotateCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? t('accounts.syncing') : t('accounts.syncNow')}
          </button>
          <button
            type="button"
            className="gc-btn flex-1 justify-center text-today"
            onClick={() => props.push({ name: 'remove', accountId: props.accountId })}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('accounts.remove')}
          </button>
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- remove */

/**
 * One question instead of the old pair of unlabeled icons ("unlink" vs "trash",
 * which did different things nobody could tell apart): keep the events here, or
 * take them out of xrncal too. Neither touches anything on the provider.
 */
export const RemoveAccountView: React.FC<AccountsPageProps & { accountId: string }> = (props) => {
  const { t } = useTranslation()
  const label = useProviderLabel()
  const [keep, setKeep] = useState(true)
  const [busy, setBusy] = useState(false)
  const account = props.accounts.find((a) => a.id === props.accountId)
  if (!account) return null
  // "on Google itself", but "on homeserver.example.net itself" - a CalDAV
  // account is a particular server, and "on CalDAV itself" meant nothing.
  const kind = providerKind(account)
  const provider = kind === 'caldav' ? account.name : label(kind)

  const remove = async () => {
    if (!window.xrncal?.auth || !window.xrncal?.calendars) return
    setBusy(true)
    // Remember the calendars before detaching moves them to this computer.
    const calendarIds = props.calendars.filter((c) => c.accountId === account.id).map((c) => c.id)
    try {
      // Detach first in both cases: with the account gone, no sync can bring
      // the calendars back while they are being deleted.
      const result = await window.xrncal.auth.detachAccount(account.id)
      if (!result.success) throw new Error(result.message || '')
      if (!keep) {
        for (const id of calendarIds) await window.xrncal.calendars.delete(id)
      }
      await props.refresh()
      toast.success(t('accounts.removed', { name: account.name }), {
        description: keep
          ? t('accounts.removedKept', { calendars: result.calendarCount, events: result.eventCount })
          : t('accounts.removedAll')
      })
      props.reset([{ name: 'list' }])
    } catch (err) {
      showFriendlyError(err, t('accounts.removeFailed'))
      setBusy(false)
    }
  }

  const option = (value: boolean, title: string, detail: string) => (
    <label
      className={`flex cursor-pointer gap-3 border px-3 py-2.5 transition-colors ${
        keep === value ? 'border-accent/60 bg-accent/5' : 'border-hairline hover:bg-hover'
      }`}
      style={{ borderRadius: 'var(--radius-control)' }}
    >
      <input
        type="radio"
        name="remove-mode"
        className="mt-0.5 accent-accent"
        checked={keep === value}
        onChange={() => setKeep(value)}
      />
      <span>
        <span className="block text-sm text-primary">{title}</span>
        <span className="block text-xs text-muted">{detail}</span>
      </span>
    </label>
  )

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-primary">{t('accounts.removeQuestion', { name: account.name })}</p>
      {option(true, t('accounts.removeKeep'), t('accounts.removeKeepDetail'))}
      {option(false, t('accounts.removeAll'), t('accounts.removeAllDetail'))}
      <p className="text-xs text-muted">{t('accounts.removeProviderUntouched', { provider })}</p>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="gc-btn" onClick={props.back} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button type="button" className="gc-btn text-today" onClick={remove} disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('accounts.removeConfirm')}
        </button>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- new local */

export const NewLocalCalendarView: React.FC<AccountsPageProps> = (props) => {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [color, setColor] = useState(() => {
    const used = new Set(props.calendars.map((c) => c.color?.toLowerCase()))
    return CALENDAR_COLOR_PALETTE.find((hex) => !used.has(hex.toLowerCase())) ?? CALENDAR_COLOR_PALETTE[0]
  })
  const [busy, setBusy] = useState(false)

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !window.xrncal?.calendars) return
    setBusy(true)
    try {
      await window.xrncal.calendars.create({ name: name.trim(), color })
      await props.refresh()
      toast.success(t('accounts.calendarCreated'), { description: name.trim() })
      props.reset([{ name: 'list' }, { name: 'account', accountId: LOCAL_ACCOUNT_ID }])
    } catch (err) {
      showFriendlyError(err, t('accounts.calendarCreateFailed'))
      setBusy(false)
    }
  }

  const preview: Calendar = {
    id: '__new__',
    accountId: LOCAL_ACCOUNT_ID,
    name,
    color,
    isVisible: true,
    isReadOnly: false,
    isDefault: false,
    createdAt: '',
    updatedAt: ''
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={create}>
      <p className="text-xs text-muted">{t('addAccount.providers.local.detail')}</p>
      <TextInput
        variant="boxed"
        label={t('addAccount.local.name')}
        placeholder={t('addAccount.local.placeholder')}
        value={name}
        onChange={setName}
        autoFocus
      />
      <div>
        <div className="mb-1 text-xs text-muted">{t('calendarList.color')}</div>
        <ColorPalette calendar={preview} calendars={props.calendars} onPick={setColor} />
      </div>
      <div className="flex justify-end">
        <button type="submit" className="gc-btn-primary" disabled={!name.trim() || busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('addAccount.local.create')}
        </button>
      </div>
    </form>
  )
}
