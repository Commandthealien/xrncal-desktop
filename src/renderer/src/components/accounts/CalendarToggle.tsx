import React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Lock } from 'lucide-react'
import type { Calendar } from '@shared/event-model'
import { CALENDAR_COLOR_PALETTE } from '../../lib/calendar-colors'

/**
 * A calendar's show/hide box, drawn in the calendar's own colour: filled with a
 * tick while it shows, an outline while it is hidden. The colour doubles as the
 * legend for the events on the grid, the way Google Calendar and OneCalendar
 * draw it, so there is no separate dot to tell apart from the checkbox.
 */
const CalendarCheck: React.FC<{
  calendar: Calendar
  onToggle: () => void
  className?: string
}> = ({ calendar, onToggle, className = '' }) => {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={calendar.isVisible}
      aria-label={calendar.isVisible ? t('calendarList.hide', { name: calendar.name }) : t('calendarList.show', { name: calendar.name })}
      onClick={onToggle}
      className={`gc-focus-ring flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center border-[1.5px] transition-colors ${className}`}
      style={{
        borderRadius: 'var(--radius-control)',
        borderColor: calendar.color,
        backgroundColor: calendar.isVisible ? calendar.color : 'transparent'
      }}
    >
      {calendar.isVisible && <Check className="h-2.5 w-2.5 stroke-[3.5] text-white" />}
    </button>
  )
}

/** One calendar as a row: its box, its name, a lock when it cannot be edited, and room for actions. */
export const CalendarRow: React.FC<{
  calendar: Calendar
  onToggle: () => void
  trailing?: React.ReactNode
  dense?: boolean
}> = ({ calendar, onToggle, trailing, dense = false }) => {
  const { t } = useTranslation()
  return (
    <div
      className={`group relative flex items-center gap-2 transition-colors hover:bg-hover ${dense ? 'px-1.5 py-1' : 'px-2 py-1.5'}`}
      style={{ borderRadius: 'var(--radius-control)' }}
    >
      <CalendarCheck calendar={calendar} onToggle={onToggle} />
      <button
        type="button"
        onClick={onToggle}
        className={`min-w-0 flex-1 cursor-pointer truncate text-left ${dense ? 'text-xs' : 'text-sm'} ${
          calendar.isVisible ? 'text-primary' : 'text-muted'
        }`}
        tabIndex={-1}
      >
        {calendar.name}
      </button>
      {calendar.isReadOnly && (
        <Lock className="h-3 w-3 shrink-0 text-muted" aria-label={t('calendarList.readOnly')} />
      )}
      {trailing}
    </div>
  )
}

/** The colour choices for a calendar; a small mark flags a colour another calendar already uses. */
export const ColorPalette: React.FC<{
  calendar: Calendar
  calendars: Calendar[]
  onPick: (hex: string) => void
}> = ({ calendar, calendars, onPick }) => {
  const { t } = useTranslation()
  return (
    <div className="grid grid-cols-8 gap-1.5 p-2">
      {CALENDAR_COLOR_PALETTE.map((hex) => {
        const usedByOther = calendars.some(
          (other) => other.id !== calendar.id && other.color?.toLowerCase() === hex.toLowerCase()
        )
        const current = calendar.color?.toLowerCase() === hex.toLowerCase()
        return (
          <button
            key={hex}
            type="button"
            onClick={() => onPick(hex)}
            className="gc-focus-ring relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-110"
            style={{ backgroundColor: hex }}
            title={usedByOther ? `${hex} (${t('calendarList.colorInUse')})` : hex}
            aria-label={hex}
            aria-pressed={current}
          >
            {/* A tick, not an outline: index.css strips outlines from every
                button with !important, so the old ring never showed. */}
            {current && <Check className="h-3 w-3 stroke-[3.5] text-white" />}
            {usedByOther && !current && (
              <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full border border-hairline bg-surface" />
            )}
          </button>
        )
      })}
    </div>
  )
}
