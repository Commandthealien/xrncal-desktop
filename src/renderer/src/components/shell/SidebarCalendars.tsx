import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Eye, MoreHorizontal, Plus, Settings2, Focus } from 'lucide-react'
import type { Calendar, CalendarAccount } from '@shared/event-model'
import {
  groupCalendars,
  showAllChanges,
  showOnlyChanges,
  type CalendarGroup
} from '../../lib/account-display'
import { CalendarRow, ColorPalette } from '../accounts/CalendarToggle'
import ProviderMark from '../accounts/ProviderMark'

interface SidebarCalendarsProps {
  accounts: CalendarAccount[]
  calendars: Calendar[]
  onToggleVisibility: (cal: Calendar) => void
  onSetVisibility: (changes: { id: string; isVisible: boolean }[]) => void
  onChangeColor: (cal: Calendar, hex: string) => void
  /** Opens the accounts dialog, on this account's page when one is given. */
  onOpenAccount: (accountId: string | null) => void
  onAddAccount: () => void
}

const COLLAPSED_KEY = 'xrncal.sidebar.collapsedGroups'

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'))
  } catch {
    return new Set()
  }
}

/**
 * The calendar list under the mini calendar. Showing or hiding a calendar used
 * to mean Settings, then Calendars, then a checkbox; now it is one click where
 * the calendar is, grouped by account the way OneCalendar's list is.
 */
export const SidebarCalendars: React.FC<SidebarCalendarsProps> = ({
  accounts,
  calendars,
  onToggleVisibility,
  onSetVisibility,
  onChangeColor,
  onOpenAccount,
  onAddAccount
}) => {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const groups = groupCalendars(accounts, calendars).filter((g) => g.calendars.length > 0)
  const anyHidden = calendars.some((c) => !c.isVisible)

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      } catch {
        // A convenience only: the list still works without remembering.
      }
      return next
    })
  }

  const groupLabel = (group: CalendarGroup) =>
    group.kind === 'local'
      ? t('calendarList.thisComputer')
      : group.kind === 'holidays'
        ? t('holidays.title')
        : group.account?.name || t(`addAccount.providers.${group.kind}.title`)

  return (
    <section className="flex min-h-0 flex-col gap-1" aria-label={t('calendarList.title')}>
      <div className="flex items-center justify-between px-1.5">
        <span className="text-[11px] font-medium text-muted">{t('calendarList.title')}</span>
        <button
          type="button"
          className="gc-icon-btn h-6 w-6"
          onClick={onAddAccount}
          title={t('addAccount.title')}
          aria-label={t('addAccount.title')}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {groups.length === 0 && (
        <button type="button" onClick={onAddAccount} className="gc-btn mx-1.5 justify-center">
          <Plus className="h-3.5 w-3.5" />
          {t('addAccount.title')}
        </button>
      )}

      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.key)
        return (
          <div key={group.key}>
            <button
              type="button"
              onClick={() => toggleGroup(group.key)}
              className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-[11px] font-medium text-muted transition-colors hover:text-primary"
              title={group.account?.email || undefined}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
              <ProviderMark kind={group.kind} size="sm" />
              <span className="min-w-0 flex-1 truncate">{groupLabel(group)}</span>
            </button>

            {!isCollapsed &&
              group.calendars.map((cal) => (
                <CalendarRow
                  key={cal.id}
                  calendar={cal}
                  dense
                  onToggle={() => onToggleVisibility(cal)}
                  trailing={
                    <CalendarMenu
                      open={menuFor === cal.id}
                      onOpenChange={(open) => setMenuFor(open ? cal.id : null)}
                      label={t('calendarList.more', { name: cal.name })}
                    >
                      <MenuItem
                        icon={<Focus className="h-3.5 w-3.5" />}
                        onClick={() => {
                          onSetVisibility(showOnlyChanges(calendars, cal.id))
                          setMenuFor(null)
                        }}
                      >
                        {t('calendarList.showOnly')}
                      </MenuItem>
                      {anyHidden && (
                        <MenuItem
                          icon={<Eye className="h-3.5 w-3.5" />}
                          onClick={() => {
                            onSetVisibility(showAllChanges(calendars))
                            setMenuFor(null)
                          }}
                        >
                          {t('calendarList.showAll')}
                        </MenuItem>
                      )}
                      <div className="my-1 border-t border-hairline" />
                      <div className="px-2 pt-1 text-[10px] font-medium text-muted">{t('calendarList.color')}</div>
                      <ColorPalette
                        calendar={cal}
                        calendars={calendars}
                        onPick={(hex) => {
                          onChangeColor(cal, hex)
                          setMenuFor(null)
                        }}
                      />
                      <div className="my-1 border-t border-hairline" />
                      <MenuItem
                        icon={<Settings2 className="h-3.5 w-3.5" />}
                        onClick={() => {
                          setMenuFor(null)
                          onOpenAccount(group.account?.id ?? null)
                        }}
                      >
                        {t('calendarList.accountSettings')}
                      </MenuItem>
                    </CalendarMenu>
                  }
                />
              ))}
          </div>
        )
      })}
    </section>
  )
}

const MENU_WIDTH = 224

/**
 * The "⋯" on a calendar row and the menu it opens. Closes on Escape or a click
 * elsewhere. The menu is portalled to <body>: the sidebar scrolls, and a menu
 * drawn inside it was clipped by that scroller near the bottom of the list.
 */
const CalendarMenu: React.FC<{
  open: boolean
  onOpenChange: (open: boolean) => void
  label: string
  children: React.ReactNode
}> = ({ open, onOpenChange, label, children }) => {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return
    const r = buttonRef.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8))
    // Open upwards when the row is in the lower part of the window.
    setPos(r.bottom > window.innerHeight * 0.55 ? { left, bottom: window.innerHeight - r.top + 4 } : { left, top: r.bottom + 4 })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) onOpenChange(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // This menu is the top layer: App's Escape handling must not also act.
        e.stopPropagation()
        onOpenChange(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onOpenChange])

  return (
    <div className="shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`gc-focus-ring flex h-5 w-5 items-center justify-center text-muted transition-opacity hover:text-primary focus:opacity-100 group-hover:opacity-100 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ borderRadius: 'var(--radius-control)' }}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 border border-hairline bg-dialog py-1 shadow-lg select-none"
            style={{ ...pos, width: MENU_WIDTH, borderRadius: 'var(--radius-dialog)' }}
          >
            {children}
          </div>,
          document.body
        )}
    </div>
  )
}

const MenuItem: React.FC<{ icon: React.ReactNode; onClick: () => void; children: React.ReactNode }> = ({
  icon,
  onClick,
  children
}) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-primary transition-colors hover:bg-hover"
  >
    <span className="text-muted">{icon}</span>
    {children}
  </button>
)

export default SidebarCalendars
