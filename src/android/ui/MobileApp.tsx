import React, { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { App as CapacitorApp } from '@capacitor/app'
import App, { type AppShellContext } from '@renderer/App'
import MobileHeader from './MobileHeader'
import BottomNav from './BottomNav'
import CalendarDrawer from './CalendarDrawer'
import { useWeekScrollSync } from './use-week-scroll-sync'
import { useSwipeNavigation } from './use-swipe-navigation'
import { useAndroidBackButton, dismissTopLayer } from './use-back-button'

/**
 * The Android shell.
 *
 * `App` is the desktop container, imported unchanged - it still owns every
 * piece of calendar state, all five views, the editor, drag/drop and the
 * modals. This file supplies only the chrome through App's render props, so
 * there is exactly one implementation of the calendar itself and no second
 * copy to keep in step.
 */
const MobileApp: React.FC = () => {
  const { i18n } = useTranslation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // The shell context is handed to us on every render of App; keeping the
  // latest in a ref lets the gesture handlers below reach it without
  // re-subscribing their listeners on each frame.
  const shellRef = useRef<AppShellContext | null>(null)

  useWeekScrollSync()
  useSwipeNavigation(shellRef)
  useAndroidBackButton(() => {
    const dismissed = dismissTopLayer({
      isOverlayOpen: Boolean(shellRef.current?.isOverlayOpen),
      drawerOpen,
      closeDrawer
    })
    // Nothing left to close. Minimise rather than exit, so returning to the
    // app keeps the warm database handle and the current view.
    if (!dismissed) void CapacitorApp.minimizeApp()
  })

  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  /**
   * `visible-range.ts` deliberately returns an empty label for the list view -
   * every row there carries its own date, so the desktop header would just be
   * repeating itself. The desktop bar still has a view switcher and search box
   * to fill it; the compact mobile bar does not, so an empty string leaves it
   * looking like a failed render. Fall back to the period the list is anchored
   * in, which is the one thing the rows themselves do not tell you.
   */
  const headerTitle = (shell: AppShellContext): string =>
    shell.rangeLabel || shell.anchorDate.setLocale(i18n.language).toFormat('LLLL yyyy')

  return (
    <App
      renderHeader={(shell) => {
        shellRef.current = shell
        return (
          <MobileHeader
            title={headerTitle(shell)}
            conflictCount={shell.conflictCount}
            onOpenDrawer={() => setDrawerOpen(true)}
            onSearch={shell.openSearch}
            onToday={shell.goToday}
            onOpenConflicts={shell.openConflicts}
          />
        )
      }}
      renderSidebar={(shell) => (
        <CalendarDrawer open={drawerOpen} onClose={closeDrawer} shell={shell} />
      )}
      renderBottomBar={(shell) => (
        <BottomNav
          currentView={shell.currentView}
          onChangeView={shell.setCurrentView}
          onCreate={() => shell.newEventOn(shell.anchorDate)}
        />
      )}
    />
  )
}

export default MobileApp
