import React from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarDays, CalendarRange, Calendar, Grid3x3, List, Plus } from 'lucide-react'
import type { CalendarViewType } from '@shared/visible-range'

interface Props {
  currentView: CalendarViewType
  onChangeView: (view: CalendarViewType) => void
  onCreate: () => void
}

/**
 * Primary navigation, bottom-anchored.
 *
 * Desktop switches views from a segmented control in the header, which on a
 * phone would sit at the far end of a thumb's reach. The five views become a
 * bottom bar with the create action raised into the middle - the arrangement
 * Android users already know from Calendar, Tasks and Keep.
 */
// Keys are the existing `views.*` catalog entries the desktop ViewSwitcher
// uses, so the labels stay translated in both locales with nothing new added.
const VIEWS: { id: CalendarViewType; icon: React.ElementType; labelKey: string }[] = [
  { id: 'day', icon: CalendarDays, labelKey: 'views.day' },
  { id: 'week', icon: CalendarRange, labelKey: 'views.week' },
  { id: 'month', icon: Calendar, labelKey: 'views.month' },
  { id: 'year', icon: Grid3x3, labelKey: 'views.year' },
  { id: 'list', icon: List, labelKey: 'views.list' }
]

const BottomNav: React.FC<Props> = ({ currentView, onChangeView, onCreate }) => {
  const { t } = useTranslation()

  return (
    <nav
      className="gc-bottom-nav relative z-30 flex shrink-0 items-stretch border-t border-hairline bg-sidebar"
      aria-label={t('nav.views', { defaultValue: 'Calendar views' })}
    >
      {VIEWS.slice(0, 2).map((v) => (
        <NavButton key={v.id} view={v} active={currentView === v.id} onSelect={onChangeView} />
      ))}

      {/* Raised create button. It sits in the bar's flow rather than floating
          over the grid, so it can never cover an event block. */}
      <div className="relative flex w-16 shrink-0 items-start justify-center">
        <button
          type="button"
          onClick={onCreate}
          aria-label={t('event.new', { defaultValue: 'New event' })}
          className="-mt-5 flex h-12 w-12 items-center justify-center rounded-[4px] bg-[var(--color-accent-mark)] text-white shadow-lg transition-transform active:scale-95"
        >
          <Plus size={22} strokeWidth={2.5} />
        </button>
      </div>

      {VIEWS.slice(2).map((v) => (
        <NavButton key={v.id} view={v} active={currentView === v.id} onSelect={onChangeView} />
      ))}
    </nav>
  )
}

const NavButton: React.FC<{
  view: { id: CalendarViewType; icon: React.ElementType; labelKey: string }
  active: boolean
  onSelect: (view: CalendarViewType) => void
}> = ({ view, active, onSelect }) => {
  const { t } = useTranslation()
  const Icon = view.icon
  return (
    <button
      type="button"
      onClick={() => onSelect(view.id)}
      aria-current={active ? 'page' : undefined}
      // 56px tall: comfortably past the 48dp Android minimum touch target.
      className={`flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
        active ? 'text-[var(--color-accent-mark)]' : 'text-muted'
      }`}
    >
      <Icon size={20} strokeWidth={active ? 2.4 : 1.8} />
      <span className="leading-none">{t(view.labelKey)}</span>
    </button>
  )
}

export default BottomNav
