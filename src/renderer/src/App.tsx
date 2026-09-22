import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { DateTime } from 'luxon'
import type { AppLocale } from '@shared/ipc-contract'
import type { AppSettings } from '@shared/settings-contract'
import type {
  Calendar,
  ExpandedOccurrence,
  CreateEventInput,
  UpdateEventInput,
  RecurringEditScope,
  SyncConflict
} from '@shared/event-model'
import type { CalendarViewType } from '@shared/visible-range'
import { sortForCursor, stepCursor, nudgedRange, resizedRange } from '@shared/keyboard-nav'
import { useVisibleRange } from './hooks/use-visible-range'
import { useTheme } from './hooks/use-theme'
import MonthView from './views/MonthView'
import WeekView from './views/WeekView'
import DayView from './views/DayView'
import YearView from './views/YearView'
import ListView from './views/ListView'
import EventEditorDialog, {
  type EventEditorInitialData,
  type EventEditorDraftPreview
} from './editor/EventEditorDialog'
import RecurringScopeDialog from './editor/RecurringScopeDialog'
import DropActionPopover, { type PendingDropAction } from './dnd/DropActionPopover'
import AccountManagerModal from './components/AccountManagerModal'
import SearchPaletteModal from './components/SearchPaletteModal'
import SettingsPanel, { type SettingsSection } from './components/SettingsPanel'
import KeyboardShortcutsModal from './components/KeyboardShortcutsModal'
import SyncConflictsModal from './components/SyncConflictsModal'
import AppHeader from './components/shell/AppHeader'
import AppSidebar from './components/shell/AppSidebar'
import { useEventDnD } from './dnd/use-event-dnd'
import { singleDayRange } from './dnd/drop-target'
import { NotionToaster, toast, showFriendlyError, isStaleEventError } from './components/ui'
import { DisplayPreferencesProvider, type DisplayPreferences } from './context/DisplayPreferencesContext'

export type { CalendarViewType }

const TIMEZONE_NAMES: string[] = (() => {
  try {
    return (Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf('timeZone') : []
  } catch {
    return []
  }
})()

export const App: React.FC = () => {
  const { t, i18n } = useTranslation()
  const { mode, themeConfig, setThemeConfig, persistMode, loadFromSettings } = useTheme()
  const [currentView, setCurrentView] = useState<CalendarViewType>('week')
  const [anchorDate, setAnchorDate] = useState<DateTime>(() => DateTime.local())
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [appVersion, setAppVersion] = useState<string>('0.1.0')
  const [platform, setPlatform] = useState<string>('win32')
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null)
  const [colorPickerCalId, setColorPickerCalId] = useState<string | null>(null)
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false)
  const [isSearchPaletteOpen, setIsSearchPaletteOpen] = useState(false)
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState(false)
  const [isConflictsModalOpen, setIsConflictsModalOpen] = useState(false)
  const [conflicts, setConflicts] = useState<SyncConflict[]>([])
  const [showLunar, setShowLunar] = useState(true)
  const [showWeekNumbers, setShowWeekNumbers] = useState(true)
  const [showMiniCalendar, setShowMiniCalendar] = useState(false)
  const [autoHideHeader, setAutoHideHeader] = useState(true)
  const [timeFormat, setTimeFormat] = useState<DisplayPreferences['timeFormat']>('24h')
  const [dayStartHour, setDayStartHour] = useState(7)
  const [hourBlockSize, setHourBlockSize] = useState<DisplayPreferences['hourBlockSize']>('medium')
  const [secondaryTimezone, setSecondaryTimezone] = useState<string>('')
  const [suggestionShowCalendarName, setSuggestionShowCalendarName] = useState<boolean>(true)
  const [dragSnapMinutes, setDragSnapMinutes] = useState<AppSettings['dragSnapMinutes']>(15)
  const [headerVisible, setHeaderVisible] = useState(true)
  const headerHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [firstDayOfWeek, setFirstDayOfWeek] = useState(1)

  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [occurrences, setOccurrences] = useState<ExpandedOccurrence[]>([])
  // Which occurrence the keyboard cursor is sitting on. Kept as a pair because
  // an occurrence id is `${eventId}_${originalStartUtc}` - moving a one-off
  // event re-keys it, and the event id is what survives that.
  const [selection, setSelection] = useState<{ occurrenceId: string; eventId: string } | null>(null)

  const [isEditorOpen, setIsEditorOpen] = useState(false)
  const [editorData, setEditorData] = useState<EventEditorInitialData | null>(null)
  // Live slot/color preview for a NEW event while its editor is open - null the rest
  // of the time. A plain useCallback identity so the dialog's effect can depend on
  // it safely without re-firing on every parent render.
  const [draftPreview, setDraftPreview] = useState<EventEditorDraftPreview | null>(null)
  const handleDraftChange = useCallback((draft: EventEditorDraftPreview | null) => {
    setDraftPreview(draft)
  }, [])
  const [pendingRecurringScope, setPendingRecurringScope] = useState<{
    action: 'edit' | 'delete'
    title: string
    eventId: string
    occurrenceStartUtc: string
    input?: UpdateEventInput
  } | null>(null)

  const visibleRange = useVisibleRange(anchorDate, currentView, i18n.language)

  // List view starts with a modest window and grows incrementally as the user
  // scrolls near an edge, instead of always fetching/expanding a huge fixed range.
  const LIST_BASE_DAYS_BEFORE = 14
  const LIST_BASE_DAYS_AFTER = 30
  const LIST_EXPAND_STEP_DAYS = 60
  const [listExpand, setListExpand] = useState({ before: 0, after: 0 })

  useEffect(() => {
    setListExpand({ before: 0, after: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, anchorDate])

  const handleListNearEdge = useCallback((direction: 'past' | 'future') => {
    setListExpand((prev) =>
      direction === 'past'
        ? { ...prev, before: prev.before + LIST_EXPAND_STEP_DAYS }
        : { ...prev, after: prev.after + LIST_EXPAND_STEP_DAYS }
    )
  }, [])

  // Year view scrolls continuously through years either side of the anchor, so
  // the query has to cover the whole mounted span - querying only the anchor
  // year left every scrolled-to year rendering with no event markers at all.
  const [yearSpan, setYearSpan] = useState<{ start: number; end: number } | null>(null)

  useEffect(() => {
    if (currentView !== 'year') setYearSpan(null)
  }, [currentView])

  const handleVisibleYearsChange = useCallback((start: number, end: number) => {
    setYearSpan((prev) => (prev && prev.start === start && prev.end === end ? prev : { start, end }))
  }, [])

  const queryRange = useMemo(() => {
    if (currentView === 'year') {
      if (!yearSpan) return visibleRange
      const start = DateTime.local(yearSpan.start, 1, 1).startOf('day')
      const end = DateTime.local(yearSpan.end, 12, 31).endOf('day')
      return {
        startUtc: start.toUTC().toISO() || start.toISO()!,
        endUtc: end.toUTC().toISO() || end.toISO()!,
        label: visibleRange.label
      }
    }
    if (currentView !== 'list') return visibleRange
    const start = anchorDate.minus({ days: LIST_BASE_DAYS_BEFORE + listExpand.before }).startOf('day')
    const end = anchorDate.plus({ days: LIST_BASE_DAYS_AFTER + listExpand.after }).endOf('day')
    return {
      startUtc: start.toUTC().toISO() || start.toISO()!,
      endUtc: end.toUTC().toISO() || end.toISO()!,
      label: visibleRange.label
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, anchorDate, listExpand, yearSpan, visibleRange.label])

  const loadCalendarsAndEvents = useCallback(async () => {
    if (!window.xrncal?.calendars || !window.xrncal?.events) return

    try {
      const cals = await window.xrncal.calendars.list()
      setCalendars(cals)

      const activeCalIds = cals.filter((c) => c.isVisible).map((c) => c.id)
      if (activeCalIds.length > 0) {
        const occs = await window.xrncal.events.queryRange(
          activeCalIds,
          queryRange.startUtc,
          queryRange.endUtc
        )
        const calColorById = new Map(cals.map((c) => [c.id, c.color]))
        setOccurrences(
          occs.map((occ) => ({ ...occ, color: occ.color || calColorById.get(occ.calendarId) }))
        )
      } else {
        setOccurrences([])
      }
    } catch (err) {
      console.error('Failed to load calendars or events:', err)
    }

    if (window.xrncal?.events?.listConflicts) {
      try {
        setConflicts(await window.xrncal.events.listConflicts())
      } catch (err) {
        console.error('Failed to load sync conflicts:', err)
      }
    }
  }, [queryRange.startUtc, queryRange.endUtc])

  const handleResolveConflict = async (eventId: string, resolution: 'keepMine' | 'keepTheirs') => {
    if (!window.xrncal?.events?.resolveConflict) return
    try {
      await window.xrncal.events.resolveConflict(eventId, resolution)
      setConflicts((prev) => prev.filter((c) => c.eventId !== eventId))
    } catch (err: any) {
      showFriendlyError(err, t('toast.conflictResolveFailed'))
    }
  }

  // A background sync can rewrite the rows under the view - including the id of
  // an event that has just been pushed for the first time, which the provider
  // assigns. Reloading on that signal is what keeps a drag or resize from acting
  // on an occurrence that no longer exists.
  //
  // Never mid-gesture, though. The poll runs every 20s while the window is
  // focused, so reloading the moment the signal arrives yanks the view out from
  // under a drag that is still in the user's hand - the blocks re-render, the
  // occurrence being dragged is replaced, and the drop lands somewhere nobody
  // asked for. Both gesture hooks mark `is-dnd-active` on <body> for exactly as
  // long as a drag or resize is live, so the reload waits for it to clear.
  useEffect(() => {
    if (!window.xrncal?.sync?.onChanged) return

    let pending = false
    const isGestureActive = (): boolean => document.body.classList.contains('is-dnd-active')

    const drain = (): void => {
      if (!pending || isGestureActive()) return
      pending = false
      void loadCalendarsAndEvents()
    }

    // Attribute changes on <body> are the signal that a gesture ended; watching
    // them beats polling for a class that is usually not there.
    const observer = new MutationObserver(drain)
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })

    const unsubscribe = window.xrncal.sync.onChanged(() => {
      pending = true
      drain()
    })

    return () => {
      observer.disconnect()
      unsubscribe()
    }
  }, [loadCalendarsAndEvents])

  const handleDirectMove = useCallback(
    async (
      occ: ExpandedOccurrence,
      targetStart: DateTime,
      targetEnd: DateTime,
      isCopy: boolean,
      /** Undefined keeps the occurrence's current all-day-ness. */
      targetAllDay?: boolean
    ) => {
      if (!window.xrncal?.events) return

      const sourceCal = calendars.find((c) => c.id === occ.calendarId)
      if (sourceCal?.isReadOnly && !isCopy) {
        toast.error(t('toast.readOnlyTitle'), { description: t('toast.readOnlyMove') })
        return
      }

      try {
        if (isCopy) {
          // Drag-copy makes a new event that shares a name and a calendar, not a
          // duplicate: no recurrence, no multi-day span, and none of the
          // original's notes, location or meeting link. Its length is kept.
          const range = singleDayRange(targetStart, targetEnd, dragSnapMinutes)
          await window.xrncal.events.copy({
            sourceEventId: occ.eventId,
            dtStartUtc: range.start.toUTC().toISO()!,
            dtEndUtc: range.end.toUTC().toISO()!,
            targetCalendarId: occ.calendarId,
            copyInstanceOnly: true,
            bare: true,
            // Alt-dragging an all-day event onto the grid has to produce a timed
            // copy too, or the copy keeps its all-day flag with an hour's range.
            allDay: targetAllDay === undefined ? occ.allDay : targetAllDay
          })
        } else if (occ.isRecurring) {
          await window.xrncal.events.updateScope({
            masterEventId: occ.eventId,
            originalStartUtc: occ.originalStartUtc || occ.startUtc,
            scope: 'this',
            updateInput: {
              title: occ.title,
              dtStartUtc: targetStart.toUTC().toISO()!,
              dtEndUtc: targetEnd.toUTC().toISO()!,
              tzid: occ.tzid,
              // Dropping one occurrence of an all-day series onto the hourly grid
              // detaches just that occurrence as a timed event, like Google does.
              allDay: targetAllDay === undefined ? occ.allDay : targetAllDay,
              notes: occ.notes,
              location: occ.location,
              meetingUrl: occ.meetingUrl
            }
          })
        } else {
          await window.xrncal.events.move({
            eventId: occ.eventId,
            dtStartUtc: targetStart.toUTC().toISO()!,
            dtEndUtc: targetEnd.toUTC().toISO()!,
            targetCalendarId: occ.calendarId,
            allDay: targetAllDay === undefined ? occ.allDay : targetAllDay
          })
        }
        await loadCalendarsAndEvents()
      } catch (err: any) {
        // A sync that lands between the drag starting and the drop finishing can
        // re-key the event, so the id in hand is already gone. Refresh instead of
        // blaming the user for a move that was valid when they began it.
        if (isStaleEventError(err)) {
          await loadCalendarsAndEvents()
          toast.error(t('friendly.staleTitle'), { description: t('friendly.staleBody') })
          return
        }
        showFriendlyError(err, t('toast.moveFailed'))
      }
    },
    [calendars, dragSnapMinutes, loadCalendarsAndEvents, t]
  )

  const {
    pendingDrop,
    setPendingDrop,
    draggedOccurrence,
    dropTarget,
    wasJustDragging,
    handleDragStart,
    handleDragEnd,
    handleDragOverTarget,
    handleDropOnDate,
    markPointerBusyEnd
  } = useEventDnD(
    dragSnapMinutes,
    useCallback(
      (
        occ: ExpandedOccurrence,
        start: DateTime,
        end: DateTime,
        isCopy: boolean,
        targetAllDay?: boolean
      ) => void handleDirectMove(occ, start, end, isCopy, targetAllDay),
      [handleDirectMove]
    )
  )

  const handleResizeCommit = useCallback(
    (occ: ExpandedOccurrence, start: DateTime, end: DateTime) => {
      void handleDirectMove(occ, start, end, false)
    },
    [handleDirectMove]
  )

  // Week view drops onto the all-day lane, which turns a timed event into an
  // all-day one - the mirror of dragging an all-day event onto the hourly grid.
  const handleWeekAllDayDrop = useCallback(
    (e: React.DragEvent, targetDate: DateTime) => {
      handleDropOnDate(e, targetDate, undefined, { toAllDayLane: true })
    },
    [handleDropOnDate]
  )

  const openEditorForDate = useCallback(
    (date: DateTime) => {
      if (wasJustDragging()) return
      setEditorData({
        initialStart: date.set({ hour: 9, minute: 0, second: 0 }),
        initialEnd: date.set({ hour: 10, minute: 0, second: 0 })
      })
      setIsEditorOpen(true)
    },
    [wasJustDragging]
  )

  useEffect(() => {
    const initApp = async (): Promise<void> => {
      if (window.xrncal?.app) {
        try {
          const version = await window.xrncal.app.getVersion()
          const plat = await window.xrncal.app.getPlatform()
          setAppVersion(version || '0.1.0')
          setPlatform(plat || 'win32')
        } catch (err) {
          console.warn('IPC init failed, using fallbacks:', err)
        }
      }

      if (window.xrncal?.settings) {
        try {
          const settings = await window.xrncal.settings.getAll()
          setShowLunar(settings.showLunar ?? true)
          setShowWeekNumbers(settings.showWeekNumbers ?? true)
          setShowMiniCalendar(settings.showMiniCalendar ?? false)
          setAutoHideHeader(settings.autoHideHeader ?? true)
          setTimeFormat(settings.timeFormat ?? '24h')
          setDayStartHour(settings.dayStartHour ?? 7)
          setHourBlockSize(settings.hourBlockSize ?? 'medium')
          setSecondaryTimezone(settings.secondaryTimezone ?? '')
          setSuggestionShowCalendarName(settings.suggestionShowCalendarName ?? true)
          setDragSnapMinutes(settings.dragSnapMinutes ?? 15)
          setFirstDayOfWeek(settings.firstDayOfWeek ?? 1)
          const loc = settings.locale === 'vi' || settings.locale === 'en' ? settings.locale : 'en'
          if (loc !== i18n.language) await i18n.changeLanguage(loc)
          if (window.xrncal.app?.setLocale) await window.xrncal.app.setLocale(loc)
        } catch (err) {
          console.warn('Failed to load settings:', err)
        }
      }

      await loadFromSettings()
      await loadCalendarsAndEvents()
    }
    initApp()
  }, [i18n, loadCalendarsAndEvents, loadFromSettings])

  const handleToday = () => setAnchorDate(DateTime.local())

  // Taskbar-style auto-hide: the header only stays up while the pointer is near
  // the top edge or resting on it, and slides away again after a short delay.
  const showHeader = () => {
    if (headerHideTimerRef.current) {
      clearTimeout(headerHideTimerRef.current)
      headerHideTimerRef.current = null
    }
    setHeaderVisible(true)
  }

  const scheduleHideHeader = () => {
    if (headerHideTimerRef.current) clearTimeout(headerHideTimerRef.current)
    headerHideTimerRef.current = setTimeout(() => setHeaderVisible(false), 150)
  }

  useEffect(() => {
    scheduleHideHeader()
    return () => {
      if (headerHideTimerRef.current) clearTimeout(headerHideTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePrev = useCallback(() => {
    switch (currentView) {
      case 'day':
        setAnchorDate((d) => d.minus({ days: 1 }))
        break
      case 'week':
        setAnchorDate((d) => d.minus({ weeks: 1 }))
        break
      case 'month':
      case 'list':
        setAnchorDate((d) => d.minus({ months: 1 }))
        break
      case 'year':
        setAnchorDate((d) => d.minus({ years: 1 }))
        break
    }
  }, [currentView])

  const handleNext = useCallback(() => {
    switch (currentView) {
      case 'day':
        setAnchorDate((d) => d.plus({ days: 1 }))
        break
      case 'week':
        setAnchorDate((d) => d.plus({ weeks: 1 }))
        break
      case 'month':
      case 'list':
        setAnchorDate((d) => d.plus({ months: 1 }))
        break
      case 'year':
        setAnchorDate((d) => d.plus({ years: 1 }))
        break
    }
  }, [currentView])

  const setLanguage = async (next: AppLocale): Promise<void> => {
    if (next === i18n.language) return
    await i18n.changeLanguage(next)
    if (window.xrncal?.settings) await window.xrncal.settings.set('locale', next)
    if (window.xrncal?.app?.setLocale) await window.xrncal.app.setLocale(next)
  }

  const toggleLanguage = () => setLanguage(i18n.language === 'vi' ? 'en' : 'vi')

  const toggleLunar = async (enabled: boolean) => {
    setShowLunar(enabled)
    if (window.xrncal?.settings) await window.xrncal.settings.set('showLunar', enabled)
  }

  const toggleWeekNumbers = async (enabled: boolean) => {
    setShowWeekNumbers(enabled)
    if (window.xrncal?.settings) await window.xrncal.settings.set('showWeekNumbers', enabled)
  }

  const toggleAutoHideHeader = async (enabled: boolean) => {
    setAutoHideHeader(enabled)
    if (!enabled) showHeader()
    if (window.xrncal?.settings) await window.xrncal.settings.set('autoHideHeader', enabled)
  }

  const changeTimeFormat = async (value: DisplayPreferences['timeFormat']) => {
    setTimeFormat(value)
    if (window.xrncal?.settings) await window.xrncal.settings.set('timeFormat', value)
  }

  const changeDayStartHour = async (value: number) => {
    setDayStartHour(value)
    if (window.xrncal?.settings) await window.xrncal.settings.set('dayStartHour', value)
  }

  const changeHourBlockSize = async (value: DisplayPreferences['hourBlockSize']) => {
    setHourBlockSize(value)
    if (window.xrncal?.settings) await window.xrncal.settings.set('hourBlockSize', value)
  }

  const changeSecondaryTimezone = async (value: string) => {
    setSecondaryTimezone(value)
    if (window.xrncal?.settings) await window.xrncal.settings.set('secondaryTimezone', value)
  }

  const changeDragSnapMinutes = async (next: AppSettings['dragSnapMinutes']) => {
    setDragSnapMinutes(next)
    if (window.xrncal?.settings) await window.xrncal.settings.set('dragSnapMinutes', next)
  }

  const toggleSuggestionShowCalendarName = async (next: boolean) => {
    setSuggestionShowCalendarName(next)
    if (window.xrncal?.settings)
      await window.xrncal.settings.set('suggestionShowCalendarName', next)
  }

  const toggleMiniCalendar = useCallback(async (enabled: boolean) => {
    setShowMiniCalendar(enabled)
    if (window.xrncal?.settings) await window.xrncal.settings.set('showMiniCalendar', enabled)
  }, [])

  const toggleCalendarVisibility = async (cal: Calendar) => {
    if (window.xrncal?.calendars) {
      const updated = await window.xrncal.calendars.update(cal.id, { isVisible: !cal.isVisible })
      setCalendars((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
      await loadCalendarsAndEvents()
    }
  }

  const changeCalendarColor = async (cal: Calendar, color: string) => {
    if (!window.xrncal?.calendars) return
    const updated = await window.xrncal.calendars.update(cal.id, { color })
    setCalendars((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
    setColorPickerCalId(null)
    await loadCalendarsAndEvents()
  }

  const handleSaveEditorEvent = async (payload: {
    isNew: boolean
    eventId?: string
    occurrenceStartUtc?: string
    isRecurringOccurrence?: boolean
    input: CreateEventInput | UpdateEventInput
  }) => {
    if (!window.xrncal?.events) return

    try {
      if (payload.isNew) {
        await window.xrncal.events.create(payload.input as CreateEventInput)
        setIsEditorOpen(false)
        await loadCalendarsAndEvents()
      } else if (payload.eventId) {
        if (payload.isRecurringOccurrence && payload.occurrenceStartUtc) {
          setIsEditorOpen(false)
          setPendingRecurringScope({
            action: 'edit',
            title: (payload.input as UpdateEventInput).title || '',
            eventId: payload.eventId,
            occurrenceStartUtc: payload.occurrenceStartUtc,
            input: payload.input as UpdateEventInput
          })
        } else {
          await window.xrncal.events.update(payload.eventId, payload.input as UpdateEventInput)
          setIsEditorOpen(false)
          await loadCalendarsAndEvents()
        }
      }
    } catch (err: any) {
      showFriendlyError(err, t('toast.saveFailed'))
    }
  }

  const handleDeleteEvent = async (
    eventId: string,
    occurrenceStartUtc?: string,
    isRecurring?: boolean,
    /** Middle-click asks for no prompt: the gesture is already the decision. */
    options?: { confirm?: boolean; title?: string }
  ) => {
    if (!window.xrncal?.events) return

    const shouldPrompt = options?.confirm !== false
    const done = async () => {
      setIsEditorOpen(false)
      await loadCalendarsAndEvents()
      // With no confirmation this toast is the only feedback the gesture gives,
      // so it names what went.
    }

    if (isRecurring && occurrenceStartUtc) {
      if (!shouldPrompt) {
        // Middle-clicking picks out one occurrence, so that is what it removes.
        // The scope prompt asks a question the gesture has already answered, and
        // 'this' is both the literal reading and the least destructive one.
        try {
          await window.xrncal.events.deleteScope({
            masterEventId: eventId,
            originalStartUtc: occurrenceStartUtc,
            scope: 'this'
          })
          await done()
        } catch (err: any) {
          showFriendlyError(err, t('toast.deleteFailed'))
        }
        return
      }

      setIsEditorOpen(false)
      setPendingRecurringScope({
        action: 'delete',
        title: '',
        eventId,
        occurrenceStartUtc
      })
      return
    }

    if (shouldPrompt && !confirm(t('toast.confirmDelete'))) return

    try {
      await window.xrncal.events.delete(eventId)
      await done()
    } catch (err: any) {
      showFriendlyError(err, t('toast.deleteFailed'))
    }
  }

  const handleConfirmRecurringScope = async (scope: RecurringEditScope) => {
    if (!pendingRecurringScope || !window.xrncal?.events) return

    try {
      if (pendingRecurringScope.action === 'edit' && pendingRecurringScope.input) {
        await window.xrncal.events.updateScope({
          masterEventId: pendingRecurringScope.eventId,
          originalStartUtc: pendingRecurringScope.occurrenceStartUtc,
          scope,
          updateInput: pendingRecurringScope.input
        })
      } else if (pendingRecurringScope.action === 'delete') {
        await window.xrncal.events.deleteScope({
          masterEventId: pendingRecurringScope.eventId,
          originalStartUtc: pendingRecurringScope.occurrenceStartUtc,
          scope
        })
      }
      setPendingRecurringScope(null)
      await loadCalendarsAndEvents()
    } catch (err: any) {
      showFriendlyError(err, t('toast.recurringUpdateFailed'))
    }
  }

  const handleSelectOccurrence = useCallback(
    (occ: ExpandedOccurrence) => {
      if (wasJustDragging()) return
      setSelection({ occurrenceId: occ.id, eventId: occ.eventId })
      setEditorData({ occurrence: occ })
      setIsEditorOpen(true)
    },
    [wasJustDragging]
  )

  // Week view middle-click gesture: delete the occurrence without opening the editor.
  const handleQuickDeleteOccurrence = useCallback(
    (occ: ExpandedOccurrence) => {
      if (wasJustDragging()) return
      const sourceCal = calendars.find((c) => c.id === occ.calendarId)
      if (sourceCal?.isReadOnly) {
        toast.error(t('toast.readOnlyTitle'), { description: t('toast.readOnlyDelete') })
        return
      }
      void handleDeleteEvent(occ.eventId, occ.originalStartUtc || occ.startUtc, occ.isRecurring, {
        confirm: false,
        title: occ.title
      })
    },
    [calendars, wasJustDragging] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const handleDropMove = async (drop: PendingDropAction) => {
    if (!window.xrncal?.events) return

    const targetCalId = drop.targetCalendarId || drop.occurrence.calendarId
    const targetCal = calendars.find((c) => c.id === targetCalId)
    const sourceCal = calendars.find((c) => c.id === drop.occurrence.calendarId)
    if (sourceCal?.isReadOnly || targetCal?.isReadOnly) {
      toast.error(t('toast.readOnlyTitle'), { description: t('toast.readOnlyMove') })
      setPendingDrop(null)
      return
    }

    try {
      if (drop.occurrence.isRecurring) {
        setPendingDrop(null)
        setPendingRecurringScope({
          action: 'edit',
          title: drop.occurrence.title,
          eventId: drop.occurrence.eventId,
          occurrenceStartUtc: drop.occurrence.originalStartUtc || drop.occurrence.startUtc,
          input: {
            dtStartUtc: drop.targetStart.toUTC().toISO()!,
            dtEndUtc: drop.targetEnd.toUTC().toISO()!,
            title: drop.occurrence.title
          }
        })
        return
      }

      await window.xrncal.events.move({
        eventId: drop.occurrence.eventId,
        dtStartUtc: drop.targetStart.toUTC().toISO()!,
        dtEndUtc: drop.targetEnd.toUTC().toISO()!,
        targetCalendarId: targetCalId
      })
      setPendingDrop(null)
      await loadCalendarsAndEvents()
    } catch (err: any) {
      if (isStaleEventError(err)) {
        await loadCalendarsAndEvents()
        toast.error(t('friendly.staleTitle'), { description: t('friendly.staleBody') })
        setPendingDrop(null)
        return
      }
      showFriendlyError(err, t('toast.moveFailed'))
    }
  }

  const handleDropCopy = async (drop: PendingDropAction, copyInstanceOnly?: boolean) => {
    if (!window.xrncal?.events) return
    try {
      // "Copy whole series" is asking for a duplicate, so it keeps everything.
      // Every other copy is a new event that shares a name: no recurrence, no
      // multi-day span, and none of the original's notes, location or link.
      const bare = copyInstanceOnly === true || !drop.occurrence.isRecurring
      const range = bare
        ? singleDayRange(drop.targetStart, drop.targetEnd, dragSnapMinutes)
        : { start: drop.targetStart, end: drop.targetEnd }

      await window.xrncal.events.copy({
        sourceEventId: drop.occurrence.eventId,
        dtStartUtc: range.start.toUTC().toISO()!,
        dtEndUtc: range.end.toUTC().toISO()!,
        targetCalendarId: drop.targetCalendarId,
        copyInstanceOnly: copyInstanceOnly ?? bare,
        bare
      })
      setPendingDrop(null)
      await loadCalendarsAndEvents()
    } catch (err: any) {
      showFriendlyError(err, t('toast.copyFailed'))
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Keyboard control
  //
  // Everything the mouse can do to an event - open it, delete it, move it,
  // stretch it - needs some way of saying *which* event without pointing at
  // one. That is the cursor: an occurrence drawn with a ring, walked with the
  // up/down arrows, acted on by everything else.
  // ─────────────────────────────────────────────────────────────────────────

  const orderedOccurrences = useMemo(() => sortForCursor(occurrences), [occurrences])

  const selectedOccurrence = useMemo(
    () => occurrences.find((o) => o.id === selection?.occurrenceId) ?? null,
    [occurrences, selection]
  )

  // A reload re-keys occurrences, so a keyboard move changes the very id the
  // cursor is holding: a one-off event's id is built from the start time the
  // move just changed. Re-find it by its event instead of dropping the cursor
  // after every nudge - but only for one-off events. A recurring occurrence is
  // keyed by its *original* start, which a move never touches, so matching one
  // by event id would only ever catch the wrong instance: paging to next week
  // would drag the cursor onto that week's copy of a weekly meeting.
  useEffect(() => {
    setSelection((prev) => {
      if (!prev) return prev
      if (occurrences.some((o) => o.id === prev.occurrenceId)) return prev
      const sameEvent = occurrences.filter((o) => o.eventId === prev.eventId && !o.isRecurring)
      return sameEvent.length === 1
        ? { occurrenceId: sameEvent[0].id, eventId: prev.eventId }
        : null
    })
  }, [occurrences])

  // Keep the cursor on screen: Week and Day scroll a 24-hour grid, List scrolls
  // weeks of events. One query from up here beats a ref in every view.
  useEffect(() => {
    if (!selection) return
    const frame = requestAnimationFrame(() => {
      document
        .querySelector('[data-selected-occurrence]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [selection, currentView])

  const moveCursor = useCallback(
    (direction: 1 | -1) => {
      const next = stepCursor(
        orderedOccurrences,
        selection?.occurrenceId ?? null,
        direction,
        anchorDate.toFormat('yyyy-MM-dd')
      )
      if (next) setSelection({ occurrenceId: next.id, eventId: next.eventId })
    },
    [orderedOccurrences, selection, anchorDate]
  )

  // Shift/Alt + arrows go through the same commit path as a drag or an
  // edge-resize, so read-only calendars, recurring scope and stale-id recovery
  // all behave exactly as they do with a mouse.
  const nudgeSelected = useCallback(
    (delta: { days?: number; minutes?: number }, mode: 'move' | 'resize') => {
      if (!selectedOccurrence) return
      const range =
        mode === 'move'
          ? nudgedRange(selectedOccurrence, delta)
          : resizedRange(selectedOccurrence, delta.minutes ?? 0, dragSnapMinutes)
      if (!range) return
      void handleDirectMove(selectedOccurrence, range.start, range.end, false)
    },
    [selectedOccurrence, dragSnapMinutes, handleDirectMove]
  )

  const deleteSelected = useCallback(() => {
    if (!selectedOccurrence) return
    const cal = calendars.find((c) => c.id === selectedOccurrence.calendarId)
    if (cal?.isReadOnly) {
      toast.error(t('toast.readOnlyTitle'), { description: t('toast.readOnlyDelete') })
      return
    }
    void handleDeleteEvent(
      selectedOccurrence.eventId,
      selectedOccurrence.originalStartUtc || selectedOccurrence.startUtc,
      selectedOccurrence.isRecurring
    )
  }, [selectedOccurrence, calendars]) // eslint-disable-line react-hooks/exhaustive-deps

  const syncNow = useCallback(async () => {
    if (!window.xrncal?.sync?.triggerNow) return
    try {
      const res = await window.xrncal.sync.triggerNow()
      await loadCalendarsAndEvents()
      toast.success(t('toast.syncDone'), { description: res.message || undefined })
    } catch (err) {
      showFriendlyError(err, t('toast.syncFailed'))
    }
  }, [loadCalendarsAndEvents, t])

  // A layer above the calendar is taking keys: a bare letter must not reach
  // through a dialog and switch the view behind it.
  const isOverlayOpen =
    isEditorOpen ||
    isSettingsOpen ||
    isAccountModalOpen ||
    isShortcutsModalOpen ||
    isConflictsModalOpen ||
    isSearchPaletteOpen ||
    Boolean(pendingRecurringScope) ||
    Boolean(pendingDrop)

  // These three close themselves on Escape. Handling it here as well would
  // close two layers with one press.
  const ownsEscape = isEditorOpen || isSearchPaletteOpen || Boolean(pendingDrop)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isInput =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        if (isOverlayOpen && !isSearchPaletteOpen) return
        e.preventDefault()
        setIsSearchPaletteOpen((prev) => !prev)
        return
      }

      if (e.key === 'Escape') {
        if (ownsEscape) return
        e.preventDefault()
        if (pendingRecurringScope) setPendingRecurringScope(null)
        else if (isShortcutsModalOpen) setIsShortcutsModalOpen(false)
        else if (isConflictsModalOpen) setIsConflictsModalOpen(false)
        else if (isAccountModalOpen) setIsAccountModalOpen(false)
        else if (isSettingsOpen) setIsSettingsOpen(false)
        else setSelection(null)
        return
      }

      if (isInput || isOverlayOpen) return

      // Enter and Space belong to whatever control has focus. Claiming them
      // here would stop Tab + Enter from pressing a button, which is the other
      // half of getting around without a mouse.
      if (
        (e.key === 'Enter' || e.key === ' ') &&
        target &&
        ['BUTTON', 'A', 'SELECT'].includes(target.tagName)
      ) {
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        // With the mini calendar switched off there is no sidebar to collapse,
        // so the first press is what puts one there rather than doing nothing.
        if (showMiniCalendar) setSidebarCollapsed((v) => !v)
        else {
          setSidebarCollapsed(false)
          void toggleMiniCalendar(true)
        }
        return
      }
      // Anything else held with Ctrl/Cmd belongs to Electron (reload, quit…).
      if (e.ctrlKey || e.metaKey) return

      // Shift/Alt + arrows act on the event under the cursor rather than on the
      // cursor itself: Shift moves it, Alt stretches its end.
      if (selectedOccurrence && (e.shiftKey || e.altKey) && e.key.startsWith('Arrow')) {
        const isResize = e.altKey && !e.shiftKey
        let handled = true
        switch (e.key) {
          case 'ArrowUp':
            nudgeSelected({ minutes: -dragSnapMinutes }, isResize ? 'resize' : 'move')
            break
          case 'ArrowDown':
            nudgeSelected({ minutes: dragSnapMinutes }, isResize ? 'resize' : 'move')
            break
          case 'ArrowLeft':
            if (isResize) handled = false
            else nudgeSelected({ days: -1 }, 'move')
            break
          case 'ArrowRight':
            if (isResize) handled = false
            else nudgeSelected({ days: 1 }, 'move')
            break
          default:
            handled = false
        }
        if (handled) {
          e.preventDefault()
          return
        }
      }

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key

      switch (key) {
        // Time
        case 't':
          setAnchorDate(DateTime.local())
          break
        case 'k':
        case 'ArrowLeft':
        case 'PageUp':
          handlePrev()
          break
        case 'j':
        case 'ArrowRight':
        case 'PageDown':
          handleNext()
          break

        // The cursor. Year view draws no events, so there is nothing to walk.
        case 'ArrowDown':
          if (currentView === 'year') return
          moveCursor(1)
          break
        case 'ArrowUp':
          if (currentView === 'year') return
          moveCursor(-1)
          break
        case 'Enter':
          if (selectedOccurrence) handleSelectOccurrence(selectedOccurrence)
          else openEditorForDate(anchorDate)
          break
        case 'Delete':
        case 'Backspace':
          if (!selectedOccurrence) return
          deleteSelected()
          break

        // Views
        case '1':
        case 'd':
          setCurrentView('day')
          break
        case '2':
        case 'w':
          setCurrentView('week')
          break
        case '3':
        case 'm':
          setCurrentView('month')
          break
        case '4':
        case 'y':
          setCurrentView('year')
          break
        case '5':
        case 'l':
          setCurrentView('list')
          break

        // Actions
        case 'n':
        case 'c':
          openEditorForDate(anchorDate)
          break
        case '/':
          setIsSearchPaletteOpen(true)
          break
        case '?':
        case 'F1':
          setIsShortcutsModalOpen((prev) => !prev)
          break
        case ',':
          setSettingsSection(null)
          setIsSettingsOpen(true)
          break
        case 'r':
          void syncNow()
          break
        default:
          return
      }
      e.preventDefault()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    anchorDate,
    currentView,
    deleteSelected,
    dragSnapMinutes,
    handleNext,
    handlePrev,
    handleSelectOccurrence,
    isAccountModalOpen,
    isConflictsModalOpen,
    isOverlayOpen,
    isSearchPaletteOpen,
    isSettingsOpen,
    isShortcutsModalOpen,
    moveCursor,
    nudgeSelected,
    openEditorForDate,
    ownsEscape,
    pendingRecurringScope,
    selectedOccurrence,
    showMiniCalendar,
    syncNow,
    toggleMiniCalendar
  ])

  return (
    <DisplayPreferencesProvider value={{
        timeFormat,
        hourBlockSize,
        dayStartHour,
        secondaryTimezone,
        suggestionShowCalendarName,
        dragSnapMinutes
      }}>
    <div
      className="relative flex h-screen w-screen flex-col overflow-hidden bg-app font-sans text-primary select-none"
      style={
        {
          '--accent-color': themeConfig.accentColor,
          '--color-accent-mark': themeConfig.accentColor
        } as React.CSSProperties
      }
    >
      {themeConfig.customBgUrl && (
        <>
          <div
            className="pointer-events-none fixed inset-0 z-0 scale-105 bg-cover bg-center"
            style={{
              backgroundImage: `url(${themeConfig.customBgUrl})`,
              filter: `blur(${themeConfig.bgBlur}px)`
            }}
          />
          <div
            className="pointer-events-none fixed inset-0 z-0"
            style={{
              background: 'var(--gc-overlay-color)',
              opacity: themeConfig.bgOverlayOpacity
            }}
          />
        </>
      )}

      {(() => {
          const header = (
            <AppHeader
              title={currentView === 'week' ? '' : visibleRange.label}
              currentView={currentView}
              showSidebarToggle={showMiniCalendar}
              onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
              onPrev={handlePrev}
              onNext={handleNext}
              onChangeView={setCurrentView}
              onSearch={() => setIsSearchPaletteOpen(true)}
              onOpenMenu={() => {
                setSettingsSection(null)
                setIsSettingsOpen(true)
              }}
              conflictCount={conflicts.length}
            />
          )

          if (!autoHideHeader) {
            // Plain, always-visible header - no collapse machinery.
            return <div className="shrink-0">{header}</div>
          }

          return (
            <>
              {/* Thin hotspot at the very top edge - catches the pointer re-entering
                  while the header is collapsed away, taskbar-style. */}
              <div className="fixed inset-x-0 top-0 z-20 h-1.5" onMouseEnter={showHeader} />

              {/* Push-based collapse (not an overlay) - the header's own box shrinks to
                  0, so the calendar content underneath slides down/up with it instead of
                  ever being covered. Overflow only clips while collapsed/collapsing -
                  once expanded it switches to visible so the view-switcher and overflow
                  menu dropdowns (which extend below the 48px bar) aren't cut off. */}
              <div
                className={`shrink-0 transition-[max-height] duration-100 ease-out ${
                  headerVisible ? 'overflow-visible' : 'overflow-hidden'
                }`}
                style={{ maxHeight: headerVisible ? '48px' : '0px' }}
                onMouseEnter={showHeader}
                onMouseLeave={scheduleHideHeader}
              >
                {header}
              </div>
            </>
          )
        })()}

      <div className="z-10 flex min-h-0 flex-1 overflow-hidden">
        {showMiniCalendar && (
          <AppSidebar
            collapsed={sidebarCollapsed}
            anchorDate={anchorDate}
            occurrences={occurrences}
            firstDayOfWeek={firstDayOfWeek}
            onSelectDate={setAnchorDate}
            onPrevMonth={() => setAnchorDate((d) => d.minus({ months: 1 }))}
            onNextMonth={() => setAnchorDate((d) => d.plus({ months: 1 }))}
          />
        )}

        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">

          {currentView === 'month' && (
            <MonthView
              anchorDate={anchorDate}
              occurrences={occurrences}
              showLunar={showLunar}
              showWeekNumbers={showWeekNumbers}
              onSelectDate={openEditorForDate}
              onSelectOccurrence={handleSelectOccurrence}
              draggedOccurrenceId={draggedOccurrence?.id}
              selectedOccurrenceId={selection?.occurrenceId}
              dropTarget={dropTarget}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOverTarget={handleDragOverTarget}
              onDropOnDate={handleDropOnDate}
            />
          )}

          {currentView === 'week' && (
            <WeekView
              anchorDate={anchorDate}
              occurrences={occurrences}
              showLunar={showLunar}
              showWeekNumbers={showWeekNumbers}
              previewSlot={draftPreview}
              onSelectSlot={(start, end, meta) => {
                if (wasJustDragging()) return
                setEditorData({
                  initialStart: start,
                  initialEnd: end,
                  initialAllDay: meta?.allDay,
                  initialClientX: meta?.clientX
                })
                setIsEditorOpen(true)
              }}
              onSelectOccurrence={handleSelectOccurrence}
              onDeleteOccurrence={handleQuickDeleteOccurrence}
              onGoToday={handleToday}
              onPrevWeek={handlePrev}
              onNextWeek={handleNext}
              draggedOccurrenceId={draggedOccurrence?.id}
              selectedOccurrenceId={selection?.occurrenceId}
              dropTarget={dropTarget}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOverTarget={handleDragOverTarget}
              onDropOnDate={handleDropOnDate}
              onDropOnAllDayLane={handleWeekAllDayDrop}
              onResizeCommit={handleResizeCommit}
              onResizeBusyEnd={markPointerBusyEnd}
            />
          )}

          {currentView === 'day' && (
            <DayView
              anchorDate={anchorDate}
              occurrences={occurrences}
              showLunar={showLunar}
              previewSlot={draftPreview}
              onSelectSlot={(start, end, meta) => {
                if (wasJustDragging()) return
                setEditorData({
                  initialStart: start,
                  initialEnd: end,
                  initialAllDay: meta?.allDay,
                  initialClientX: meta?.clientX
                })
                setIsEditorOpen(true)
              }}
              onSelectOccurrence={handleSelectOccurrence}
              draggedOccurrenceId={draggedOccurrence?.id}
              selectedOccurrenceId={selection?.occurrenceId}
              dropTarget={dropTarget}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOverTarget={handleDragOverTarget}
              onDropOnDate={handleDropOnDate}
              onResizeCommit={handleResizeCommit}
              onResizeBusyEnd={markPointerBusyEnd}
            />
          )}

          {currentView === 'year' && (
            <YearView
              anchorDate={anchorDate}
              occurrences={occurrences}
              showLunar={showLunar}
              onVisibleYearsChange={handleVisibleYearsChange}
              onSelectMonth={(year, month) => {
                setAnchorDate((d) => d.set({ year, month, day: 1 }))
                setCurrentView('month')
              }}
              onSelectDate={(date) => {
                setAnchorDate(date)
                setCurrentView('day')
              }}
            />
          )}

          {currentView === 'list' && (
            <ListView
              anchorDate={anchorDate}
              occurrences={occurrences}
              showLunar={showLunar}
              selectedOccurrenceId={selection?.occurrenceId}
              onSelectOccurrence={handleSelectOccurrence}
              onAddEvent={() => openEditorForDate(anchorDate)}
              onNearEdge={handleListNearEdge}
            />
          )}
        </main>
      </div>

      <SearchPaletteModal
        isOpen={isSearchPaletteOpen}
        onClose={() => setIsSearchPaletteOpen(false)}
        calendars={calendars}
        onSelectEvent={(event, targetDate) => {
          setAnchorDate(DateTime.fromISO(targetDate))
          setEditorData({ event })
          setIsEditorOpen(true)
        }}
      />

      <KeyboardShortcutsModal
        isOpen={isShortcutsModalOpen}
        onClose={() => setIsShortcutsModalOpen(false)}
      />

      <SyncConflictsModal
        isOpen={isConflictsModalOpen}
        conflicts={conflicts}
        onClose={() => setIsConflictsModalOpen(false)}
        onResolve={handleResolveConflict}
      />

      <EventEditorDialog
        isOpen={isEditorOpen}
        calendars={calendars}
        data={editorData}
        onSave={handleSaveEditorEvent}
        onDelete={handleDeleteEvent}
        onDataChanged={loadCalendarsAndEvents}
        onClose={() => setIsEditorOpen(false)}
        onDraftChange={handleDraftChange}
      />

      <RecurringScopeDialog
        isOpen={Boolean(pendingRecurringScope)}
        title={pendingRecurringScope?.title || ''}
        action={pendingRecurringScope?.action || 'edit'}
        onConfirm={handleConfirmRecurringScope}
        onCancel={() => setPendingRecurringScope(null)}
      />

      <DropActionPopover
        pendingDrop={pendingDrop}
        onMove={handleDropMove}
        onCopy={handleDropCopy}
        onCancel={() => setPendingDrop(null)}
      />

      <AccountManagerModal
        isOpen={isAccountModalOpen}
        onClose={() => setIsAccountModalOpen(false)}
        onAccountsChanged={() => loadCalendarsAndEvents()}
      />

      <SettingsPanel
        isOpen={isSettingsOpen}
        section={settingsSection}
        onSectionChange={setSettingsSection}
        onClose={() => setIsSettingsOpen(false)}
        language={i18n.language}
        onToggleLanguage={toggleLanguage}
        showLunar={showLunar}
        onToggleLunar={toggleLunar}
        showWeekNumbers={showWeekNumbers}
        onToggleWeekNumbers={toggleWeekNumbers}
        showMiniCalendar={showMiniCalendar}
        onToggleMiniCalendar={toggleMiniCalendar}
        timeFormat={timeFormat}
        onChangeTimeFormat={changeTimeFormat}
        themeMode={mode}
        onSetThemeMode={persistMode}
        onThemeChanged={setThemeConfig}
        dayStartHour={dayStartHour}
        onChangeDayStartHour={changeDayStartHour}
        hourBlockSize={hourBlockSize}
        onChangeHourBlockSize={changeHourBlockSize}
        secondaryTimezone={secondaryTimezone}
        onChangeSecondaryTimezone={changeSecondaryTimezone}
        suggestionShowCalendarName={suggestionShowCalendarName}
        onToggleSuggestionShowCalendarName={toggleSuggestionShowCalendarName}
        dragSnapMinutes={dragSnapMinutes}
        onChangeDragSnapMinutes={changeDragSnapMinutes}
        timezoneNames={TIMEZONE_NAMES}
        autoHideHeader={autoHideHeader}
        onToggleAutoHideHeader={toggleAutoHideHeader}
        calendars={calendars}
        colorPickerCalId={colorPickerCalId}
        onColorPickerToggle={setColorPickerCalId}
        onToggleCalendarVisibility={toggleCalendarVisibility}
        onChangeCalendarColor={changeCalendarColor}
        onCalendarsChanged={loadCalendarsAndEvents}
        onManageAccounts={() => {
          setIsSettingsOpen(false)
          setIsAccountModalOpen(true)
        }}
        onOpenShortcuts={() => setIsShortcutsModalOpen(true)}
        conflictCount={conflicts.length}
        onOpenConflicts={() => setIsConflictsModalOpen(true)}
        appVersion={appVersion}
        platform={platform}
      />

      <NotionToaster />
    </div>
    </DisplayPreferencesProvider>
  )
}

export default App
