import React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Settings, Users, X } from 'lucide-react'
import MiniCalendar from '@renderer/components/MiniCalendar'
import { Checkbox } from '@renderer/components/ui'
import type { AppShellContext } from '@renderer/App'

interface Props {
  open: boolean
  onClose: () => void
  shell: AppShellContext
}

/**
 * The desktop sidebar as an off-canvas drawer.
 *
 * A 256px permanent rail would eat two thirds of a phone's width, so the same
 * content - month picker plus the calendar list - slides in over the grid and
 * dismisses on scrim tap or Back. It reuses MiniCalendar unchanged; only the
 * container differs.
 *
 * Rendered through a portal to document.body rather than in place. App puts
 * the sidebar inside its content row, which carries `z-10` and is a flex item
 * - so it establishes a stacking context, and *everything* inside it is
 * painted below the bottom nav's `z-30`, no matter how high the drawer's own
 * z-index goes. The portal lifts it out of that context entirely, which is
 * what an overlay wants anyway.
 */
const CalendarDrawer: React.FC<Props> = ({ open, onClose, shell }) => {
  const { t } = useTranslation()

  return createPortal(
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        className={`gc-drawer fixed inset-y-0 left-0 z-50 flex w-[86vw] max-w-[320px] flex-col overflow-y-auto border-r border-hairline bg-sidebar transition-transform duration-200 ease-[var(--ease-out)] ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between px-3.5 pt-2 pb-1">
          <span className="text-[13px] font-semibold text-primary">xrncal</span>
          <button
            type="button"
            aria-label={t('common.close', { defaultValue: 'Close' })}
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-[3px] text-muted active:bg-hover"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-3.5 pb-3">
          <MiniCalendar
            anchorDate={shell.anchorDate}
            occurrences={shell.occurrences}
            firstDayOfWeek={shell.firstDayOfWeek}
            onSelectDate={(date) => {
              shell.setAnchorDate(date)
              onClose()
            }}
            onPrevMonth={() => shell.setAnchorDate((d) => d.minus({ months: 1 }))}
            onNextMonth={() => shell.setAnchorDate((d) => d.plus({ months: 1 }))}
          />
        </div>

        <div className="border-t border-hairline px-3.5 py-3">
          <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
            {t('settings.calendars', { defaultValue: 'Calendars' })}
          </h2>
          <ul className="flex flex-col gap-0.5">
            {shell.calendars.map((cal) => (
              <li key={cal.id}>
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-[3px] px-1 active:bg-hover">
                  <Checkbox
                    checked={cal.isVisible}
                    onChange={() => shell.toggleCalendarVisibility(cal)}
                  />
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: cal.color }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-primary">
                    {cal.name}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto border-t border-hairline p-2">
          <DrawerAction
            icon={<Users size={17} />}
            label={t('settings.accounts', { defaultValue: 'Accounts' })}
            onClick={() => {
              onClose()
              shell.openAccounts()
            }}
          />
          <DrawerAction
            icon={<Settings size={17} />}
            label={t('settings.title', { defaultValue: 'Settings' })}
            onClick={() => {
              onClose()
              shell.openSettings()
            }}
          />
        </div>
      </aside>
    </>,
    document.body
  )
}

const DrawerAction: React.FC<{
  icon: React.ReactNode
  label: string
  onClick: () => void
}> = ({ icon, label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex min-h-[48px] w-full items-center gap-3 rounded-[3px] px-2.5 text-[13px] text-primary active:bg-hover"
  >
    <span className="text-muted">{icon}</span>
    {label}
  </button>
)

export default CalendarDrawer
