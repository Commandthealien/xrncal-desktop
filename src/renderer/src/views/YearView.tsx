import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { occurrenceDateKeys } from '@shared/all-day'
import { useTranslation } from 'react-i18next'
import { DateTime } from 'luxon'
import type { ExpandedOccurrence } from '@shared/event-model'
import { TODAY_COLOR, DEFAULT_EVENT_COLOR } from '@shared/mini-calendar-grid'
import { weekdayShortLabels } from '../i18n/weekday-labels'
import LunarLabel from '../components/LunarLabel'
import { useWheelNavigation } from '../hooks/use-wheel-navigation'

/**
 * One year, one page.
 *
 * This used to be an infinite scroller: a moving window of year blocks that
 * extended as you approached either edge, with scroll-anchor compensation and
 * an active-year probe to keep the pinned header honest. It also meant the
 * container had to widen its event query to whatever span happened to be
 * mounted.
 *
 * Now it behaves like the month and week views - the anchor year is laid out
 * in full and navigation moves a year at a time - which makes the query a
 * fixed Jan-Dec range and removes the windowing entirely.
 */
interface YearViewProps {
  anchorDate: DateTime
  occurrences: ExpandedOccurrence[]
  showLunar: boolean
  onSelectMonth: (year: number, month: number) => void
  onSelectDate: (date: DateTime) => void
  /** Wheel / trackpad past the threshold steps a year, as in the other views. */
  onPrevYear?: () => void
  onNextYear?: () => void
}

/** Every month is laid out on six week rows so all twelve cards are the same
 *  height and the grid divides the page evenly, whatever the month's shape. */
const WEEK_ROWS = 6

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

// ---------------------------------------------------------------------------
// Month card
// ---------------------------------------------------------------------------

interface MonthCardProps {
  year: number
  month: number
  weekdayHeaders: string[]
  locale: string
  todayKey: string
  showLunar: boolean
  colorsByDay: Map<string, string[]>
  onSelectMonth: (year: number, month: number) => void
  onSelectDate: (date: DateTime) => void
}

/** Memoized because a year is ~370 day cells, each running a lunar conversion;
 *  without it, every parent render recomputed the lot. */
const MonthCard = React.memo<MonthCardProps>(
  ({ year, month, weekdayHeaders, locale, todayKey, showLunar, colorsByDay, onSelectMonth, onSelectDate }) => {
    const cells = useMemo(() => {
      const first = DateTime.local(year, month, 1)
      const daysInMonth = first.daysInMonth || 31
      const out: (DateTime | null)[] = []
      for (let pad = 1; pad < first.weekday; pad++) out.push(null)
      for (let d = 1; d <= daysInMonth; d++) out.push(DateTime.local(year, month, d))
      // Pad to a whole six-row grid so short months do not stretch their cells.
      while (out.length < WEEK_ROWS * 7) out.push(null)
      return out
    }, [year, month])

    const monthLabel = useMemo(
      () => DateTime.local(year, month, 1).setLocale(locale).toFormat('MMMM'),
      [year, month, locale]
    )

    return (
      <div className="flex min-h-0 min-w-0 flex-col justify-center">
        <h4
          onClick={() => onSelectMonth(year, month)}
          className="mb-0.5 shrink-0 cursor-pointer truncate text-center text-[11px] font-semibold text-primary transition-colors hover:text-[var(--color-accent-mark)] sm:mb-1 sm:text-sm"
        >
          {monthLabel}
        </h4>

        <div className="mb-0.5 grid shrink-0 grid-cols-7 text-center text-[8px] font-medium text-muted sm:text-[10px]">
          {weekdayHeaders.map((h, idx) => (
            <span key={`${h}-${idx}`} className={`truncate ${idx >= 5 ? 'text-today' : ''}`}>
              {h}
            </span>
          ))}
        </div>

        {/* flex-1 + explicit rows: the cells absorb whatever height the page
            has left, so twelve months fill the viewport exactly instead of
            overflowing it. */}
        {/* `1fr` rows alone stretched each week row to fill the card, so a
            10px number sat in a 24px slot and the month read as loose. The
            height is capped in CSS (.gc-year-month-grid) and the card centres
            what is left, which tightens the days and turns the slack into
            spacing between months. */}
        <div
          className="gc-year-month-grid grid min-h-0 flex-1 grid-cols-7 text-center"
          style={{ gridTemplateRows: `repeat(${WEEK_ROWS}, minmax(0, 1fr))` }}
        >
          {cells.map((day, cellIdx) => {
            if (!day) return <span key={`empty-${cellIdx}`} />

            const key = day.toFormat('yyyy-MM-dd')
            const isToday = key === todayKey
            const blockColor = colorsByDay.get(key)?.[0]

            return (
              <button
                type="button"
                key={key}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelectDate(day)
                }}
                className="gc-year-day relative flex min-h-0 min-w-0 flex-col items-center justify-center overflow-hidden leading-none text-primary transition-colors hover:bg-hover"
                style={
                  isToday
                    ? { color: '#fff', backgroundColor: TODAY_COLOR, fontWeight: 600, borderRadius: 4 }
                    : blockColor
                      ? { backgroundColor: `${blockColor}33`, borderRadius: 4 }
                      : undefined
                }
              >
                <span className="text-[11px] sm:text-[13px]">{day.day}</span>
                {/* Hidden on a phone, where a month card is barely wider than
                    a thumb - the day numbers have to stay legible, and month
                    view still carries the lunar dates. */}
                {/* Visibility is decided in CSS (.gc-year-lunar), because it
                    depends on the cell having room for a second line - which
                    is a function of viewport height as much as width. A wide
                    but short window has no room for it. */}
                {showLunar && (
                  <LunarLabel
                    day={day.day}
                    month={day.month}
                    year={day.year}
                    className={`gc-year-lunar !text-[8px] leading-none ${isToday ? '!text-white/85' : ''}`}
                  />
                )}
              </button>
            )
          })}
        </div>
      </div>
    )
  }
)
MonthCard.displayName = 'MonthCard'

// ---------------------------------------------------------------------------
// Year view
// ---------------------------------------------------------------------------

export const YearView: React.FC<YearViewProps> = ({
  anchorDate,
  occurrences,
  showLunar,
  onSelectMonth,
  onSelectDate,
  onPrevYear,
  onNextYear
}) => {
  const { t, i18n } = useTranslation()
  const year = anchorDate.year

  const gridRef = useRef<HTMLDivElement>(null)

  // Callers pass inline arrows, which change identity on every parent render
  // and would defeat MonthCard's memo. Route them through refs.
  const selectMonthRef = useRef(onSelectMonth)
  const selectDateRef = useRef(onSelectDate)
  selectMonthRef.current = onSelectMonth
  selectDateRef.current = onSelectDate

  const handleSelectMonth = useCallback(
    (y: number, m: number) => selectMonthRef.current(y, m),
    []
  )
  const handleSelectDate = useCallback((date: DateTime) => selectDateRef.current(date), [])

  useEffect(() => {
    // A new year always opens at January, even if the previous one was
    // scrolled down in a short window.
    if (gridRef.current) gridRef.current.scrollTop = 0
  }, [year])

  const weekdayHeaders = useMemo(() => weekdayShortLabels(t, 1), [t, i18n.language])
  const todayKey = useMemo(() => DateTime.local().toFormat('yyyy-MM-dd'), [])

  const colorsByDay = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const occ of occurrences) {
      const color = occ.color || DEFAULT_EVENT_COLOR
      // A multi-day event is marked on every day it covers. occurrenceDateKeys
      // reads all-day spans as the floating dates they are, so they are not
      // shifted by a UTC->local conversion.
      for (const key of occurrenceDateKeys(occ.allDay, occ.startUtc, occ.endUtc)) {
        const list = map.get(key)
        if (!list) map.set(key, [color])
        else if (list.length < 3 && !list.includes(color)) list.push(color)
      }
    }
    return map
  }, [occurrences])

  // A flick anywhere on the page steps a year; the grid below only keeps the
  // gesture while it still has somewhere to scroll, which a short window gives
  // it and a normal one does not.
  const handleWheel = useWheelNavigation({
    onPrev: onPrevYear,
    onNext: onNextYear,
    scrollerRef: gridRef
  })

  return (
    <div
      onWheel={handleWheel}
      className="gc-year-view flex h-full w-full min-h-0 flex-col overflow-hidden bg-surface select-none"
    >
      {/* Three columns on a phone, four once there is room, six on a wide
          desktop - always a whole number of rows, so the grid divides the
          page without a partial row at the bottom. */}
      {/* Rows are sized to their content rather than stretched to `1fr`:
          stretching spread twelve months over the full height and dumped all
          the slack between the week rows, which is what made the days look
          loose. The leftover height is then banked at the top and bottom edges
          rather than dealt out between the rows (`.gc-year-grid` in index.css),
          which keeps the twelve cards a gap apart: `content-evenly` did the
          latter, and on a tall window it pushed the months far enough apart
          that the year stopped reading as one block. */}
      <div
        ref={gridRef}
        className="gc-year-grid grid min-h-0 flex-1 grid-cols-3 gap-x-2 gap-y-2 overflow-y-auto p-2 sm:grid-cols-4 sm:gap-x-3 sm:gap-y-3 sm:p-4 2xl:grid-cols-6">
        {MONTHS.map((month) => (
          <MonthCard
            key={month}
            year={year}
            month={month}
            weekdayHeaders={weekdayHeaders}
            locale={i18n.language}
            todayKey={todayKey}
            showLunar={showLunar}
            colorsByDay={colorsByDay}
            onSelectMonth={handleSelectMonth}
            onSelectDate={handleSelectDate}
          />
        ))}
      </div>
    </div>
  )
}

export default YearView
