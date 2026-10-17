import React from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, X } from 'lucide-react'
import {
  ALL_DAY_REMINDER_PRESETS,
  TIMED_REMINDER_PRESETS,
  normalizeReminders,
  type EventReminder
} from '@shared/reminders'
import { CustomSelect } from '../components/ui'
import { useDisplayPreferences } from '../context/DisplayPreferencesContext'
import { reminderLabel, reminderOptions } from '../lib/reminder-labels'

interface ReminderListFieldProps {
  /** What the event rings with now - its own list, or the default it follows. */
  reminders: EventReminder[]
  allDay: boolean
  /** The list shown is the default rather than one the event sets itself. */
  isDefault: boolean
  onChange: (next: EventReminder[]) => void
  /** Go back to following the default. */
  onUseDefault: () => void
}

/**
 * The editor's reminder list: one picker per reminder, a way to add another,
 * and - once the event has its own list - a way back to the default.
 */
export const ReminderListField: React.FC<ReminderListFieldProps> = ({
  reminders,
  allDay,
  isDefault,
  onChange,
  onUseDefault
}) => {
  const { t } = useTranslation()
  const { timeFormat } = useDisplayPreferences()

  const replaceAt = (index: number, minutesBefore: number) => {
    const next = reminders.map((r, i) => (i === index ? { ...r, minutesBefore } : r))
    onChange(normalizeReminders(next))
  }

  const add = () => {
    const presets = allDay ? ALL_DAY_REMINDER_PRESETS : TIMED_REMINDER_PRESETS
    const used = new Set(reminders.filter((r) => !r.method).map((r) => r.minutesBefore))
    const preferred = allDay ? 900 : 10
    const pick = used.has(preferred) ? presets.find((m) => !used.has(m)) : preferred
    if (pick === undefined) return
    onChange(normalizeReminders([...reminders, { minutesBefore: pick }]))
  }

  return (
    <div className="w-full space-y-1 py-1">
      {reminders.length === 0 && <div className="px-2.5 py-1 text-xs text-muted">{t('reminders.none')}</div>}

      {reminders.map((r, index) => (
        <div key={`${r.method ?? 'display'}-${r.minutesBefore}`} className="flex items-center gap-1">
          <Bell className="ml-2.5 h-3.5 w-3.5 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            {r.method === 'email' ? (
              // Email reminders come from the provider; they can be removed here
              // but there is no address to send a new one to.
              <div className="px-2.5 py-1.5 text-xs text-primary">
                {reminderLabel(t, r, allDay, timeFormat)}
              </div>
            ) : (
              <CustomSelect
                value={String(r.minutesBefore)}
                onChange={(val) => replaceAt(index, Number(val))}
                options={reminderOptions(t, allDay, timeFormat, r.minutesBefore)}
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => onChange(reminders.filter((_, i) => i !== index))}
            className="gc-icon-btn shrink-0"
            aria-label={t('common.delete')}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}

      <div className="flex items-center gap-2 px-2.5 pt-0.5">
        <button type="button" onClick={add} className="text-xs text-muted transition-colors hover:text-primary">
          + {t('reminders.add')}
        </button>
        {isDefault ? (
          <span className="ml-auto text-[10px] uppercase tracking-wide text-muted">{t('reminders.isDefault')}</span>
        ) : (
          <button
            type="button"
            onClick={onUseDefault}
            className="ml-auto text-xs text-muted transition-colors hover:text-primary"
          >
            {t('reminders.useDefault')}
          </button>
        )}
      </div>
    </div>
  )
}

export default ReminderListField
