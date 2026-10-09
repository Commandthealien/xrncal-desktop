import React from 'react'
import { DateTime } from 'luxon'
import type { Calendar, CalendarAccount, ExpandedOccurrence } from '@shared/event-model'
import MiniCalendar from '../MiniCalendar'
import SidebarCalendars from './SidebarCalendars'

interface AppSidebarProps {
  collapsed: boolean
  anchorDate: DateTime
  occurrences: ExpandedOccurrence[]
  firstDayOfWeek: number
  onSelectDate: (date: DateTime) => void
  onPrevMonth: () => void
  onNextMonth: () => void
  accounts: CalendarAccount[]
  calendars: Calendar[]
  onToggleCalendarVisibility: (cal: Calendar) => void
  onSetCalendarsVisibility: (changes: { id: string; isVisible: boolean }[]) => void
  onChangeCalendarColor: (cal: Calendar, hex: string) => void
  onOpenAccount: (accountId: string | null) => void
  onAddAccount: () => void
}

export const AppSidebar: React.FC<AppSidebarProps> = ({
  collapsed,
  anchorDate,
  occurrences,
  firstDayOfWeek,
  onSelectDate,
  onPrevMonth,
  onNextMonth,
  accounts,
  calendars,
  onToggleCalendarVisibility,
  onSetCalendarsVisibility,
  onChangeCalendarColor,
  onOpenAccount,
  onAddAccount
}) => {
  if (collapsed) return null

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-hairline bg-sidebar p-3.5 select-none">
      <MiniCalendar
        anchorDate={anchorDate}
        occurrences={occurrences}
        firstDayOfWeek={firstDayOfWeek}
        onSelectDate={onSelectDate}
        onPrevMonth={onPrevMonth}
        onNextMonth={onNextMonth}
      />
      <SidebarCalendars
        accounts={accounts}
        calendars={calendars}
        onToggleVisibility={onToggleCalendarVisibility}
        onSetVisibility={onSetCalendarsVisibility}
        onChangeColor={onChangeCalendarColor}
        onOpenAccount={onOpenAccount}
        onAddAccount={onAddAccount}
      />
    </aside>
  )
}

export default AppSidebar
