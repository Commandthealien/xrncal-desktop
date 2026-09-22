import React from 'react'
import { useTranslation } from 'react-i18next'
import { Menu, Search, AlertTriangle, CalendarClock } from 'lucide-react'

interface Props {
  title: string
  conflictCount: number
  onOpenDrawer: () => void
  onSearch: () => void
  onToday: () => void
  onOpenConflicts: () => void
}

/**
 * Compact top bar. The desktop header carries navigation arrows, a view
 * switcher, a search field and an overflow menu; on a phone the view switcher
 * moves to the bottom nav and the arrows are replaced by horizontal swipe, so
 * only the title and two actions remain.
 *
 * The bar sits below the status bar - StatusBar.setOverlaysWebView(true) means
 * the WebView paints underneath it, so the inset is added as padding here.
 */
const MobileHeader: React.FC<Props> = ({
  title,
  conflictCount,
  onOpenDrawer,
  onSearch,
  onToday,
  onOpenConflicts
}) => {
  const { t } = useTranslation()

  return (
    <header className="gc-mobile-header flex items-center gap-1 border-b border-hairline bg-sidebar px-1">
      <IconButton label={t('nav.menu', { defaultValue: 'Menu' })} onClick={onOpenDrawer}>
        <Menu size={20} />
      </IconButton>

      <h1 className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold text-primary">
        {title}
      </h1>

      {conflictCount > 0 && (
        <IconButton
          label={t('sync.conflicts', { defaultValue: 'Sync conflicts' })}
          onClick={onOpenConflicts}
        >
          <span className="relative">
            <AlertTriangle size={19} className="text-[var(--color-today-mark)]" />
            <span className="absolute -top-1 -right-1.5 min-w-[14px] rounded-[3px] bg-[var(--color-today-mark)] px-0.5 text-center text-[9px] leading-[14px] font-bold text-white">
              {conflictCount > 9 ? '9+' : conflictCount}
            </span>
          </span>
        </IconButton>
      )}

      <IconButton label={t('nav.today', { defaultValue: 'Today' })} onClick={onToday}>
        <CalendarClock size={19} />
      </IconButton>

      <IconButton label={t('search.title', { defaultValue: 'Search' })} onClick={onSearch}>
        <Search size={19} />
      </IconButton>
    </header>
  )
}

const IconButton: React.FC<{
  label: string
  onClick: () => void
  children: React.ReactNode
}> = ({ label, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    onClick={onClick}
    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[3px] text-muted transition-colors active:bg-hover"
  >
    {children}
  </button>
)

export default MobileHeader
