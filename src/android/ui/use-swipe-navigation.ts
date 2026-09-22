import { useEffect, type RefObject } from 'react'
import type { AppShellContext } from '@renderer/App'

/** Minimum horizontal travel before a touch counts as a period swipe. */
const SWIPE_THRESHOLD_PX = 60
/** A gesture must be this much more horizontal than vertical to count. */
const DIRECTION_RATIO = 1.6
/** Slow drags are usually a mis-grab, not a flick. */
const MAX_DURATION_MS = 600

/**
 * Swipe left/right to move a period, replacing the desktop header arrows.
 *
 * Deliberately *not* active in every view. Week view scrolls horizontally on a
 * phone (seven columns do not fit), so a horizontal swipe already means
 * something there. Everywhere else - day, month, list and now year, which lays
 * a whole year out on one page instead of scrolling through months - there is
 * no competing horizontal gesture and the swipe is unambiguous.
 *
 * Touches that begin inside an event block are ignored so that starting a
 * drag never also flips the period.
 */
export function useSwipeNavigation(shellRef: RefObject<AppShellContext | null>): void {
  useEffect(() => {
    let startX = 0
    let startY = 0
    let startedAt = 0
    let tracking = false

    const onTouchStart = (e: TouchEvent): void => {
      const shell = shellRef.current
      if (!shell) return
      if (shell.currentView === 'week') return
      if (e.touches.length !== 1) return

      const target = e.target as HTMLElement | null
      // Never hijack a gesture that starts on a draggable event, inside the
      // drawer, or in a dialog.
      if (target?.closest('[draggable="true"], .gc-drawer, [role="dialog"]')) return

      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      startedAt = Date.now()
      tracking = true
    }

    const onTouchEnd = (e: TouchEvent): void => {
      if (!tracking) return
      tracking = false

      const shell = shellRef.current
      if (!shell) return

      const touch = e.changedTouches[0]
      if (!touch) return

      const dx = touch.clientX - startX
      const dy = touch.clientY - startY

      if (Date.now() - startedAt > MAX_DURATION_MS) return
      if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return
      if (Math.abs(dx) < Math.abs(dy) * DIRECTION_RATIO) return

      // Swiping left pulls the next period into view, matching the direction
      // of travel users expect from a paged surface.
      if (dx < 0) shell.goNext()
      else shell.goPrev()
    }

    const onTouchCancel = (): void => {
      tracking = false
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    document.addEventListener('touchcancel', onTouchCancel, { passive: true })

    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [shellRef])
}
