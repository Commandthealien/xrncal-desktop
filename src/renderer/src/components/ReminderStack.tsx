import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, X } from 'lucide-react'
import type { ActiveReminder } from '@shared/ipc-contract'
import type { Calendar, ExpandedOccurrence } from '@shared/event-model'
import { useDisplayPreferences } from '../context/DisplayPreferencesContext'
import { reminderWhenLabel } from '../lib/reminder-labels'

const SNOOZE_MINUTES = [5, 10, 15, 30, 60]
/** Cards shown at once; the rest are counted underneath. */
const MAX_VISIBLE = 3

interface ReminderStackProps {
  calendars: Calendar[]
  onOpen: (occurrence: ExpandedOccurrence) => void
}

/**
 * Reminders that have rung and are waiting for an answer, bottom right.
 *
 * A native notification cannot carry buttons on Linux, so snoozing and joining
 * a meeting happen here. The list belongs to the main process - it keeps
 * ringing with the window closed - and this only mirrors it.
 */
export const ReminderStack: React.FC<ReminderStackProps> = ({ calendars, onOpen }) => {
  const { t, i18n } = useTranslation()
  const { timeFormat } = useDisplayPreferences()
  const [active, setActive] = useState<ActiveReminder[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [snoozing, setSnoozing] = useState<string | null>(null)

  useEffect(() => {
    const api = window.xrncal?.reminders
    if (!api) return
    let cancelled = false
    api
      .listActive()
      .then((list) => {
        if (!cancelled) setActive(list)
      })
      .catch(() => {})
    const unsubscribe = api.onChanged(setActive)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // "In 10 min" has to keep counting down while the card sits there.
  useEffect(() => {
    if (active.length === 0) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [active.length])

  if (active.length === 0) return null

  const colorFor = (occ: ExpandedOccurrence): string =>
    occ.color || calendars.find((c) => c.id === occ.calendarId)?.color || 'var(--color-accent-mark)'

  const dismiss = (key: string) => void window.xrncal?.reminders?.dismiss(key)
  const snooze = (key: string, minutes: number) => {
    setSnoozing(null)
    void window.xrncal?.reminders?.snooze(key, minutes)
  }

  return (
    <div className="fixed right-4 bottom-4 z-40 flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-2">
      {active.slice(0, MAX_VISIBLE).map(({ key, occurrence: occ }) => (
        <div
          key={key}
          className="flex overflow-hidden border border-hairline bg-dialog text-primary shadow-xl"
          style={{ borderRadius: 'var(--radius-dialog)' }}
        >
          <div className="w-1 shrink-0" style={{ backgroundColor: colorFor(occ) }} />
          <div className="min-w-0 flex-1 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{occ.title || t('common.untitled')}</div>
                <div className="truncate text-xs text-muted">
                  {reminderWhenLabel(t, occ, now, timeFormat, i18n.language)}
                  {occ.location ? ` · ${occ.location}` : ''}
                </div>
              </div>
              <button
                type="button"
                className="gc-icon-btn -mt-0.5 -mr-1 shrink-0"
                onClick={() => dismiss(key)}
                aria-label={t('reminders.dismiss')}
                title={t('reminders.dismiss')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {snoozing === key ? (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {SNOOZE_MINUTES.map((m) => (
                  <button key={m} type="button" className="gc-btn text-xs" onClick={() => snooze(key, m)}>
                    {m === 60 ? t('reminders.snoozeHour') : t('reminders.snoozeMinutes', { count: m })}
                  </button>
                ))}
                <button
                  type="button"
                  className="ml-auto text-xs text-muted hover:text-primary"
                  onClick={() => setSnoozing(null)}
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-1">
                {occ.meetingUrl && (
                  // Goes through the main window's open handler, which hands only
                  // http(s) and mailto links to the OS.
                  <button
                    type="button"
                    className="gc-btn-primary text-xs"
                    onClick={() => window.open(occ.meetingUrl, '_blank')}
                  >
                    {t('reminders.join')}
                  </button>
                )}
                <button type="button" className="gc-btn text-xs" onClick={() => onOpen(occ)}>
                  {t('reminders.open')}
                </button>
                <button type="button" className="gc-btn text-xs" onClick={() => setSnoozing(key)}>
                  {t('reminders.snooze')}
                </button>
              </div>
            )}
          </div>
        </div>
      ))}

      {active.length > MAX_VISIBLE && (
        <div className="flex items-center justify-between px-1 text-xs text-muted">
          <span>{t('reminders.more', { count: active.length - MAX_VISIBLE })}</span>
          <button
            type="button"
            className="hover:text-primary"
            onClick={() => active.forEach((r) => dismiss(r.key))}
          >
            {t('reminders.dismissAll')}
          </button>
        </div>
      )}
    </div>
  )
}

export default ReminderStack
