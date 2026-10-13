import { app, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getDatabase } from './db/database'
import { SettingsRepo } from './db/repos/settings-repo'
import { mt } from './i18n-main'

/** How often a running app looks for a new release. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let started = false

function checksEnabled(): boolean {
  try {
    return new SettingsRepo(getDatabase()).getSetting('checkForUpdates')
  } catch {
    return false
  }
}

/**
 * Keep an installed build up to date from the project's GitHub releases.
 *
 * Only a packaged build can update itself, and on Linux only an AppImage - a
 * build run from source, or unpacked some other way, has nothing to replace.
 * A new release downloads in the background and installs when the app quits;
 * nothing restarts under the user. Asking GitHub is the one request the app
 * makes that is not to a calendar provider, so it follows the
 * `checkForUpdates` setting, read again before every check.
 */
export function startAutoUpdates(): void {
  if (started || !app.isPackaged) return
  if (process.platform === 'linux' && !process.env.APPIMAGE) return
  started = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Offline, rate-limited or no release yet: try again at the next interval.
  autoUpdater.on('error', () => {})
  autoUpdater.on('update-downloaded', (info) => {
    if (!Notification.isSupported()) return
    new Notification({
      title: mt('update.readyTitle', { version: info.version }),
      body: mt('update.readyBody')
    }).show()
  })

  const check = (): void => {
    if (checksEnabled()) void autoUpdater.checkForUpdates().catch(() => {})
  }
  check()
  setInterval(check, CHECK_INTERVAL_MS)
}
