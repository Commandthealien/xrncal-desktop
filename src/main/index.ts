import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { loadCredentialsFile } from './load-credentials'
import { adoptLegacyUserDataForApp } from './adopt-legacy-userdata'
import { initDatabase, closeDatabase } from './db/database'
import { setupTray } from './tray'
import { registerMiniIpcHandlers } from './mini-window'
import { getSyncWorker } from './ipc/auth-sync-ipc'
import { isSafeExternalUrl } from './safe-external-url'

// Enforce single instance lock
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  function createWindow(): void {
    // Dark is the default theme; paint the window with the dark canvas colour
    // so there is no light flash before the renderer mounts.
    const initialBg = '#2b2d31'

    mainWindow = new BrowserWindow({
      width: 1240,
      height: 820,
      minWidth: 860,
      minHeight: 580,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: initialBg,
      title: 'xrncal',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true
      }
    })

    mainWindow.on('ready-to-show', () => {
      mainWindow?.show()
    })

    // Closing the window destroys it, but the app can outlive it - the tray and
    // a hidden mini window keep it running. Forget the dead window so the next
    // request builds a new one instead of calling into a destroyed object.
    mainWindow.on('closed', () => {
      mainWindow = null
    })

    // Adaptive sync polling on focus/blur; also sync right away when the user comes back
    mainWindow.on('focus', () => {
      const worker = getSyncWorker()
      worker?.setFocusState(true)
      worker?.triggerSync().catch(() => {})
    })

    mainWindow.on('blur', () => {
      getSyncWorker()?.setFocusState(false)
    })

    // Open target links in default external browser, not in Electron shell.
    // Only web and mail schemes are handed to the OS: event titles, locations
    // and meeting links arrive from synced providers, so the URL here is not
    // necessarily something the user typed, and shell.openExternal will happily
    // launch a registered handler for file:, smb:, or any custom scheme.
    mainWindow.webContents.setWindowOpenHandler((details) => {
      if (isSafeExternalUrl(details.url)) {
        shell.openExternal(details.url)
      } else {
        console.warn('Blocked window.open for disallowed URL scheme')
      }
      return { action: 'deny' }
    })

    // The app is a fixed local document; nothing should ever navigate the
    // top-level frame away from it. Without this, a link or injected content
    // could replace the renderer with a remote page that keeps the preload
    // bridge in scope.
    mainWindow.webContents.on('will-navigate', (event, url) => {
      const rendererUrl = process.env['ELECTRON_RENDERER_URL']
      const isDevServer = Boolean(rendererUrl && url.startsWith(rendererUrl))
      const isLocalFile = url.startsWith('file://')
      if (!isDevServer && !isLocalFile) {
        event.preventDefault()
        if (isSafeExternalUrl(url)) shell.openExternal(url)
      }
    })

    // Load URL in dev or index.html in production
    if (process.env['ELECTRON_RENDERER_URL']) {
      mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  /**
   * Bring the main window to the front, building a new one if it was closed.
   * Everything that means "open xrncal" goes through here: launching it again,
   * the tray's Open item and the mini window's button. Each used to poke the
   * first window it was given; once that window had been closed while the tray
   * kept the app alive, launching threw "Object has been destroyed" in a modal
   * error box and the tray item silently did nothing - the app was stuck until
   * it was killed.
   */
  function showMainWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return // shown on ready-to-show
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  // Launching again while running opens the existing app instead of a second copy.
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(() => {
    adoptLegacyUserDataForApp()
    loadCredentialsFile()

    try {
      initDatabase(app.getPath('userData'))
    } catch (dbErr) {
      console.error('Failed to initialize database:', dbErr)
    }

    registerIpcHandlers()
    createWindow()

    registerMiniIpcHandlers(showMainWindow)
    try {
      setupTray(showMainWindow)
    } catch (err) {
      console.warn('System tray initialization skipped or unsupported:', err)
    }

    app.on('activate', () => showMainWindow())
  })

  app.on('window-all-closed', () => {
    closeDatabase()
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
