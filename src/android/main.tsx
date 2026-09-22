// Must come first: installs Buffer and process before any src/main module's
// body runs. See src/android/boot/polyfills.ts.
import './boot/polyfills'

import React from 'react'
import ReactDOM from 'react-dom/client'
import { App as CapacitorApp } from '@capacitor/app'
import { StatusBar, Style } from '@capacitor/status-bar'
import { Keyboard } from '@capacitor/keyboard'

import '@renderer/styles/index.css'
import './ui/mobile.css'
import '@renderer/i18n'

import { initDatabase, closeDatabase } from '@main/db/database'
import { registerIpcHandlers } from '@main/ipc'
import { loadCredentialsFile } from '@main/load-credentials'
import { getSyncWorker } from '@main/ipc/auth-sync-ipc'
import { app as hostApp } from './shims/electron'
import { waitForNativeBridge } from './native/bridge'
import { installWindowInsets } from './platform/window-insets'
import { installKeyboardInset } from './platform/keyboard-inset'
import { installTouchDrag } from './ui/touch-drag'

import ErrorBoundary from '@renderer/components/ErrorBoundary'
import MobileApp from './ui/MobileApp'
import BootFailure from './ui/BootFailure'

/**
 * Android entry point.
 *
 * This is the file that replaces `src/main/index.ts` *and*
 * `src/renderer/src/main.tsx`. On desktop those are two processes joined by a
 * preload script; here they are one JS context, so the boot sequence runs
 * top to bottom: bring up the database, register the IPC handlers, let the
 * preload module publish `window.xrncal`, then mount React.
 *
 * The order is not cosmetic. `src/preload/index.ts` is imported *after*
 * `registerIpcHandlers()` so that no renderer effect can invoke a channel
 * before its handler exists - on desktop the process boundary made that
 * impossible by construction.
 */

async function boot(): Promise<void> {
  const rootElement = document.getElementById('root')
  if (!rootElement) return
  const root = ReactDOM.createRoot(rootElement)

  const fail = (reason: string, detail: unknown): void => {
    console.error(reason, detail)
    root.render(
      <React.StrictMode>
        <BootFailure reason={reason} detail={detail instanceof Error ? detail.message : String(detail)} />
      </React.StrictMode>
    )
  }

  // Before anything renders, so the first paint already has the right
  // padding rather than visibly reflowing once the host reports insets.
  installWindowInsets()
  installKeyboardInset()
  // Long-press drag for events and time-range selection; see touch-drag.ts.
  installTouchDrag()

  if (!(await waitForNativeBridge())) {
    fail(
      'The native bridge did not attach.',
      'window.XrncalNative is missing. This bundle has to run inside the xrncal ' +
        'Android host, which injects it in MainActivity.onCreate.'
    )
    return
  }

  try {
    // Same call the desktop main process makes, with app.getPath('userData')
    // resolving to the app's private data directory on Android.
    initDatabase(hostApp.getPath('userData'))
  } catch (err) {
    fail('The calendar database could not be opened.', err)
    return
  }

  try {
    loadCredentialsFile()
    // Registers every IPC handler and, inside registerAuthSyncIpcHandlers,
    // starts the sync worker and the reminder scheduler.
    registerIpcHandlers()
    // Side-effect import: publishes window.xrncal via the shimmed contextBridge.
    await import('../preload/index')
  } catch (err) {
    fail('The app failed to start.', err)
    return
  }

  await configureChrome()
  wireLifecycle()

  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <MobileApp />
      </ErrorBoundary>
    </React.StrictMode>
  )
}

/** Status bar and keyboard behaviour; failures here are never fatal. */
async function configureChrome(): Promise<void> {
  try {
    // Dark is xrncal's default theme, so light status-bar content.
    await StatusBar.setStyle({ style: Style.Dark })
    await StatusBar.setOverlaysWebView({ overlay: true })
  } catch {
    // Not available on every device/emulator image.
  }
  try {
    // The event editor is a full-height sheet; resizing the WebView would
    // reflow the whole calendar behind it on every keystroke.
    await Keyboard.setResizeMode({ mode: 'none' as any })
    await Keyboard.setScroll({ isDisabled: true })
  } catch {
    // Keyboard plugin is optional.
  }
}

/**
 * Desktop wires adaptive sync polling to BrowserWindow focus/blur in
 * src/main/index.ts. The Android analogue is the app moving between
 * foreground and background, which is also when the OS is most likely to
 * freeze our timers - so a resume additionally kicks an immediate sync.
 */
function wireLifecycle(): void {
  void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    const worker = getSyncWorker()
    worker?.setFocusState(isActive)
    if (isActive) worker?.triggerSync().catch(() => {})
  })

  void CapacitorApp.addListener('pause', () => {
    getSyncWorker()?.setFocusState(false)
  })

  // Android can kill the process without further warning, but a clean
  // shutdown when we do get notice lets SQLite checkpoint the WAL.
  window.addEventListener('beforeunload', () => {
    try {
      closeDatabase()
    } catch {
      // Nothing useful to do while the context is being torn down.
    }
  })
}

void boot()
