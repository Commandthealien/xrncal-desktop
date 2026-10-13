import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, ExternalLink, Loader2, Palette, RefreshCw, Trash2 } from 'lucide-react'
import { DateTime } from 'luxon'
import type { Calendar, CalendarAccount } from '@shared/event-model'
import {
  classifyConnectError,
  groupCalendars,
  hostOf,
  normaliseServerInput,
  type ConnectProblem
} from '../../lib/account-display'
import { TextInput, showFriendlyError } from '../ui'
import HolidayCalendarToggle from '../HolidayCalendarToggle'
import { CalendarRow, ColorPalette } from './CalendarToggle'
import ProviderMark from './ProviderMark'
import { NavRow } from './AccountViews'
import type { AccountsPageProps, AddableProvider } from './accounts-nav'

/* ---------------------------------------------------------------- picker */

const PROVIDERS: AddableProvider[] = ['google', 'graph', 'icloud', 'caldav', 'subscription', 'holidays', 'local']

/** OneCalendar's "Account type" page: one choice, each with a line saying what it covers. */
export const ProviderPickView: React.FC<AccountsPageProps> = (props) => {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-0.5">
      {PROVIDERS.map((provider) => (
        <NavRow
          key={provider}
          icon={<ProviderMark kind={provider} />}
          title={t(`addAccount.providers.${provider}.title`)}
          subtitle={t(`addAccount.providers.${provider}.detail`)}
          onClick={() =>
            props.push(
              provider === 'holidays'
                ? { name: 'holidays' }
                : provider === 'subscription'
                  ? { name: 'subscriptions' }
                  : provider === 'local'
                    ? { name: 'local' }
                    : { name: 'connect', provider }
            )
          }
        />
      ))}
    </div>
  )
}

/* --------------------------------------------------------------- connect */

type ConnectResult = { success: boolean; account?: CalendarAccount; message?: string }

/** Why it failed, in words, with the raw message kept underneath for anything we did not recognise. */
const ProblemPanel: React.FC<{ problem: ConnectProblem; raw?: string; provider: string }> = ({ problem, raw, provider }) => {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className="flex gap-2 border border-today/40 px-3 py-2.5 text-xs"
      style={{ borderRadius: 'var(--radius-control)' }}
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-today" />
      <div className="min-w-0 space-y-1">
        <div className="text-primary">{t(`addAccount.problems.${problem}`, { provider })}</div>
        {raw && <div className="break-words text-muted select-text">{t('addAccount.details', { msg: raw })}</div>}
      </div>
    </div>
  )
}

/**
 * The details page for one provider. Google and Microsoft sign in in the
 * browser, so there is nothing to type - just what is about to happen and a
 * wait. iCloud and CalDAV ask only for what they need, with no example
 * addresses pre-filled to delete, and a failure stays on screen in plain words
 * until the form changes, instead of a message that vanished after five seconds.
 */
export const ConnectView: React.FC<AccountsPageProps & { provider: 'google' | 'graph' | 'icloud' | 'caldav' }> = (props) => {
  const { t } = useTranslation()
  const providerName = t(`addAccount.providers.${props.provider}.title`)
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ problem: ConnectProblem; raw?: string } | null>(null)
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  // Editing the form is the user acting on the error; stop showing it.
  useEffect(() => setFailure(null), [server, username, password])

  const finish = async (res: ConnectResult) => {
    if (!alive.current) return
    if (res.success && res.account) {
      await props.refresh()
      props.reset([{ name: 'list' }, { name: 'choose', accountId: res.account.id }])
      return
    }
    setFailure({ problem: classifyConnectError(res.message), raw: res.message })
    setBusy(false)
  }

  const run = async (call: () => Promise<ConnectResult>) => {
    setBusy(true)
    setFailure(null)
    try {
      await finish(await call())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await finish({ success: false, message })
    }
  }

  const auth = window.xrncal?.auth
  const isOAuth = props.provider === 'google' || props.provider === 'graph'

  if (isOAuth) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-primary">{t('addAccount.browser.body', { provider: providerName })}</p>
        <p className="text-xs text-muted">{t('addAccount.browser.privacy')}</p>
        {failure && <ProblemPanel problem={failure.problem} raw={failure.raw} provider={providerName} />}
        {busy ? (
          <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('addAccount.browser.waiting')}
          </div>
        ) : (
          <div className="flex justify-end">
            <button
              type="button"
              className="gc-btn-primary"
              autoFocus
              onClick={() => run(() => (props.provider === 'google' ? auth!.connectGoogle() : auth!.connectMicrosoft()))}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {failure ? t('addAccount.tryAgain') : t('addAccount.browser.open')}
            </button>
          </div>
        )}
      </div>
    )
  }

  const isICloud = props.provider === 'icloud'
  const canSubmit = !busy && username.trim() && password && (isICloud || server.trim())

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || !auth) return
    void run(() =>
      auth.connectCalDav({
        provider: isICloud ? 'icloud' : 'generic',
        serverUrl: isICloud ? undefined : normaliseServerInput(server),
        username: username.trim(),
        password,
        name: name.trim() || undefined
      })
    )
  }

  return (
    // noValidate: the browser's own checks rejected a bare host ("Please enter
    // a URL") - exactly what this form accepts - in an unstyled bubble.
    <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
      {isICloud ? (
        <div
          className="space-y-1.5 border border-hairline bg-hover/40 px-3 py-2.5 text-xs"
          style={{ borderRadius: 'var(--radius-control)' }}
        >
          <p className="text-primary">{t('addAccount.icloud.hint')}</p>
          <a
            href="https://appleid.apple.com/account/manage"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            {t('addAccount.icloud.link')}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : (
        <div className="space-y-1">
          <TextInput
            variant="boxed"
            label={t('addAccount.caldav.server')}
            placeholder="cloud.example.com"
            value={server}
            onChange={setServer}
            autoFocus
          />
          <p className="px-0.5 text-[11px] text-muted">{t('addAccount.caldav.serverHint')}</p>
        </div>
      )}

      <TextInput
        variant="boxed"
        type={isICloud ? 'email' : 'text'}
        label={isICloud ? t('addAccount.icloud.appleId') : t('addAccount.caldav.username')}
        placeholder={isICloud ? 'name@icloud.com' : undefined}
        value={username}
        onChange={setUsername}
        autoFocus={isICloud}
      />
      <TextInput
        variant="boxed"
        type="password"
        label={isICloud ? t('addAccount.icloud.appPassword') : t('addAccount.caldav.password')}
        value={password}
        onChange={setPassword}
      />
      <TextInput
        variant="boxed"
        label={t('addAccount.caldav.name')}
        placeholder={isICloud ? 'iCloud' : hostOf(server) || t('addAccount.caldav.namePlaceholder')}
        value={name}
        onChange={setName}
      />

      {failure && <ProblemPanel problem={failure.problem} raw={failure.raw} provider={providerName} />}

      <div className="flex justify-end">
        <button type="submit" className="gc-btn-primary" disabled={!canSubmit}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? t('addAccount.connecting') : t('addAccount.connect')}
        </button>
      </div>
    </form>
  )
}

/* -------------------------------------------------------------- holidays */

export const HolidaysView: React.FC<AccountsPageProps> = (props) => {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">{t('addAccount.providers.holidays.detail')}</p>
      <HolidayCalendarToggle calendars={props.calendars} onCalendarsChanged={() => void props.refresh()} />
      <div className="flex justify-end">
        {/* Done finishes, wherever this page was opened from - after the add flow,
            "back" would have landed on the provider list. */}
        <button type="button" className="gc-btn" onClick={() => props.reset([{ name: 'list' }])}>
          {t('common.done')}
        </button>
      </div>
    </div>
  )
}

/* --------------------------------------------------------- subscriptions */

/**
 * Calendars subscribed to by link: the ones there are, and a form for another.
 * A feed is fetched before its calendar is created, so a link that is wrong
 * fails here with the reason rather than leaving an empty calendar.
 */
export const SubscriptionsView: React.FC<AccountsPageProps> = (props) => {
  const { t, i18n } = useTranslation()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const subscribed = props.calendars.filter((c) => c.subscriptionUrl)
  const api = window.xrncal?.subscriptions

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!api || !url.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.add(url.trim(), name.trim() || undefined)
      setUrl('')
      setName('')
      await props.refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''))
    } finally {
      setBusy(false)
    }
  }

  const refreshOne = async (cal: Calendar) => {
    if (!api) return
    setRefreshing(cal.id)
    try {
      await api.refresh(cal.id)
      await props.refresh()
    } catch (err) {
      showFriendlyError(err, t('subscriptions.refreshFailed'))
    } finally {
      setRefreshing(null)
    }
  }

  const unsubscribe = async (cal: Calendar) => {
    if (!window.xrncal?.calendars || !confirm(t('subscriptions.unsubscribeConfirm', { name: cal.name }))) return
    try {
      await window.xrncal.calendars.delete(cal.id)
      await props.refresh()
    } catch (err) {
      showFriendlyError(err, t('subscriptions.unsubscribeFailed'))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {subscribed.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {subscribed.map((cal) => (
            <div key={cal.id} className="flex items-center gap-2.5 px-2 py-1.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: cal.color }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-primary">{cal.name}</span>
                <span className="block truncate text-xs text-muted">
                  {hostOf(cal.subscriptionUrl!)} ·{' '}
                  {cal.subscriptionRefreshedAt
                    ? t('subscriptions.refreshed', {
                        when: DateTime.fromISO(cal.subscriptionRefreshedAt).setLocale(i18n.language).toRelative()
                      })
                    : t('subscriptions.neverRefreshed')}
                </span>
              </span>
              <button
                type="button"
                className="gc-icon-btn h-7 w-7"
                title={t('subscriptions.refresh')}
                aria-label={t('subscriptions.refresh')}
                disabled={refreshing === cal.id}
                onClick={() => void refreshOne(cal)}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing === cal.id ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                className="gc-icon-btn h-7 w-7 hover:text-today"
                title={t('subscriptions.unsubscribe')}
                aria-label={t('subscriptions.unsubscribe')}
                onClick={() => void unsubscribe(cal)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
        <p className="text-xs text-muted">{t('subscriptions.intro')}</p>
        <TextInput
          variant="boxed"
          label={t('subscriptions.url')}
          placeholder={t('subscriptions.urlPlaceholder')}
          value={url}
          onChange={setUrl}
          autoFocus
        />
        <TextInput
          variant="boxed"
          label={t('subscriptions.name')}
          placeholder={t('subscriptions.namePlaceholder')}
          value={name}
          onChange={setName}
        />
        {error && (
          <div
            className="flex items-start gap-2 border border-hairline bg-hover/40 px-3 py-2.5 text-xs"
            style={{ borderRadius: 'var(--radius-control)' }}
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-today" />
            <span className="min-w-0 text-primary">
              {t('subscriptions.failed')}: {error}
            </span>
          </div>
        )}
        <div className="flex justify-end">
          <button type="submit" className="gc-btn-primary" disabled={busy || !url.trim()}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy ? t('subscriptions.subscribing') : t('subscriptions.subscribe')}
          </button>
        </div>
      </form>
    </div>
  )
}

/* ---------------------------------------------------------------- choose */

const FETCH_ATTEMPTS = 20
const FETCH_INTERVAL_MS = 1500

/**
 * After connecting: OneCalendar's "Configure account" and "Account added" in
 * one page. The account's calendars arrive with its first sync, a moment after
 * the connect returns, so this waits for them rather than showing an empty list.
 */
export const ChooseCalendarsView: React.FC<AccountsPageProps & { accountId: string }> = (props) => {
  const { t } = useTranslation()
  const [paletteFor, setPaletteFor] = useState<string | null>(null)
  const [attempts, setAttempts] = useState(0)
  const account = props.accounts.find((a) => a.id === props.accountId)
  const calendars = groupCalendars(props.accounts, props.calendars).find((g) => g.key === props.accountId)?.calendars ?? []
  const waiting = calendars.length === 0 && attempts < FETCH_ATTEMPTS
  const { refresh } = props

  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => {
      void refresh().finally(() => setAttempts((n) => n + 1))
    }, FETCH_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [waiting, attempts, refresh])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm text-primary">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white">
          <Check className="h-3 w-3 stroke-[3]" />
        </span>
        {t('addAccount.connected', { name: account?.name ?? '' })}
      </div>

      <div>
        <p className="mb-2 text-xs text-muted">{t('addAccount.choose')}</p>
        {waiting && (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('addAccount.fetching')}
          </div>
        )}
        {!waiting && calendars.length === 0 && (
          <div className="px-2 py-2 text-xs text-muted">{t('accounts.noCalendarsYet')}</div>
        )}
        {calendars.map((cal) => (
          <div key={cal.id}>
            <CalendarRow
              calendar={cal}
              onToggle={() => props.onToggleVisibility(cal)}
              trailing={
                <button
                  type="button"
                  className="gc-icon-btn h-6 w-6"
                  title={t('calendarList.color')}
                  aria-label={t('calendarList.color')}
                  onClick={() => setPaletteFor(paletteFor === cal.id ? null : cal.id)}
                >
                  <Palette className="h-3.5 w-3.5" />
                </button>
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
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" className="gc-btn" onClick={() => props.reset([{ name: 'list' }, { name: 'add' }])}>
          {t('addAccount.addAnother')}
        </button>
        <button type="button" className="gc-btn-primary" onClick={props.close}>
          {t('common.done')}
        </button>
      </div>
    </div>
  )
}
