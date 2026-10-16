import i18n from '../i18n'
import React from 'react'
import { convertSolarToLunar, formatLunarLabel } from '@shared/lunar-vietnam'

interface LunarLabelProps {
  day: number
  month: number
  year: number
  className?: string
  /** Show the lunar month even on an ordinary day (used for Monday in Week view). */
  forceMonth?: boolean
  /** Always show day/month, spelled out (day X, month Y) - for List view's full date line. */
  full?: boolean
  /** 'chip' marks mùng 1 and rằm with a tinted chip and a moon glyph; 'text' only
   *  colours them, for cells too small to hold a chip (Year view). */
  variant?: 'chip' | 'text'
}

/** Mùng 1 is the new moon, rằm the full moon. */
type MoonPhase = 'new' | 'full'

const PHASE_CLASSES: Record<MoonPhase, { text: string; chip: string }> = {
  new: { text: 'text-moon-new', chip: 'bg-moon-new/15 text-moon-new' },
  full: { text: 'text-moon-full', chip: 'bg-moon-full/15 text-moon-full' }
}

/** ○ for the new moon, ● for the full moon: the shape tells the two apart even
 *  where their colours do not (colour blindness, a dim screen, a busy background). */
const MoonGlyph: React.FC<{ phase: MoonPhase }> = ({ phase }) => (
  <span
    aria-hidden
    className={`inline-block h-2 w-2 shrink-0 rounded-full ${
      phase === 'full' ? 'bg-current' : 'border-[1.5px] border-current'
    }`}
  />
)

/**
 * The lunar date under or beside a solar one. Ordinary days are muted text;
 * mùng 1 and rằm - the days people keep - are marked the same way in every
 * view, in colours of their own (never today's red, which belongs to today).
 */
export const LunarLabel: React.FC<LunarLabelProps> = ({
  day,
  month,
  year,
  className = '',
  forceMonth = false,
  full = false,
  variant = 'chip'
}) => {
  const lunar = convertSolarToLunar(day, month, year)
  const info = formatLunarLabel(lunar)
  const phase: MoonPhase | null = info.isFirstDay ? 'new' : info.isFullMoon ? 'full' : null
  const label = info.isTet
    ? i18n.t('ui.lunarTetShort')
    : full
      ? i18n.t('ui.lunarFull', { day: lunar.day, month: lunar.month, leap: lunar.leap ? i18n.t('ui.lunarLeap') : '' })
      : forceMonth && !phase
        ? `${lunar.day}/${lunar.month}${lunar.leap ? '*' : ''}`
        : info.label

  const date = i18n.t('ui.lunarTooltip', {
    day: lunar.day,
    month: lunar.month,
    leap: lunar.leap ? i18n.t('ui.lunarLeap') : '',
    year: lunar.canChiYear
  })
  const title = phase
    ? `${i18n.t(info.isTet ? 'ui.lunarTet' : phase === 'new' ? 'ui.lunarNewMoon' : 'ui.lunarFullMoon')} · ${date}`
    : date

  if (!phase) {
    return (
      <span className={`text-[10px] tabular-nums tracking-tight text-muted ${className}`} title={title}>
        {label}
      </span>
    )
  }

  if (variant === 'text') {
    return (
      <span
        className={`text-[10px] font-semibold tabular-nums tracking-tight ${PHASE_CLASSES[phase].text} ${className}`}
        title={title}
      >
        {label}
      </span>
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[3px] px-1.5 py-0.5 text-[11px] leading-none tabular-nums tracking-tight ${
        info.isTet ? 'font-bold' : 'font-semibold'
      } ${PHASE_CLASSES[phase].chip} ${className}`}
      title={title}
    >
      <MoonGlyph phase={phase} />
      {label}
    </span>
  )
}

export default LunarLabel
