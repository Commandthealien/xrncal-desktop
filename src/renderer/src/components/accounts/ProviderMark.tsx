import React from 'react'
import { Cloud, Flag, Laptop, Server } from 'lucide-react'
import type { ProviderKind } from '../../lib/account-display'

/**
 * The small square that says where a calendar comes from. Monochrome on
 * purpose - the calendars' own colours are the only colour in the sidebar - but
 * recognisable at a glance, which the old G/M/C/L initials were not.
 */
export const ProviderMark: React.FC<{ kind: ProviderKind; size?: 'sm' | 'md' }> = ({ kind, size = 'md' }) => {
  const box = size === 'sm' ? 'h-4 w-4' : 'h-7 w-7'
  const icon = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'
  return (
    <span
      aria-hidden
      className={`${box} inline-flex shrink-0 items-center justify-center text-muted ${
        size === 'md' ? 'border border-hairline bg-hover' : ''
      }`}
      style={{ borderRadius: 'var(--radius-control)' }}
    >
      {kind === 'google' && (
        <span className={`font-semibold leading-none ${size === 'sm' ? 'text-[10px]' : 'text-[13px]'}`}>G</span>
      )}
      {kind === 'graph' && (
        // Microsoft's four squares, drawn in the text colour.
        <svg viewBox="0 0 16 16" className={icon} fill="currentColor">
          <rect x="1" y="1" width="6.5" height="6.5" />
          <rect x="8.5" y="1" width="6.5" height="6.5" opacity="0.75" />
          <rect x="1" y="8.5" width="6.5" height="6.5" opacity="0.75" />
          <rect x="8.5" y="8.5" width="6.5" height="6.5" opacity="0.5" />
        </svg>
      )}
      {kind === 'icloud' && <Cloud className={icon} />}
      {kind === 'caldav' && <Server className={icon} />}
      {kind === 'local' && <Laptop className={icon} />}
      {kind === 'holidays' && <Flag className={icon} />}
    </span>
  )
}

export default ProviderMark
