import { useTranslation } from 'react-i18next'
import React, { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check, Search } from 'lucide-react'
import { nextEnabledIndex, firstEnabledIndex } from '../../lib/roving-index'

export interface SelectOption {
  value: string
  label: string
  color?: string
  icon?: React.ReactNode
  badge?: string
  description?: string
  disabled?: boolean
}

export interface CustomSelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  label?: string
  searchable?: boolean
  searchPlaceholder?: string
  disabled?: boolean
  /** 'ghost' = transparent trigger with hairline on hover/focus (default).
   *  'boxed' = bg-surface trigger with hairline always. */
  variant?: 'ghost' | 'boxed'
  className?: string
  align?: 'left' | 'right'
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  onChange,
  options = [],
  placeholder,
  label,
  searchable = false,
  searchPlaceholder,
  disabled = false,
  variant = 'ghost',
  className = '',
  align = 'left'
}) => {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const activeItemRef = useRef<HTMLButtonElement>(null)
  // Which option the arrow keys are resting on. The popover lives in a portal
  // at the end of <body>, so it is nowhere near the trigger in tab order -
  // walking it with a roving index is the only way the keyboard reaches it.
  const [activeIndex, setActiveIndex] = useState(-1)

  const isOptionDisabled = (opt: SelectOption): boolean => Boolean(opt.disabled)

  const selectedOption = useMemo(
    () => (options || []).find((opt) => opt.value === value),
    [options, value]
  )

  const filteredOptions = useMemo(() => {
    const list = options || []
    if (!searchable || !searchQuery.trim()) return list
    const q = searchQuery.toLowerCase().trim()
    return list.filter(
      (opt) =>
        (opt.label && opt.label.toLowerCase().includes(q)) ||
        (opt.description && opt.description.toLowerCase().includes(q)) ||
        (opt.value && opt.value.toLowerCase().includes(q))
    )
  }, [options, searchable, searchQuery])

  const updateCoords = () => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const popoverWidth = Math.max(rect.width, 220)
    const popoverHeight = Math.min(260, (options.length + (searchable ? 1 : 0)) * 36 + 24)

    let left = align === 'right' ? rect.right - popoverWidth : rect.left
    if (left + popoverWidth > window.innerWidth - 8) {
      left = window.innerWidth - popoverWidth - 8
    }
    if (left < 8) {
      left = 8
    }

    let top = rect.bottom + 4
    if (top + popoverHeight > window.innerHeight - 8 && rect.top - popoverHeight - 4 > 8) {
      top = rect.top - popoverHeight - 4
    }

    setCoords({ top, left, width: popoverWidth })
  }

  // Open on whatever is currently selected, so the first arrow press steps off
  // the real value rather than off the top of the list.
  useEffect(() => {
    if (!isOpen) return
    const selected = filteredOptions.findIndex((opt) => opt.value === value && !opt.disabled)
    setActiveIndex(selected >= 0 ? selected : firstEnabledIndex(filteredOptions, 'start', isOptionDisabled))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // Filtering can shrink the list out from under the cursor.
  useEffect(() => {
    if (!isOpen) return
    setActiveIndex((prev) =>
      prev < filteredOptions.length ? prev : firstEnabledIndex(filteredOptions, 'start', isOptionDisabled)
    )
  }, [isOpen, filteredOptions])

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // Focus search input and update coordinates when opening
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('')
      return
    }

    updateCoords()
    if (searchable) {
      setTimeout(() => {
        searchInputRef.current?.focus()
      }, 50)
    }

    const handleScrollOrResize = () => {
      updateCoords()
    }
    window.addEventListener('resize', handleScrollOrResize)
    window.addEventListener('scroll', handleScrollOrResize, true)
    return () => {
      window.removeEventListener('resize', handleScrollOrResize)
      window.removeEventListener('scroll', handleScrollOrResize, true)
    }
  }, [isOpen, searchable, align, options.length])

  // Click outside & Escape key
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

    // Focus stays on the trigger (or the search box) while the list is open, so
    // the list is driven from here rather than by tabbing into it.
    const step = (delta: number) => {
      setActiveIndex((prev) => nextEnabledIndex(filteredOptions, prev, delta, isOptionDisabled))
    }

    const edge = (from: 'start' | 'end') => {
      const found = firstEnabledIndex(filteredOptions, from, isOptionDisabled)
      if (found >= 0) setActiveIndex(found)
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          // Without stopPropagation this same Escape carries on to the dialog
          // hosting the field and closes that too.
          e.preventDefault()
          e.stopPropagation()
          setIsOpen(false)
          triggerRef.current?.focus()
          break
        case 'ArrowDown':
          e.preventDefault()
          step(1)
          break
        case 'ArrowUp':
          e.preventDefault()
          step(-1)
          break
        case 'Home':
          e.preventDefault()
          edge('start')
          break
        case 'End':
          e.preventDefault()
          edge('end')
          break
        case 'Enter':
          // Not just a shortcut for clicking: preventDefault also stops the
          // browser turning this keydown into a click on the focused trigger,
          // which would reopen the list the moment it closed.
          e.preventDefault()
          if (activeIndex >= 0 && filteredOptions[activeIndex]) {
            handleSelect(filteredOptions[activeIndex])
            triggerRef.current?.focus()
          }
          break
        case 'Tab':
          // The list is a portal at the end of <body>; letting Tab walk into it
          // would strand focus miles from the field. Close and hand the trigger
          // back instead.
          e.preventDefault()
          setIsOpen(false)
          triggerRef.current?.focus()
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
  }, [isOpen, filteredOptions, activeIndex])

  const handleSelect = (opt: SelectOption) => {
    if (opt.disabled) return
    onChange(opt.value)
    setIsOpen(false)
  }

  const isGhost = variant === 'ghost'

  const popover =
    isOpen && coords && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[99999] border border-hairline bg-surface p-1 text-primary shadow-xl animate-popover select-none"
            style={{
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              width: `${coords.width}px`,
              borderRadius: 'var(--radius-dialog)',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18), 0 0 0 1px var(--color-border)'
            }}
          >
            {/* Search Box */}
            {searchable && (
              <div className="p-1 border-b border-hairline mb-1">
                <div
                  className="flex items-center gap-1.5 px-2 py-1 text-xs bg-hover/50"
                  style={{ borderRadius: 'var(--radius-control)' }}
                >
                  <Search className="h-3.5 w-3.5 text-muted shrink-0" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={searchPlaceholder ?? t('ui.searchPlaceholder')}
                    className="w-full bg-transparent text-xs text-primary placeholder:text-muted focus:outline-none"
                  />
                </div>
              </div>
            )}

            {/* Option Items */}
            <div className="max-h-56 overflow-y-auto space-y-0.5 pr-0.5">
              {filteredOptions.length === 0 ? (
                <div className="py-4 text-center text-xs text-muted">
                  {t('ui.noResults')}
                </div>
              ) : (
                filteredOptions.map((opt, idx) => {
                  const isSelected = opt.value === value
                  const isActive = idx === activeIndex
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      disabled={opt.disabled}
                      ref={isActive ? activeItemRef : undefined}
                      onClick={() => handleSelect(opt)}
                      onMouseEnter={() => !opt.disabled && setActiveIndex(idx)}
                      className={`flex w-full items-center justify-between gap-2 px-2 py-1.5 text-xs text-left transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-hover text-primary font-medium'
                          : 'text-primary hover:bg-hover'
                      } ${isActive ? 'gc-option-active' : ''} ${opt.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                      style={{ borderRadius: 'var(--radius-control)' }}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {opt.color && (
                          <span
                            className="h-2.5 w-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: opt.color }}
                          />
                        )}

                        {opt.icon && <span className="shrink-0">{opt.icon}</span>}

                        <div className="min-w-0 flex-1">
                          <div className="truncate">{opt.label}</div>
                          {opt.description && (
                            <div className="text-[10px] text-muted truncate">
                              {opt.description}
                            </div>
                          )}
                        </div>

                        {opt.badge && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 bg-hover text-muted shrink-0"
                            style={{ borderRadius: 'var(--radius-control)' }}
                          >
                            {opt.badge}
                          </span>
                        )}
                      </div>

                      {isSelected && (
                        <Check className="h-3.5 w-3.5 text-accent shrink-0" />
                      )}
                    </button>
                  )
                })
              )}
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

      {/* Trigger Button */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => !disabled && setIsOpen((prev) => !prev)}
        onKeyDown={(e) => {
          // Only opening is handled here - once open the list is driven by the
          // document listener above, which also swallows these same keys.
          if (disabled || isOpen) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setIsOpen(true)
          }
        }}
        className={`gc-focus-ring flex items-center justify-between gap-2 w-full px-2.5 py-1.5 text-xs text-left transition-colors duration-100 select-none cursor-pointer outline-none focus:outline-none focus:ring-0 ${
          isGhost
            ? `bg-transparent border ${
                isOpen ? 'border-hairline bg-hover/40' : 'border-transparent hover:border-hairline hover:bg-hover/30'
              }`
            : `bg-surface border ${isOpen ? 'border-accent' : 'border-hairline'}`
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        style={{ borderRadius: 'var(--radius-control)' }}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {selectedOption?.color && (
            <span
              className="h-2.5 w-2.5 rounded-full shrink-0"
              style={{ backgroundColor: selectedOption.color }}
            />
          )}

          {selectedOption?.icon && (
            <span className="shrink-0 text-muted">{selectedOption.icon}</span>
          )}

          <span
            className={`truncate font-medium ${
              selectedOption ? 'text-primary' : 'text-muted'
            }`}
          >
            {selectedOption ? selectedOption.label : placeholder}
          </span>

          {selectedOption?.badge && (
            <span
              className="text-[10px] px-1.5 py-0.5 bg-hover text-muted shrink-0"
              style={{ borderRadius: 'var(--radius-control)' }}
            >
              {selectedOption.badge}
            </span>
          )}
        </div>

        <ChevronDown
          className={`h-3.5 w-3.5 text-muted shrink-0 transition-transform duration-150 ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {popover}
    </div>
  )
}

export default CustomSelect
