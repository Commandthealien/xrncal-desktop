import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { DateTime, IANAZone } from 'luxon'
import { Trash2, X, Share2, MapPin, Link as LinkIcon, Users, Check } from 'lucide-react'
import type {
  Calendar,
  CalendarEvent,
  ExpandedOccurrence,
  Attendee,
  CreateEventInput,
  UpdateEventInput,
  LunarRecurrenceSpec,
  RsvpResponse
} from '@shared/event-model'
import { invitationSelf } from '@shared/event-model'
import type { TitleSuggestion } from '@shared/title-suggestions'
import { endDateForTimes, formatClockTime } from '@shared/time-format'
import { convertSolarToLunar, resolveLunarOccurrence } from '@shared/lunar-vietnam'
import { DEFAULT_EVENT_COLOR } from '@shared/mini-calendar-grid'
import { EVENT_COLORS } from '@shared/event-colors'
import {
  effectiveReminders,
  LUNAR_ANNIVERSARY_REMINDER,
  type EventReminder
} from '@shared/reminders'
import {
  DatePicker,
  TimePicker,
  CustomSelect,
  TextInput,
  NumberInput,
  ToggleSwitch,
  FormRow,
  TextArea,
  toast,
  showFriendlyError
} from '../components/ui'
import { TitleSuggestInput } from './TitleSuggestInput'
import { ReminderListField } from './ReminderListField'
import { useDisplayPreferences } from '../context/DisplayPreferencesContext'
import { zoneLabel, zoneOptions } from '../lib/time-zones'

export interface EventEditorInitialData {
  occurrence?: ExpandedOccurrence
  event?: CalendarEvent
  initialStart?: DateTime
  initialEnd?: DateTime
  initialCalendarId?: string
  /** Slot was picked from the all-day row — default the new event to all-day. */
  initialAllDay?: boolean
  /** Viewport X of the click that started creation — used to dock the dialog on the opposite side. */
  initialClientX?: number
}

/** Live snapshot of a not-yet-saved new event, so the calendar behind the dialog can
 *  paint a preview at the exact slot/color the form currently holds. */
export interface EventEditorDraftPreview {
  start: DateTime
  end: DateTime
  allDay: boolean
  color: string
  title: string
}

interface EventEditorDialogProps {
  isOpen: boolean
  calendars: Calendar[]
  data: EventEditorInitialData | null
  onSave: (payload: {
    isNew: boolean
    eventId?: string
    occurrenceStartUtc?: string
    isRecurringOccurrence?: boolean
    input: CreateEventInput | UpdateEventInput
  }) => void
  onDelete: (eventId: string, occurrenceStartUtc?: string, isRecurring?: boolean) => void
  onDataChanged?: () => void
  onClose: () => void
  /** Fired whenever the draft's slot/color changes while creating a NEW event (null
   *  once it's no longer relevant - editing, closed, or the fields don't parse yet). */
  onDraftChange?: (draft: EventEditorDraftPreview | null) => void
}

const LUNAR_MONTHS = [
  '', 'Giêng', 'Hai', 'Ba', 'Tư', 'Năm', 'Sáu',
  'Bảy', 'Tám', 'Chín', 'Mười', 'Mười một', 'Chạp'
]

const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
const RRULE_KNOWN_KEYS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL'])

function parseRruleParts(rrule: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of rrule.split(';')) {
    const [key, val] = part.split('=')
    if (key && val !== undefined) out[key] = val
  }
  return out
}

/** True when the rrule only uses controls the friendly editor understands (no BYMONTHDAY etc.). */
function isSimpleRrule(rrule: string): boolean {
  return rrule.split(';').every((part) => RRULE_KNOWN_KEYS.has(part.split('=')[0]))
}

function toggleWeekday(days: string[], code: string): string[] {
  return days.includes(code) ? days.filter((d) => d !== code) : [...days, code]
}

/** The zone an event's times are typed in: its own, or this machine's for one luxon does not know. */
function editZone(tzid: string | undefined): string {
  return tzid && IANAZone.isValidZone(tzid) ? tzid : 'local'
}

/** A colour dot to pick; the chosen one carries a tick, as buttons cannot show an outline. */
const ColorSwatch: React.FC<{ hex: string; selected: boolean; label: string; onClick: () => void }> = ({
  hex,
  selected,
  label,
  onClick
}) => (
  <button
    type="button"
    onClick={onClick}
    className="gc-focus-ring flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-110"
    style={{ backgroundColor: hex }}
    title={label}
    aria-label={label}
    aria-pressed={selected}
  >
    {selected && <Check className="h-3 w-3 stroke-[3.5] text-white" />}
  </button>
)

export const EventEditorDialog: React.FC<EventEditorDialogProps> = ({
  isOpen,
  calendars,
  data,
  onSave,
  onDelete,
  onDataChanged,
  onClose,
  onDraftChange
}) => {
  const { t, i18n } = useTranslation()
  const { defaultReminderMinutes, defaultAllDayReminderMinutes, timeFormat } = useDisplayPreferences()
  const isEditing = Boolean(data?.occurrence || data?.event)
  // Lunar anniversaries have no per-instance RRULE semantics — edits always apply
  // to the whole series, so they skip the recurring-scope prompt.
  const isRecurringOccurrence = Boolean(
    data?.occurrence?.isRecurring && !data?.occurrence?.isLunar
  )

  // Form states (location / notes / meetingUrl / attendees / tzid / color are kept
  // so edits to synced events preserve those fields, but they are not shown in the UI)
  const [calendarId, setCalendarId] = useState<string>('')
  const [title, setTitle] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const [location, setLocation] = useState<string>('')
  const [meetingUrl, setMeetingUrl] = useState<string>('')
  const [color, setColor] = useState<string>('')
  const [allDay, setAllDay] = useState<boolean>(false)
  const [tzid, setTzid] = useState<string>('UTC')

  const [startDateStr, setStartDateStr] = useState<string>('')
  const [startTimeStr, setStartTimeStr] = useState<string>('09:00')
  const [endDateStr, setEndDateStr] = useState<string>('')
  const [endTimeStr, setEndTimeStr] = useState<string>('10:00')

  const [recurrencePreset, setRecurrencePreset] = useState<string>('none')
  const [customRrule, setCustomRrule] = useState<string>('')
  const [recurrenceInterval, setRecurrenceInterval] = useState<number>(1)
  const [recurrenceByDay, setRecurrenceByDay] = useState<string[]>([])
  const [recurrenceEnd, setRecurrenceEnd] = useState<'never' | 'onDate' | 'afterCount'>('never')
  const [recurrenceUntil, setRecurrenceUntil] = useState<string>('')
  const [recurrenceCount, setRecurrenceCount] = useState<number>(10)
  const [lunarLeap, setLunarLeap] = useState<boolean>(false)
  const [lunarBusy, setLunarBusy] = useState<boolean>(false)
  const [materializeTargetId, setMaterializeTargetId] = useState<string>('')

  const [attendees, setAttendees] = useState<Attendee[]>([])
  const [attendeeInput, setAttendeeInput] = useState<string>('')
  // An occurrence carries no guest list, so one opened from the grid has to
  // load its event first. Until it has, the editor must not send attendees at
  // all: it used to send the empty list it started with, and saving any event
  // opened from the grid deleted its guests.
  const [attendeesLoaded, setAttendeesLoaded] = useState<boolean>(true)
  const attendeesTouchedRef = useRef(false)

  // null: the event follows the default reminders.
  const [reminders, setReminders] = useState<EventReminder[] | null>(null)
  const [remindersTouched, setRemindersTouched] = useState<boolean>(false)
  const remindersTouchedRef = useRef(false)
  const [rsvpBusy, setRsvpBusy] = useState(false)

  const [isDirty, setIsDirty] = useState<boolean>(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState<boolean>(false)
  const [shareSuccess, setShareSuccess] = useState<boolean>(false)

  useEffect(() => {
    if (!isOpen) return

    setIsDirty(false)
    setShowDiscardConfirm(false)
    setShareSuccess(false)
    setRemindersTouched(false)
    remindersTouchedRef.current = false
    attendeesTouchedRef.current = false

    const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    setTzid(userTz)

    if (data?.occurrence) {
      const occ = data.occurrence
      setTitle(occ.title)
      setNotes(occ.notes || '')
      setLocation(occ.location || '')
      setMeetingUrl(occ.meetingUrl || '')
      // The grid hands over occurrences coloured with their calendar's colour
      // when they have none of their own; keeping that would save it onto the
      // event, which then no longer followed its calendar.
      const calendarColor = calendars.find((c) => c.id === occ.calendarId)?.color
      setColor(occ.color && occ.color.toLowerCase() !== calendarColor?.toLowerCase() ? occ.color : '')
      setCalendarId(occ.calendarId)
      setAllDay(occ.allDay)
      setTzid(occ.tzid || userTz)
      setAttendees([])
      setAttendeesLoaded(false)
      setReminders(null)

      // Timed: the clock in the event's own zone. All-day: the stored UTC
      // date - read in this machine's zone it was the day before west of UTC,
      // and saving it moved the event back a day.
      const shownIn = occ.allDay || occ.isLunar ? 'utc' : editZone(occ.tzid || userTz)
      const startLocal = DateTime.fromISO(occ.startUtc, { zone: 'utc' }).setZone(shownIn)
      const endLocal = DateTime.fromISO(occ.endUtc, { zone: 'utc' }).setZone(shownIn)

      setStartDateStr(startLocal.toFormat('yyyy-MM-dd'))
      setStartTimeStr(startLocal.toFormat('HH:mm'))
      setEndDateStr(endLocal.toFormat('yyyy-MM-dd'))
      setEndTimeStr(endLocal.toFormat('HH:mm'))

      if (occ.isLunar) {
        setRecurrencePreset('lunar-yearly')
        setAllDay(true)
        const l = convertSolarToLunar(startLocal.day, startLocal.month, startLocal.year)
        setLunarLeap(l.leap)
      } else {
        setRecurrencePreset(occ.isRecurring ? 'custom' : 'none')
      }
    } else if (data?.event) {
      const evt = data.event
      setTitle(evt.title)
      setNotes(evt.notes || '')
      setLocation(evt.location || '')
      setMeetingUrl(evt.meetingUrl || '')
      setColor(evt.color || '')
      setCalendarId(evt.calendarId)
      setAllDay(evt.allDay)
      setTzid(evt.tzid || userTz)
      // An event handed over without its guest list has it read, like an
      // occurrence's, before a save may send guests.
      setAttendees(evt.attendees || [])
      setAttendeesLoaded(evt.attendees !== undefined)
      setReminders(evt.reminders ?? null)

      const shownIn = evt.allDay || evt.lunarRule ? 'utc' : editZone(evt.tzid || userTz)
      const startLocal = DateTime.fromISO(evt.dtStartUtc, { zone: 'utc' }).setZone(shownIn)
      const endLocal = DateTime.fromISO(evt.dtEndUtc, { zone: 'utc' }).setZone(shownIn)

      setStartDateStr(startLocal.toFormat('yyyy-MM-dd'))
      setStartTimeStr(startLocal.toFormat('HH:mm'))
      setEndDateStr(endLocal.toFormat('yyyy-MM-dd'))
      setEndTimeStr(endLocal.toFormat('HH:mm'))

      if (evt.lunarRule) {
        setRecurrencePreset('lunar-yearly')
        setLunarLeap(evt.lunarRule.leap)
        setAllDay(true)
        setCustomRrule('')
      } else if (evt.rrule) {
        setCustomRrule(evt.rrule)
        const parts = parseRruleParts(evt.rrule)
        const simple = isSimpleRrule(evt.rrule)
        if (simple && parts.FREQ === 'DAILY') setRecurrencePreset('daily')
        else if (simple && parts.FREQ === 'WEEKLY') setRecurrencePreset('weekly')
        else if (simple && parts.FREQ === 'MONTHLY') setRecurrencePreset('monthly')
        else if (simple && parts.FREQ === 'YEARLY') setRecurrencePreset('yearly')
        else setRecurrencePreset('custom')

        setRecurrenceInterval(parts.INTERVAL ? Math.max(1, parseInt(parts.INTERVAL, 10) || 1) : 1)
        setRecurrenceByDay(parts.BYDAY ? parts.BYDAY.split(',') : [])
        if (parts.UNTIL) {
          const untilLocal = DateTime.fromFormat(parts.UNTIL, "yyyyMMdd'T'HHmmss'Z'", {
            zone: 'utc'
          }).setZone(shownIn)
          setRecurrenceEnd('onDate')
          setRecurrenceUntil(untilLocal.isValid ? untilLocal.toFormat('yyyy-MM-dd') : '')
          setRecurrenceCount(10)
        } else if (parts.COUNT) {
          setRecurrenceEnd('afterCount')
          setRecurrenceCount(Math.max(1, parseInt(parts.COUNT, 10) || 10))
          setRecurrenceUntil('')
        } else {
          setRecurrenceEnd('never')
          setRecurrenceUntil('')
          setRecurrenceCount(10)
        }
      } else {
        setRecurrencePreset('none')
        setCustomRrule('')
        setRecurrenceInterval(1)
        setRecurrenceByDay([])
        setRecurrenceEnd('never')
        setRecurrenceUntil('')
        setRecurrenceCount(10)
      }
    } else {
      const defaultCal = calendars.find((c) => !c.isReadOnly) || calendars[0]
      setCalendarId(data?.initialCalendarId || defaultCal?.id || '')
      setTitle('')
      setNotes('')
      setLocation('')
      setMeetingUrl('')
      setColor('')
      setAllDay(Boolean(data?.initialAllDay))
      setRecurrencePreset('none')
      setCustomRrule('')
      setRecurrenceInterval(1)
      setRecurrenceByDay([])
      setRecurrenceEnd('never')
      setRecurrenceUntil('')
      setRecurrenceCount(10)
      setAttendees([])
      setAttendeesLoaded(true)
      setReminders(null)

      const start = data?.initialStart || DateTime.local().set({ hour: 9, minute: 0, second: 0 })
      const end = data?.initialEnd || start.plus({ hours: 1 })

      setStartDateStr(start.toFormat('yyyy-MM-dd'))
      setStartTimeStr(start.toFormat('HH:mm'))
      setEndDateStr(end.toFormat('yyyy-MM-dd'))
      setEndTimeStr(end.toFormat('HH:mm'))
    }
  }, [isOpen, data, calendars])

  // The rest of an event opened from the grid (or handed over without its
  // guest list): its guests and reminders.
  useEffect(() => {
    const eventId = data?.occurrence?.eventId ?? (data?.event?.attendees === undefined ? data?.event?.id : undefined)
    if (!isOpen || !eventId || !window.xrncal?.events?.getById) return
    let cancelled = false
    window.xrncal.events
      .getById(eventId)
      .then((res) => {
        if (cancelled || !res) return
        // Guests typed in before the list arrived are added to it, not
        // swapped for it.
        const loaded = res.event.attendees || []
        setAttendees((typed) =>
          attendeesTouchedRef.current
            ? [...loaded, ...typed.filter((a) => !loaded.some((l) => l.email.toLowerCase() === a.email.toLowerCase()))]
            : loaded
        )
        if (!remindersTouchedRef.current) setReminders(res.event.reminders ?? null)
        setAttendeesLoaded(true)
      })
      .catch(() => {
        // Attendees stay unloaded, so a save leaves them as they are.
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, data])

  // The key handler has to be installed above the `isOpen` early return, like
  // every other hook - but the actions it fires are defined below it, where the
  // form's derived values live. These refs are refreshed on each open render and
  // are the handler's way of reaching them.
  const submitRef = useRef<() => void>(() => {})
  const deleteRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A picker popover stops its own Escape from reaching this handler, so
        // arriving here means nothing smaller is open.
        if (showDiscardConfirm) setShowDiscardConfirm(false)
        else if (isDirty) setShowDiscardConfirm(true)
        else onClose()
        return
      }

      // Everything else is behind Ctrl/Cmd: the form is full of text fields,
      // and a bare letter belongs to whichever one has focus.
      if (!(e.ctrlKey || e.metaKey) || showDiscardConfirm) return

      if (e.key === 'Enter') {
        e.preventDefault()
        submitRef.current()
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        deleteRef.current()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isDirty, showDiscardConfirm, onClose])

  /**
   * The slot the title suggestions are being asked about, in the same shape the
   * database stores: an all-day start is a floating date pinned to midnight UTC,
   * a timed one is a real instant. Getting this wrong would rank against the
   * wrong hour of the day west of GMT.
   */
  const suggestionTargetStartUtc = useMemo(() => {
    if (!startDateStr) return ''
    if (allDay || recurrencePreset === 'lunar-yearly') return `${startDateStr}T00:00:00.000Z`
    const dt = DateTime.fromISO(`${startDateStr}T${startTimeStr}:00`, { zone: editZone(tzid) })
    return dt.isValid ? dt.toUTC().toISO()! : ''
  }, [startDateStr, startTimeStr, allDay, recurrencePreset, tzid])

  const calendarOptions = useMemo(
    () =>
      (calendars || []).map((cal) => ({
        value: cal.id,
        label: cal.name,
        color: cal.color,
        badge: cal.isReadOnly ? t('editor.readOnlyBadge') : undefined,
        disabled: cal.isReadOnly
      })),
    [calendars, t]
  )

  const recurrenceOptions = useMemo(
    () => [
      { value: 'none', label: t('editor.repeatNone') },
      { value: 'daily', label: t('editor.repeatDaily') },
      { value: 'weekly', label: t('editor.repeatWeekly') },
      { value: 'monthly', label: t('editor.repeatMonthly') },
      { value: 'yearly', label: t('editor.repeatYearly') },
      { value: 'lunar-yearly', label: t('editor.repeatLunar') },
      { value: 'custom', label: t('editor.repeatCustom') }
    ],
    [t]
  )

  // While creating a brand-new event, mirror the form's current slot + color onto
  // the calendar behind the dialog - editing an existing occurrence already has its
  // own card visible on the grid, so it needs no separate highlight. Kept ABOVE the
  // `if (!isOpen) return null` below (with its own inline copies of isLunarYearly /
  // selectedCalendar) so this hook always runs, open or closed - a hook placed after
  // an early return fires on some renders and not others, which React rejects.
  useEffect(() => {
    if (!onDraftChange) return
    if (!isOpen || isEditing) {
      onDraftChange(null)
      return
    }

    const lunarYearly = recurrencePreset === 'lunar-yearly'
    let start: DateTime
    let end: DateTime
    if (allDay || lunarYearly) {
      start = DateTime.fromISO(startDateStr, { zone: 'local' }).startOf('day')
      end = DateTime.fromISO((!lunarYearly && endDateStr) || startDateStr, { zone: 'local' }).endOf('day')
    } else {
      // Typed in the event's zone; the grid behind draws this machine's.
      start = DateTime.fromISO(`${startDateStr}T${startTimeStr}:00`, { zone: editZone(tzid) }).setZone('local')
      end = DateTime.fromISO(`${endDateStr}T${endTimeStr}:00`, { zone: editZone(tzid) }).setZone('local')
    }

    if (!start.isValid || !end.isValid || end <= start) {
      onDraftChange(null)
      return
    }

    const cal = (calendars || []).find((c) => c.id === calendarId)
    onDraftChange({
      start,
      end,
      allDay: allDay || lunarYearly,
      color: color || cal?.color || DEFAULT_EVENT_COLOR,
      title: title.trim() || t('common.untitled')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isOpen,
    isEditing,
    allDay,
    recurrencePreset,
    startDateStr,
    startTimeStr,
    endDateStr,
    endTimeStr,
    color,
    calendarId,
    calendars,
    title,
    tzid
  ])

  if (!isOpen) return null

  const handleFieldChange = (setter: React.Dispatch<React.SetStateAction<any>>, val: any) => {
    setter(val)
    setIsDirty(true)
  }

  /**
   * Accepting a suggestion also moves the event onto the calendar that title
   * normally lives on - the whole point of ranking by past events rather than
   * just completing the text. A read-only calendar never reaches the list, so
   * the switch cannot land somewhere nothing can be created.
   */
  const handlePickSuggestion = (suggestion: TitleSuggestion) => {
    setTitle(suggestion.title)
    if ((calendars || []).some((c) => c.id === suggestion.calendarId && !c.isReadOnly)) {
      setCalendarId(suggestion.calendarId)
    }
    setIsDirty(true)
  }

  const handleStartDateChange = (newStart: string) => {
    setStartDateStr(newStart)
    setIsDirty(true)
    if (!endDateStr || endDateStr < newStart) setEndDateStr(newStart)
  }

  /**
   * Picking an end earlier in the day than the start is not a mistake - it means
   * the event runs past midnight - so the date moves to match straight away
   * rather than the form waiting to reject it on save.
   */
  const handleEndTimeChange = (newEnd: string) => {
    setEndTimeStr(newEnd)
    setIsDirty(true)
    setEndDateStr(
      endDateForTimes({
        startDate: startDateStr,
        startClock: startTimeStr,
        endClock: newEnd,
        currentEndDate: endDateStr || startDateStr
      })
    )
  }

  const handleStartTimeChange = (newStart: string) => {
    setStartTimeStr(newStart)
    setIsDirty(true)
    if (startDateStr === endDateStr || !endDateStr) {
      const [sh, sm] = newStart.split(':').map(Number)
      const [eh, em] = endTimeStr.split(':').map(Number)
      if (!isNaN(sh) && !isNaN(sm) && !isNaN(eh) && !isNaN(em)) {
        if (eh * 60 + em <= sh * 60 + sm) {
          const nextHour = (sh + 1) % 24
          const rolledEnd = `${nextHour.toString().padStart(2, '0')}:${sm.toString().padStart(2, '0')}`
          setEndTimeStr(rolledEnd)
          // A start late enough that an hour later is tomorrow has to take the
          // date with it, or the form holds a range that ends before it begins.
          setEndDateStr(
            endDateForTimes({
              startDate: startDateStr,
              startClock: newStart,
              endClock: rolledEnd,
              currentEndDate: endDateStr || startDateStr
            })
          )
        }
      }
    }
  }

  const handleCloseAttempt = () => {
    if (isDirty) setShowDiscardConfirm(true)
    else onClose()
  }

  const inviteSelf = invitationSelf(attendees)

  // A reply is sent on its own, not with Save: it is the one thing a guest may
  // change, and it should not wait on (or be lost with) other edits.
  const handleRespond = async (response: RsvpResponse) => {
    const eventId = data?.occurrence?.eventId || data?.event?.id
    if (!eventId || !window.xrncal?.events?.respond || rsvpBusy) return
    setRsvpBusy(true)
    try {
      const updated = await window.xrncal.events.respond(eventId, response)
      setAttendees(updated.attendees || [])
      onDataChanged?.()
    } catch (err) {
      showFriendlyError(err, t('editor.rsvpFailed'))
    } finally {
      setRsvpBusy(false)
    }
  }

  const changeReminders = (next: EventReminder[] | null) => {
    setReminders(next)
    setRemindersTouched(true)
    remindersTouchedRef.current = true
    setIsDirty(true)
  }

  const handleAddAttendee = () => {
    const email = attendeeInput.trim()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return
    if (attendees.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      setAttendeeInput('')
      return
    }
    attendeesTouchedRef.current = true
    handleFieldChange(setAttendees, [...attendees, { email, responseStatus: 'needsAction' as const }])
    setAttendeeInput('')
  }

  const handleRemoveAttendee = (email: string) => {
    attendeesTouchedRef.current = true
    handleFieldChange(
      setAttendees,
      attendees.filter((a) => a.email !== email)
    )
  }

  const ATTENDEE_STATUS_DOT: Record<string, string> = {
    accepted: 'bg-emerald-500',
    declined: 'bg-today',
    tentative: 'bg-amber-500',
    needsAction: 'bg-muted'
  }

  const isLunarYearly = recurrencePreset === 'lunar-yearly'

  const RECURRENCE_FREQ: Record<string, string> = {
    daily: 'DAILY',
    weekly: 'WEEKLY',
    monthly: 'MONTHLY',
    yearly: 'YEARLY'
  }

  const buildRrule = (): string | undefined => {
    if (recurrencePreset === 'custom') return customRrule.trim() || undefined
    const freq = RECURRENCE_FREQ[recurrencePreset]
    if (!freq) return undefined

    const parts = [`FREQ=${freq}`]
    if (recurrenceInterval > 1) parts.push(`INTERVAL=${recurrenceInterval}`)
    if (recurrencePreset === 'weekly' && recurrenceByDay.length > 0) {
      parts.push(`BYDAY=${recurrenceByDay.join(',')}`)
    }
    if (recurrenceEnd === 'onDate' && recurrenceUntil) {
      // The series' last day ends in its own zone; an all-day one's dates are UTC.
      const untilZone = allDay || isLunarYearly ? 'utc' : editZone(tzid)
      const untilUtc = DateTime.fromISO(recurrenceUntil, { zone: untilZone }).endOf('day').toUTC()
      if (untilUtc.isValid) parts.push(`UNTIL=${untilUtc.toFormat("yyyyMMdd'T'HHmmss'Z'")}`)
    } else if (recurrenceEnd === 'afterCount' && recurrenceCount > 0) {
      parts.push(`COUNT=${recurrenceCount}`)
    }
    return parts.join(';')
  }

  const lunarSpec: LunarRecurrenceSpec | null = (() => {
    if (!isLunarYearly || !startDateStr) return null
    const d = DateTime.fromISO(startDateStr)
    if (!d.isValid) return null
    const l = convertSolarToLunar(d.day, d.month, d.year)
    return { day: l.day, month: l.month, leap: lunarLeap }
  })()

  const describeLunarSpec = (spec: LunarRecurrenceSpec): string =>
    t('editor.lunarDescribe', {
      day: spec.day,
      month: spec.month,
      name: LUNAR_MONTHS[spec.month] || String(spec.month),
      leap: spec.leap ? t('editor.lunarLeapSuffix') : ''
    })

  const lunarPreview: string[] = (() => {
    if (!lunarSpec) return []
    const thisYear = DateTime.local().year
    const out: string[] = []
    for (let y = thisYear; y < thisYear + 4; y++) {
      const iso = resolveLunarOccurrence(lunarSpec, y)
      if (iso) out.push(DateTime.fromISO(iso).toFormat('EEE, dd LLL yyyy'))
    }
    return out
  })()

  const submitEvent = () => {
    if (!title.trim()) {
      toast.warning(t('editor.needTitle'))
      return
    }
    if (!calendarId) {
      toast.warning(t('editor.needCalendar'))
      return
    }

    let startIso: string
    let endIso: string

    if (allDay || isLunarYearly) {
      startIso = `${startDateStr}T00:00:00.000Z`
      endIso = `${(!isLunarYearly && endDateStr) || startDateStr}T23:59:59.999Z`
    } else {
      const startLocal = DateTime.fromISO(`${startDateStr}T${startTimeStr}:00`, { zone: editZone(tzid) })
      const endLocal = DateTime.fromISO(`${endDateStr}T${endTimeStr}:00`, { zone: editZone(tzid) })
      if (endLocal <= startLocal) {
        toast.warning(t('editor.endAfterStart'))
        return
      }
      startIso = startLocal.toUTC().toISO()!
      endIso = endLocal.toUTC().toISO()!
    }

    if (isLunarYearly && !lunarSpec) {
      toast.warning(t('editor.needLunarDate'))
      return
    }

    const payloadInput: CreateEventInput = {
      calendarId,
      title: title.trim(),
      notes: notes.trim() || undefined,
      location: location.trim() || undefined,
      meetingUrl: meetingUrl.trim() || undefined,
      // '' clears an event's own colour; undefined would keep it.
      color,
      allDay: isLunarYearly ? true : allDay,
      tzid,
      dtStartUtc: startIso,
      dtEndUtc: endIso,
      rrule: isLunarYearly ? '' : buildRrule(),
      lunarRule: isLunarYearly ? lunarSpec! : null,
      // An edit sends guests only when they were changed here, and only once
      // the list has loaded. Sending the list untouched would overwrite
      // whatever a sync brought in meanwhile - on an invitation, possibly the
      // reply given on another device.
      attendees: !isEditing || (attendeesTouchedRef.current && attendeesLoaded) ? attendees : undefined,
      // An edit that leaves reminders alone must not send them: null would
      // reset an event's own list to the default.
      reminders: isEditing && !remindersTouched ? undefined : reminders
    }

    onSave({
      isNew: !isEditing,
      eventId: data?.occurrence?.eventId || data?.event?.id,
      occurrenceStartUtc: data?.occurrence?.originalStartUtc,
      isRecurringOccurrence,
      input: payloadInput
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    submitEvent()
  }

  const deleteEvent = () => {
    const eventId = data?.occurrence?.eventId || data?.event?.id
    if (!isEditing || !eventId) return
    onDelete(eventId, data?.occurrence?.originalStartUtc, Boolean(data?.occurrence?.isRecurring))
  }

  // Refreshed every render the dialog is open, which is the only time the
  // handler above can fire.
  submitRef.current = submitEvent
  deleteRef.current = deleteEvent

  const writableCalendars = (calendars || []).filter((c) => !c.isReadOnly)

  const handleMaterializeLunar = async () => {
    const eventId = data?.occurrence?.eventId || data?.event?.id
    const targetId = materializeTargetId || writableCalendars[0]?.id
    if (!eventId || !targetId || !window.xrncal?.events?.materializeLunar) return
    setLunarBusy(true)
    try {
      const throughYear = DateTime.local().year + 10
      const res = await window.xrncal.events.materializeLunar({
        masterEventId: eventId,
        targetCalendarId: targetId,
        throughYear
      })
      if (res.count > 0) {
        toast.success(t('toast.lunarAdded', { count: res.count }), {
          description: t('toast.lunarAddedDetail', { year: throughYear })
        })
        onDataChanged?.()
      } else {
        toast.info(t('toast.lunarUpToDate'))
      }
    } catch (err: any) {
      showFriendlyError(err, t('toast.lunarAddFailed'))
    } finally {
      setLunarBusy(false)
    }
  }

  const handleDetachLunar = async () => {
    const eventId = data?.occurrence?.eventId || data?.event?.id
    if (!eventId || !window.xrncal?.events?.detachLunar) return
    setLunarBusy(true)
    try {
      const res = await window.xrncal.events.detachLunar({ masterEventId: eventId })
      toast.success(res.count > 0 ? t('toast.lunarRemoved', { count: res.count }) : t('toast.lunarNoneToRemove'))
      if (res.count > 0) onDataChanged?.()
    } catch (err: any) {
      showFriendlyError(err, t('toast.lunarRemoveFailed'))
    } finally {
      setLunarBusy(false)
    }
  }

  const handleShare = async () => {
    const eventId = data?.occurrence?.eventId || data?.event?.id
    if (!eventId || !window.xrncal?.events?.shareIcs) return
    try {
      const res = await window.xrncal.events.shareIcs(eventId)
      if (res.success) {
        setShareSuccess(true)
        toast.success(t('toast.icsCreated'))
        setTimeout(() => setShareSuccess(false), 4000)
      } else {
        toast.error(t('toast.shareFailed'), { description: res.message })
      }
    } catch (err: any) {
      showFriendlyError(err, t('toast.shareError'))
    }
  }

  const selectedCalendar = (calendars || []).find((c) => c.id === calendarId)

  // The zone picker always offers the event's zone and this machine's, which
  // the runtime's list may spell differently (Asia/Ho_Chi_Minh, Asia/Saigon).
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const timeZoneOptions = [
    ...[tzid, localZone]
      .filter((z, i, all) => z && all.indexOf(z) === i && !zoneOptions().some((o) => o.value === z))
      .map((z) => ({ value: z, label: zoneLabel(z) })),
    ...zoneOptions()
  ]
  // When the event's zone keeps another clock, say what its start is here.
  const startInZone = DateTime.fromISO(`${startDateStr}T${startTimeStr}:00`, { zone: editZone(tzid) })
  const startHere = startInZone.setZone('local')
  const startHereLabel =
    startInZone.isValid && startInZone.offset !== startHere.offset
      ? `${formatClockTime(startHere, timeFormat)}, ${startHere.setLocale(i18n.language).toFormat('EEE d LLL')}`
      : null
  const ownColorKnown = !color || EVENT_COLORS.some((c) => c.hex === color.toLowerCase())
  // What the scheduler would ring - which, on a calendar the user cannot edit
  // (a feed, holidays, a shared calendar), is never the app's own default.
  const shownReminders =
    reminders ??
    effectiveReminders(
      undefined,
      allDay || isLunarYearly,
      selectedCalendar?.defaultReminders,
      selectedCalendar?.isReadOnly
        ? { timed: null, allDay: null }
        : { timed: defaultReminderMinutes, allDay: defaultAllDayReminderMinutes }
    )

  // New events created by clicking a slot dock as a side panel, on the side opposite
  // the click, so the panel never covers the spot the event was just created at.
  const isSidePanel = !isEditing && typeof data?.initialClientX === 'number'
  const panelSide: 'left' | 'right' =
    isSidePanel && data!.initialClientX! < window.innerWidth / 2 ? 'right' : 'left'

  return (
    <div
      className={isSidePanel ? 'fixed inset-0 z-50 select-none bg-black/30' : 'gc-overlay select-none'}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleCloseAttempt()
      }}
    >
      <div
        className={
          isSidePanel
            ? `absolute top-0 flex h-full w-full max-w-[420px] flex-col overflow-hidden bg-dialog text-primary shadow-xl ${
                panelSide === 'right' ? 'right-0 border-l border-hairline gc-slide-right' : 'left-0 border-r border-hairline gc-slide-left'
              }`
            : 'gc-dialog w-full max-w-lg'
        }
      >
        <div className="flex shrink-0 items-center justify-between border-b border-hairline px-5 py-3">
          <div className="flex items-center gap-2.5">
            <div
              className="h-3 w-3 rounded-full shrink-0 transition-colors"
              style={{ backgroundColor: selectedCalendar?.color || '#4A90E2' }}
            />
            <h3 className="text-sm font-semibold text-primary">
              {isEditing ? t('editor.editEvent') : t('editor.newEvent')}
            </h3>
          </div>

          <button onClick={handleCloseAttempt} className="gc-icon-btn">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="px-6 py-3.5 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1 text-xs space-y-0"
        >
          <div className="pb-2 mb-1 border-b border-hairline/60">
            <TitleSuggestInput
              value={title}
              onChange={(val) => handleFieldChange(setTitle, val)}
              onPick={handlePickSuggestion}
              targetStartUtc={suggestionTargetStartUtc}
              targetAllDay={allDay || isLunarYearly}
              calendars={calendars || []}
              placeholder={t('editor.titlePlaceholder')}
              autoFocus
              enabled={!isEditing}
              onSubmit={submitEvent}
            />
          </div>

          <div className="space-y-0">
            {inviteSelf && (
              <FormRow label={t('editor.rsvpLabel')} divider>
                <div className="flex items-center gap-1 px-2.5 py-1">
                  {(
                    [
                      ['accepted', 'editor.rsvpYes'],
                      ['tentative', 'editor.rsvpMaybe'],
                      ['declined', 'editor.rsvpNo']
                    ] as const
                  ).map(([response, label]) => (
                    <button
                      key={response}
                      type="button"
                      disabled={rsvpBusy}
                      onClick={() => handleRespond(response)}
                      className={`${
                        inviteSelf.responseStatus === response ? 'gc-btn-primary' : 'gc-btn'
                      } text-xs disabled:opacity-50`}
                    >
                      {t(label)}
                    </button>
                  ))}
                </div>
              </FormRow>
            )}

            <FormRow label={t('editor.calendar')} divider>
              <CustomSelect
                value={calendarId}
                onChange={(val) => handleFieldChange(setCalendarId, val)}
                options={calendarOptions}
                placeholder={t('editor.chooseCalendar')}
              />
            </FormRow>

            <FormRow label={t('editor.color')} divider>
              <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1">
                <ColorSwatch
                  hex={selectedCalendar?.color || DEFAULT_EVENT_COLOR}
                  selected={!color}
                  label={t('editor.colorDefault')}
                  onClick={() => handleFieldChange(setColor, '')}
                />
                <span className="mx-0.5 h-4 w-px shrink-0 bg-hairline" aria-hidden />
                {EVENT_COLORS.map((c) => (
                  <ColorSwatch
                    key={c.hex}
                    hex={c.hex}
                    selected={color.toLowerCase() === c.hex}
                    label={t(`editor.colors.${c.name}`)}
                    onClick={() => handleFieldChange(setColor, c.hex)}
                  />
                ))}
                {/* A colour set elsewhere that is not one of these still shows as chosen. */}
                {!ownColorKnown && <ColorSwatch hex={color} selected label={color} onClick={() => undefined} />}
              </div>
            </FormRow>

            <FormRow label={t('editor.allDay')} divider>
              <div className="px-2.5 py-1 flex items-center">
                <ToggleSwitch
                  checked={allDay || isLunarYearly}
                  onChange={(checked) => handleFieldChange(setAllDay, checked)}
                  size="sm"
                  disabled={isLunarYearly}
                />
              </div>
            </FormRow>

            <FormRow label={isLunarYearly ? t('editor.anniversaryDate') : t('editor.start')} divider>
              <div className="flex items-center gap-1.5 min-w-0 w-full">
                <div className="flex-1 min-w-0">
                  <DatePicker
                    value={startDateStr}
                    onChange={handleStartDateChange}
                    placeholder={t('editor.startDate')}
                  />
                </div>
                {!allDay && !isLunarYearly && (
                  <div className="w-[105px] shrink-0">
                    <TimePicker value={startTimeStr} onChange={handleStartTimeChange} />
                  </div>
                )}
              </div>
            </FormRow>

            {!isLunarYearly && (
              <FormRow label={t('editor.end')} divider>
                <div className="flex items-center gap-1.5 min-w-0 w-full">
                  <div className="flex-1 min-w-0">
                    <DatePicker
                      value={endDateStr}
                      onChange={(val) => handleFieldChange(setEndDateStr, val)}
                      minDate={startDateStr}
                      placeholder={t('editor.endDate')}
                    />
                  </div>
                  {!allDay && (
                    <div className="w-[105px] shrink-0">
                      <TimePicker
                        value={endTimeStr}
                        onChange={handleEndTimeChange}
                        startTime={startDateStr === endDateStr ? startTimeStr : undefined}
                        align="right"
                      />
                    </div>
                  )}
                </div>
              </FormRow>
            )}

            {!allDay && !isLunarYearly && (
              <FormRow label={t('editor.timeZone')} divider alignTop={Boolean(startHereLabel)}>
                <div className="min-w-0">
                  <CustomSelect
                    value={tzid}
                    onChange={(val) => handleFieldChange(setTzid, val)}
                    options={timeZoneOptions}
                    searchable
                  />
                  {startHereLabel && (
                    <div className="px-2.5 pt-1 pb-0.5 text-[11px] text-muted">
                      {t('editor.timeZoneHere', { time: startHereLabel })}
                    </div>
                  )}
                </div>
              </FormRow>
            )}

            <FormRow label={t('reminders.label')} divider alignTop>
              <ReminderListField
                reminders={shownReminders}
                allDay={allDay || isLunarYearly}
                isDefault={reminders === null}
                onChange={changeReminders}
                onUseDefault={() => changeReminders(null)}
              />
            </FormRow>

            <FormRow label={t('editor.location')} divider>
              <TextInput
                value={location}
                onChange={(val) => handleFieldChange(setLocation, val)}
                placeholder={t('editor.locationPlaceholder')}
                prefixIcon={<MapPin className="h-3.5 w-3.5" />}
              />
            </FormRow>

            <FormRow label={t('editor.meetingUrl')} divider>
              <TextInput
                value={meetingUrl}
                onChange={(val) => handleFieldChange(setMeetingUrl, val)}
                placeholder={t('editor.meetingUrlPlaceholder')}
                type="url"
                prefixIcon={<LinkIcon className="h-3.5 w-3.5" />}
              />
            </FormRow>

            <FormRow label={t('editor.attendees')} divider alignTop>
              <div className="w-full space-y-1.5 py-1">
                {attendees.length > 0 && (
                  <div className="space-y-1">
                    {attendees.map((a) => (
                      <div
                        key={a.email}
                        className="flex items-center gap-2 rounded-[3px] bg-hover/60 px-2 py-1 text-xs"
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            ATTENDEE_STATUS_DOT[a.responseStatus || 'needsAction']
                          }`}
                          title={a.responseStatus || 'needsAction'}
                        />
                        <span className="flex-1 min-w-0 truncate text-primary">
                          {a.displayName || a.email}
                          {a.isOrganizer && (
                            <span className="ml-1.5 text-[10px] text-muted">{t('editor.organizer')}</span>
                          )}
                          {a.isSelf && !a.isOrganizer && (
                            <span className="ml-1.5 text-[10px] text-muted">{t('editor.you')}</span>
                          )}
                          {a.role && (
                            <span className="ml-1.5 text-[10px] text-muted">
                              {t(
                                a.role === 'optional'
                                  ? 'editor.attendeeOptional'
                                  : a.role === 'room'
                                    ? 'editor.attendeeRoom'
                                    : 'editor.attendeeResource'
                              )}
                            </span>
                          )}
                        </span>
                        {/* A guest cannot change the guest list, only answer. */}
                        {!inviteSelf && (
                          <button
                            type="button"
                            onClick={() => handleRemoveAttendee(a.email)}
                            className="shrink-0 cursor-pointer text-muted hover:text-today transition-colors"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {!inviteSelf && (
                  <div className="flex items-center gap-1.5">
                    <TextInput
                      value={attendeeInput}
                      onChange={setAttendeeInput}
                      placeholder={t('editor.attendeesPlaceholder')}
                      type="email"
                      prefixIcon={<Users className="h-3.5 w-3.5" />}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          handleAddAttendee()
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={handleAddAttendee}
                      className="gc-btn shrink-0 text-xs"
                    >
                      {t('common.add')}
                    </button>
                  </div>
                )}
              </div>
            </FormRow>

            <FormRow label={t('editor.notes')} divider alignTop>
              <TextArea
                value={notes}
                onChange={(val) => handleFieldChange(setNotes, val)}
                placeholder={t('editor.notesPlaceholder')}
                rows={3}
              />
            </FormRow>

            <FormRow label={t('editor.repeat')} divider={recurrencePreset === 'none' || recurrencePreset === 'custom'}>
              <CustomSelect
                value={recurrencePreset}
                onChange={(val) => {
                  handleFieldChange(setRecurrencePreset, val)
                  // A new giỗ gets a day's notice unless the user has set an
                  // all-day default of their own (or already picked reminders).
                  if (
                    val === 'lunar-yearly' &&
                    !isEditing &&
                    !remindersTouched &&
                    defaultAllDayReminderMinutes === null
                  ) {
                    changeReminders([{ minutesBefore: LUNAR_ANNIVERSARY_REMINDER }])
                  }
                  if (val === 'weekly' && recurrenceByDay.length === 0 && startDateStr) {
                    const d = DateTime.fromISO(startDateStr)
                    if (d.isValid) setRecurrenceByDay([WEEKDAY_CODES[d.weekday - 1]])
                  }
                }}
                options={recurrenceOptions}
              />
            </FormRow>

            {(['daily', 'weekly', 'monthly', 'yearly'] as string[]).includes(recurrencePreset) && (
              <FormRow label="" divider alignTop>
                <div className="w-full space-y-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted">{t('editor.repeatEvery')}</span>
                    <NumberInput
                      value={recurrenceInterval}
                      onChange={(v) => handleFieldChange(setRecurrenceInterval, Math.max(1, Math.round(v)))}
                      min={1}
                      max={999}
                    />
                    <span className="text-xs text-muted">
                      {t(
                        {
                          daily: 'editor.repeatUnitDaily',
                          weekly: 'editor.repeatUnitWeekly',
                          monthly: 'editor.repeatUnitMonthly',
                          yearly: 'editor.repeatUnitYearly'
                        }[recurrencePreset] as string
                      )}
                    </span>
                  </div>

                  {recurrencePreset === 'weekly' && (
                    <div className="flex items-center gap-1">
                      {WEEKDAY_CODES.map((code) => (
                        <button
                          key={code}
                          type="button"
                          onClick={() => handleFieldChange(setRecurrenceByDay, toggleWeekday(recurrenceByDay, code))}
                          className={`h-6 w-6 shrink-0 cursor-pointer rounded-full text-[10px] font-semibold transition-colors ${
                            recurrenceByDay.includes(code)
                              ? 'bg-accent text-white'
                              : 'bg-hover text-muted hover:text-primary'
                          }`}
                        >
                          {t(`editor.weekdayShort.${code.toLowerCase()}`)}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <span className="w-[72px] shrink-0 text-xs text-muted">{t('editor.repeatEnds')}</span>
                    <CustomSelect
                      value={recurrenceEnd}
                      onChange={(val) => handleFieldChange(setRecurrenceEnd, val as typeof recurrenceEnd)}
                      options={[
                        { value: 'never', label: t('editor.repeatEndsNever') },
                        { value: 'onDate', label: t('editor.repeatEndsOnDate') },
                        { value: 'afterCount', label: t('editor.repeatEndsAfter') }
                      ]}
                    />
                  </div>

                  {recurrenceEnd === 'onDate' && (
                    <DatePicker
                      value={recurrenceUntil}
                      onChange={(val) => handleFieldChange(setRecurrenceUntil, val)}
                      minDate={startDateStr}
                      placeholder={t('editor.endDate')}
                    />
                  )}

                  {recurrenceEnd === 'afterCount' && (
                    <div className="flex items-center gap-2">
                      <NumberInput
                        value={recurrenceCount}
                        onChange={(v) => handleFieldChange(setRecurrenceCount, Math.max(1, Math.round(v)))}
                        min={1}
                        max={999}
                      />
                      <span className="text-xs text-muted">{t('editor.repeatOccurrences')}</span>
                    </div>
                  )}
                </div>
              </FormRow>
            )}

            {recurrencePreset === 'custom' && (
              <FormRow label="" divider>
                <TextInput
                  value={customRrule}
                  onChange={(val) => handleFieldChange(setCustomRrule, val)}
                  placeholder={t('editor.customRrulePlaceholder')}
                  inputClassName="font-mono text-xs"
                  variant="boxed"
                />
              </FormRow>
            )}

            {isLunarYearly && (
              <FormRow label={t('editor.lunarDate')} divider alignTop>
                <div className="px-2.5 py-2 space-y-2 w-full">
                  <div className="text-xs text-primary">
                    {lunarSpec ? describeLunarSpec(lunarSpec) : t('editor.lunarPickDate')}
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
                    <input
                      type="checkbox"
                      checked={lunarLeap}
                      onChange={(e) => handleFieldChange(setLunarLeap, e.target.checked)}
                    />
                    {t('editor.lunarLeapCheckbox')}
                  </label>
                  {lunarPreview.length > 0 && (
                    <div className="text-[11px] text-muted leading-relaxed">
                      {t('editor.lunarNext', { dates: lunarPreview.join(' · ') })}
                    </div>
                  )}
                  <p className="text-[11px] text-muted leading-relaxed">{t('editor.lunarHelp')}</p>
                </div>
              </FormRow>
            )}

            {isLunarYearly && isEditing && writableCalendars.length > 0 && (
              <FormRow label={t('editor.addToCalendar')} divider alignTop>
                <div className="px-2.5 py-2 space-y-2 w-full">
                  <CustomSelect
                    value={materializeTargetId || writableCalendars[0].id}
                    onChange={setMaterializeTargetId}
                    options={writableCalendars.map((c) => ({
                      value: c.id,
                      label: c.name,
                      color: c.color
                    }))}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleMaterializeLunar}
                      disabled={lunarBusy}
                      className="gc-btn text-xs disabled:opacity-50"
                    >
                      {t('editor.generateThrough', { year: DateTime.local().year + 10 })}
                    </button>
                    <button
                      type="button"
                      onClick={handleDetachLunar}
                      disabled={lunarBusy}
                      className="px-2.5 py-1.5 text-xs text-today hover:opacity-80 transition-opacity cursor-pointer disabled:opacity-50"
                    >
                      {t('editor.removeSyncedCopies')}
                    </button>
                  </div>
                </div>
              </FormRow>
            )}
          </div>
        </form>

        <div className="px-5 py-3 border-t border-hairline flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1">
            {isEditing && (
              <>
                <button
                  type="button"
                  onClick={handleShare}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-muted hover:text-primary transition-colors text-xs cursor-pointer"
                  title={t('editor.shareTitle')}
                >
                  <Share2 className="h-3.5 w-3.5" />
                  <span>{shareSuccess ? t('editor.shareCreated') : t('editor.share')}</span>
                </button>

                <button
                  type="button"
                  onClick={deleteEvent}
                  title={t('shortcuts.hintDelete')}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-today hover:opacity-80 transition-opacity text-xs cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{t('common.delete')}</span>
                </button>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCloseAttempt}
              className="px-3 py-1.5 text-xs text-muted hover:text-primary transition-colors cursor-pointer"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              title={t('shortcuts.hintSave')}
              className="gc-btn-primary px-4 py-1.5 text-xs"
              style={{ borderRadius: 'var(--radius-control)' }}
            >
              {isEditing ? t('editor.saveChanges') : t('editor.create')}
            </button>
          </div>
        </div>

        {showDiscardConfirm && (
          <div className="absolute inset-0 bg-black/70 flex items-center justify-center p-6 z-60">
            <div
              className="bg-dialog border border-hairline p-5 max-w-xs w-full"
              style={{ borderRadius: 'var(--radius-dialog)' }}
            >
              <h4 className="text-sm font-semibold text-primary mb-1.5">{t('editor.discardTitle')}</h4>
              <p className="text-xs text-muted mb-4">{t('editor.discardBody')}</p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowDiscardConfirm(false)} className="gc-btn text-xs">
                  {t('editor.keepEditing')}
                </button>
                <button
                  onClick={() => {
                    setShowDiscardConfirm(false)
                    onClose()
                  }}
                  className="px-3 py-1.5 text-xs text-today hover:opacity-80 transition-opacity cursor-pointer font-medium"
                >
                  {t('editor.discard')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default EventEditorDialog
