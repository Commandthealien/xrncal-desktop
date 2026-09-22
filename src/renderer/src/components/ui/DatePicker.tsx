import i18n from '../../i18n'
import React, { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { DateTime } from 'luxon'
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  X
} from 'lucide-react'

export interface DatePickerProps {
  value?: string // format: yyyy-MM-dd
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  minDate?: string
  maxDate?: string
  disabled?: boolean
  compact?: boolean
  className?: string
  showPresets?: boolean
  align?: 'left' | 'right'
}

export const DatePicker: React.FC<DatePickerProps> = ({
  value,
  onChange,
  placeholder = i18n.t('ui.selectPlaceholder'),
  label,
  minDate,
  maxDate,
  disabled = false,
  compact = false,
  className = '',
  showPresets = true,
  align = 'left'
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const parsedValue = useMemo(() => {
    if (!value) return null
    const dt = DateTime.fromISO(value)
    return dt.isValid ? dt : null
  }, [value])

  const [viewDate, setViewDate] = useState<DateTime>(() => parsedValue || DateTime.local())
  // The day the arrow keys are resting on. The grid is a portal at the end of
  // <body>, so tabbing into it is not an option: focus stays on the trigger and
  // this cursor is what moves.
  const [activeDate, setActiveDate] = useState<DateTime | null>(null)

  const updateCoords = () => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const popoverWidth = 280
    const popoverHeight = 330

    // Horizontal positioning
    let left = align === 'right' ? rect.right - popoverWidth : rect.left
    if (left + popoverWidth > window.innerWidth - 8) {
      left = window.innerWidth - popoverWidth - 8
    }
    if (left < 8) {
      left = 8
    }

    // Vertical positioning: default below, flip above if overflowing bottom
    let top = rect.bottom + 4
    if (top + popoverHeight > window.innerHeight - 8 && rect.top - popoverHeight - 4 > 8) {
      top = rect.top - popoverHeight - 4
    }

    setCoords({ top, left })
  }

  useEffect(() => {
    if (!isOpen) return

    setViewDate(parsedValue || DateTime.local())
    setActiveDate(parsedValue || DateTime.local())
    updateCoords()

    const handleScrollOrResize = () => {
      updateCoords()
    }
    window.addEventListener('resize', handleScrollOrResize)
    window.addEventListener('scroll', handleScrollOrResize, true)
    return () => {
      window.removeEventListener('resize', handleScrollOrResize)
      window.removeEventListener('scroll', handleScrollOrResize, true)
    }
  }, [isOpen, parsedValue, align])

  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        popoverRef.current &&
        !popoverRef.current.contains(target)
      ) {
        setIsOpen(false)
      }
    }

    // The effect re-registers whenever activeDate changes, so the value closed
    // over here is always the current one - no updater needed, and none wanted:
    // a second setState inside one would be a side effect in a pure function.
    const move = (shift: (d: DateTime) => DateTime) => {
      const next = shift(activeDate || parsedValue || DateTime.local())
      setActiveDate(next)
      setViewDate(next)
    }

    const close = () => {
      setIsOpen(false)
      triggerRef.current?.focus()
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          // Without stopPropagation this same Escape carries on to the dialog
          // hosting the field and closes that too.
          e.preventDefault()
          e.stopPropagation()
          close()
          break
        case 'ArrowLeft':
          e.preventDefault()
          move((d) => d.minus({ days: 1 }))
          break
        case 'ArrowRight':
          e.preventDefault()
          move((d) => d.plus({ days: 1 }))
          break
        case 'ArrowUp':
          e.preventDefault()
          move((d) => d.minus({ weeks: 1 }))
          break
        case 'ArrowDown':
          e.preventDefault()
          move((d) => d.plus({ weeks: 1 }))
          break
        case 'PageUp':
          e.preventDefault()
          move((d) => (e.shiftKey ? d.minus({ years: 1 }) : d.minus({ months: 1 })))
          break
        case 'PageDown':
          e.preventDefault()
          move((d) => (e.shiftKey ? d.plus({ years: 1 }) : d.plus({ months: 1 })))
          break
        case 'Home':
          e.preventDefault()
          move((d) => d.startOf('week'))
          break
        case 'End':
          e.preventDefault()
          move((d) => d.endOf('week').startOf('day'))
          break
        case 't':
        case 'T':
          e.preventDefault()
          move(() => DateTime.local())
          break
        case 'Enter':
          // preventDefault also stops the browser replaying this keydown as a
          // click on the still-focused trigger, which would reopen the grid.
          e.preventDefault()
          if (activeDate && !isOutOfRange(activeDate)) {
            handleSelectDate(activeDate)
            triggerRef.current?.focus()
          }
          break
        case 'Tab':
          // Portalled grid: Tab would strand focus at the end of <body>.
          e.preventDefault()
          close()
          break
        default:
          break
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, activeDate, parsedValue, minDate, maxDate])

  const calendarGrid = useMemo(() => {
    const startOfMonth = viewDate.startOf('month')
    const endOfMonth = viewDate.endOf('month')

    let cur = startOfMonth.startOf('week')
    const endGrid = endOfMonth.endOf('week')

    const days: DateTime[] = []
    while (cur <= endGrid || days.length < 35) {
      days.push(cur)
      cur = cur.plus({ days: 1 })
      if (days.length >= 42) break
    }

    return days
  }, [viewDate])

  const isOutOfRange = (day: DateTime): boolean => {
    if (minDate) {
      const minDt = DateTime.fromISO(minDate)
      if (minDt.isValid && day < minDt.startOf('day')) return true
    }
    if (maxDate) {
      const maxDt = DateTime.fromISO(maxDate)
      if (maxDt.isValid && day > maxDt.endOf('day')) return true
    }
    return false
  }

  const handleSelectDate = (date: DateTime) => {
    onChange(date.toFormat('yyyy-MM-dd'))
    setIsOpen(false)
  }

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation()
    onChange('')
    setIsOpen(false)
  }

  const handlePrevMonth = () => setViewDate((d) => d.minus({ months: 1 }))
  const handleNextMonth = () => setViewDate((d) => d.plus({ months: 1 }))
  const handlePrevYear = () => setViewDate((d) => d.minus({ years: 1 }))
  const handleNextYear = () => setViewDate((d) => d.plus({ years: 1 }))

  const today = DateTime.local()

  const displayLabel = useMemo(() => {
    if (!parsedValue) return ''
    return parsedValue.toFormat('dd/MM/yyyy')
  }, [parsedValue])

  const presets = [
    { label: i18n.t('ui.today'), getDt: () => today },
    { label: i18n.t('ui.tomorrow'), getDt: () => today.plus({ days: 1 }) },
    {
      label: i18n.t('ui.weekend'),
      getDt: () => {
        const sat = today.set({ weekday: 6 })
        return sat < today ? sat.plus({ weeks: 1 }) : sat
      }
    },
    { label: i18n.t('ui.nextWeek'), getDt: () => today.plus({ weeks: 1 }) }
  ]

  const weekHeaders = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']

  const popover =
    isOpen && coords && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[99999] border border-hairline bg-surface p-3 text-primary shadow-xl animate-popover select-none"
            style={{
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              width: '280px',
              borderRadius: 'var(--radius-dialog)',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18), 0 0 0 1px var(--color-border)'
            }}
          >
            {/* Quick Presets */}
            {showPresets && (
              <div className="mb-2 flex flex-wrap gap-1 border-b border-hairline pb-2">
                {presets.map((p) => {
                  const presetDt = p.getDt()
                  const isSelected = parsedValue && parsedValue.hasSame(presetDt, 'day')
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => handleSelectDate(presetDt)}
                      className={`px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-accent text-white font-semibold'
                          : 'bg-hover text-muted hover:text-primary'
                      }`}
                      style={{ borderRadius: 'var(--radius-control)' }}
                    >
                      {p.label}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Month / Year Navigator */}
            <div className="mb-2 flex items-center justify-between px-1">
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={handlePrevYear}
                  className="p-1 text-muted hover:text-primary hover:bg-hover transition-colors cursor-pointer"
                  style={{ borderRadius: 'var(--radius-control)' }}
                  title={i18n.t('ui.prevYear')}
                >
                  <ChevronsLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handlePrevMonth}
                  className="p-1 text-muted hover:text-primary hover:bg-hover transition-colors cursor-pointer"
                  style={{ borderRadius: 'var(--radius-control)' }}
                  title={i18n.t('ui.prevMonth')}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
              </div>

              <span className="text-xs font-semibold text-primary">
                {viewDate.toFormat('MMMM yyyy')}
              </span>

              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={handleNextMonth}
                  className="p-1 text-muted hover:text-primary hover:bg-hover transition-colors cursor-pointer"
                  style={{ borderRadius: 'var(--radius-control)' }}
                  title={i18n.t('ui.nextMonth')}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleNextYear}
                  className="p-1 text-muted hover:text-primary hover:bg-hover transition-colors cursor-pointer"
                  style={{ borderRadius: 'var(--radius-control)' }}
                  title={i18n.t('ui.nextYear')}
                >
                  <ChevronsRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Weekday Headers */}
            <div className="mb-1 grid grid-cols-7 text-center text-[10px] font-medium text-muted uppercase tracking-wider">
              {weekHeaders.map((h) => (
                <span key={h} className="py-1">
                  {h}
                </span>
              ))}
            </div>

            {/* Days Grid */}
            <div className="grid grid-cols-7 gap-0.5 text-center">
              {calendarGrid.map((day) => {
                const key = day.toFormat('yyyy-MM-dd')
                const isCurrentMonth = day.month === viewDate.month
                const isToday = day.hasSame(today, 'day')
                const isSelected = Boolean(parsedValue && day.hasSame(parsedValue, 'day'))

                const isDisabled = isOutOfRange(day)
                const isActive = Boolean(activeDate && day.hasSame(activeDate, 'day'))

                return (
                  <button
                    key={key}
                    type="button"
                    disabled={isDisabled}
                    onClick={() => handleSelectDate(day)}
                    className={`relative flex h-7 w-7 items-center justify-center text-xs tabular-nums transition-colors mx-auto cursor-pointer ${
                      isSelected
                        ? 'bg-accent text-white font-bold'
                        : isToday
                          ? 'border border-accent/60 text-accent font-semibold hover:bg-hover'
                          : isCurrentMonth
                            ? 'text-primary hover:bg-hover'
                            : 'text-muted/60 hover:bg-hover'
                    } ${isActive && !isSelected ? 'gc-option-active' : ''} ${
                      isDisabled ? 'opacity-20 cursor-not-allowed' : ''
                    }`}
                    style={{ borderRadius: 'var(--radius-control)' }}
                  >
                    {day.day}
                    {isToday && !isSelected && (
                      <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-accent" />
                    )}
                  </button>
                )
              })}
            </div>

            {/* Footer */}
            <div className="mt-2.5 flex items-center justify-between border-t border-hairline pt-2 text-[11px]">
              <button
                type="button"
                onClick={() => handleSelectDate(today)}
                className="font-medium text-accent hover:underline cursor-pointer"
              >
                {i18n.t('ui.today')} ({today.toFormat('dd/MM')})
              </button>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="text-muted hover:text-primary cursor-pointer transition-colors"
              >
                {i18n.t('ui.close')}
              </button>
            </div>
          </div>,
          document.body
        )
      : null

  return (
    <div className={`relative inline-block w-full ${className}`} ref={containerRef}>
      {label && (
        <label className="block text-[12px] font-normal text-muted mb-1.5">
          {label}
        </label>
      )}

      {/* Trigger Button — ghost: transparent, hairline on hover */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => !disabled && setIsOpen((prev) => !prev)}
        onKeyDown={(e) => {
          if (disabled || isOpen) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setIsOpen(true)
          }
        }}
        className={`gc-focus-ring flex items-center justify-between gap-1.5 w-full text-left select-none cursor-pointer overflow-hidden transition-colors duration-100 bg-transparent border outline-none focus:outline-none focus:ring-0 ${
          isOpen ? 'border-hairline bg-hover/40' : 'border-transparent hover:border-hairline hover:bg-hover/30'
        } ${compact ? 'px-2 py-1 text-xs' : 'px-2.5 py-1.5 text-xs'} ${
          disabled ? 'opacity-50 cursor-not-allowed' : ''
        }`}
        style={{ borderRadius: 'var(--radius-control)' }}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
          <CalendarIcon
            className={`shrink-0 h-3.5 w-3.5 transition-colors ${
              isOpen || parsedValue ? 'text-accent' : 'text-muted'
            }`}
          />
          <span
            className={`truncate tabular-nums ${
              parsedValue ? 'text-primary font-medium' : 'text-muted'
            }`}
          >
            {parsedValue ? displayLabel : placeholder}
          </span>
        </div>

        {parsedValue && !disabled && (
          <div
            onClick={handleClear}
            className="p-0.5 text-muted hover:text-primary transition-colors shrink-0 cursor-pointer"
            title={i18n.t('ui.clearDate')}
            style={{ borderRadius: 'var(--radius-control)' }}
          >
            <X className="h-3.5 w-3.5" />
          </div>
        )}
      </button>

      {popover}
    </div>
  )
}

export default DatePicker
