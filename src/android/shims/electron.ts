import { nativeBridge, unwrap } from '../native/bridge'
import { join } from './node-path'
import { toBase64 } from './buffer-polyfill'

/**
 * In-process stand-in for the `electron` module.
 *
 * Desktop xrncal has a real process boundary: `ipcMain.handle` lives in main,
 * `ipcRenderer.invoke` in the renderer, and the preload bridge joins them.
 * Android has one JS context, so the boundary collapses - but the *shape* is
 * kept exactly, because that is what lets `src/main/ipc/*.ts` and
 * `src/preload/index.ts` run here byte-for-byte unchanged. `invoke` simply
 * looks the channel up in the same map `handle` wrote to.
 *
 * Keeping the fiction costs one map lookup per call and saves re-implementing
 * ~700 lines of handler logic that would then have to be kept in step with
 * the desktop copy forever.
 */

// --- IPC --------------------------------------------------------------------

type Handler = (event: unknown, ...args: any[]) => any

const handlers = new Map<string, Handler>()
const listeners = new Map<string, Set<(...args: any[]) => void>>()

export const ipcMain = {
  handle(channel: string, handler: Handler): void {
    handlers.set(channel, handler)
  },
  handleOnce(channel: string, handler: Handler): void {
    handlers.set(channel, (...args) => {
      handlers.delete(channel)
      return handler(...(args as [unknown, ...any[]]))
    })
  },
  removeHandler(channel: string): void {
    handlers.delete(channel)
  },
  on(channel: string, listener: (...args: any[]) => void): void {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(listener)
  }
}

interface IpcRendererShim {
  invoke(channel: string, ...args: any[]): Promise<any>
  on(channel: string, listener: (...args: any[]) => void): IpcRendererShim
  removeListener(channel: string, listener: (...args: any[]) => void): IpcRendererShim
  send(channel: string, ...args: any[]): void
}

export const ipcRenderer: IpcRendererShim = {
  async invoke(channel: string, ...args: any[]): Promise<any> {
    const handler = handlers.get(channel)
    if (!handler) {
      // Electron rejects with this exact shape; the renderer's error paths
      // (showFriendlyError) already know how to read it.
      throw new Error(`No handler registered for '${channel}'`)
    }
    // Always resolve asynchronously. On desktop every invoke crosses a process
    // boundary and is therefore a macrotask; a synchronous resolve here would
    // let renderer code observe state the desktop build never could, and the
    // difference would only show up as a race under load.
    return await Promise.resolve().then(() => handler({ sender: fakeWebContents }, ...args))
  },

  on(channel: string, listener: (...args: any[]) => void): IpcRendererShim {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(listener)
    return ipcRenderer
  },

  removeListener(channel: string, listener: (...args: any[]) => void): IpcRendererShim {
    listeners.get(channel)?.delete(listener)
    return ipcRenderer
  },

  send(channel: string, ...args: any[]): void {
    emit(channel, ...args)
  }
}

function emit(channel: string, ...args: any[]): void {
  const set = listeners.get(channel)
  if (!set) return
  // Copy first: a listener that unsubscribes itself (the pattern the sync
  // subscription in App.tsx uses on unmount) would otherwise mutate the set
  // mid-iteration.
  for (const listener of [...set]) {
    try {
      listener({}, ...args)
    } catch (err) {
      console.error(`Listener for '${channel}' threw:`, err)
    }
  }
}

// --- contextBridge ----------------------------------------------------------

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    // There is no isolated world to bridge into; assigning is the whole job.
    ;(window as any)[key] = api
  }
}

// --- BrowserWindow ----------------------------------------------------------

const fakeWebContents = {
  send(channel: string, ...args: any[]): void {
    emit(channel, ...args)
  }
}

/**
 * A single always-present window. `sync-worker.ts` iterates
 * `BrowserWindow.getAllWindows()` to push SYNC.CHANGED, and `ipc.ts` asks for
 * the focused window to parent its dialogs; both work against this.
 */
const theWindow = {
  webContents: fakeWebContents,
  isDestroyed: () => false,
  isMinimized: () => false,
  restore: () => {},
  focus: () => {},
  show: () => {},
  on: () => {},
  setAlwaysOnTop: () => {}
}

export const BrowserWindow = {
  getAllWindows: () => [theWindow],
  getFocusedWindow: () => theWindow
}

// --- app --------------------------------------------------------------------

let cachedDataDir: string | null = null
let cachedCacheDir: string | null = null

function dataDir(): string {
  if (cachedDataDir === null) {
    cachedDataDir = unwrap<string>('dirData', nativeBridge().dirData())
  }
  return cachedDataDir
}

function cacheDir(): string {
  if (cachedCacheDir === null) {
    cachedCacheDir = unwrap<string>('dirCache', nativeBridge().dirCache())
  }
  return cachedCacheDir
}

export const app = {
  getVersion(): string {
    try {
      return unwrap<string>('appVersion', nativeBridge().appVersion())
    } catch {
      return '0.0.0'
    }
  },

  /**
   * Android's storage model has no direct analogue for most of Electron's
   * well-known paths. The three xrncal asks for map cleanly onto the app's
   * private directories, which need no runtime permission.
   */
  getPath(name: string): string {
    switch (name) {
      case 'userData':
      case 'appData':
        return dataDir()
      case 'temp':
        return cacheDir()
      case 'documents':
      case 'downloads':
        return join(dataDir(), 'Documents')
      default:
        return dataDir()
    }
  },

  getName: () => 'xrncal',
  getLocale: () => navigator.language || 'en',
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  on: () => {},
  quit: () => {},
  exit: () => {},
  relaunch: () => {}
}

// --- dialog -----------------------------------------------------------------

export interface OpenDialogReturn {
  canceled: boolean
  filePaths: string[]
}

export interface SaveDialogReturn {
  canceled: boolean
  filePath?: string
}

/**
 * Android has no blocking file dialog. An `<input type="file">` gives the
 * system picker, but hands back a `File`, not a path - and `ipc.ts` goes on to
 * `readFile(filePath)`. The picked bytes are therefore staged into the app's
 * cache directory and the *cache path* is returned, so the caller's
 * read-by-path continues to work unchanged.
 */
export const dialog = {
  async showOpenDialog(...args: any[]): Promise<OpenDialogReturn> {
    const options = (args.length > 1 ? args[1] : args[0]) ?? {}
    const accept = (options.filters ?? [])
      .flatMap((f: any) => (f.extensions ?? []).map((e: string) => `.${e}`))
      .join(',')

    const file = await pickFile(accept)
    if (!file) return { canceled: true, filePaths: [] }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const staged = join(cacheDir(), `picked_${Date.now()}_${sanitise(file.name)}`)
    unwrap<null>('fsWriteBase64', nativeBridge().fsWriteBase64(staged, toBase64(bytes)))
    return { canceled: false, filePaths: [staged] }
  },

  /**
   * There is no "save as" dialog either. A destination inside the app's own
   * Documents directory is chosen here, and the swapped `backup.ts` hands the
   * finished file to Android's share sheet so the user can put it wherever
   * they like - which is the platform-native equivalent of picking a path.
   */
  async showSaveDialog(...args: any[]): Promise<SaveDialogReturn> {
    const options = (args.length > 1 ? args[1] : args[0]) ?? {}
    const suggested = options.defaultPath ? basenameOf(options.defaultPath) : `xrncal-backup.sqlite`
    const dir = join(dataDir(), 'Documents')
    unwrap<null>('fsMkdirs', nativeBridge().fsMkdirs(dir))
    return { canceled: false, filePath: join(dir, sanitise(suggested)) }
  },

  async showMessageBox(): Promise<{ response: number }> {
    return { response: 0 }
  }
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function sanitise(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.style.display = 'none'
    document.body.appendChild(input)

    let settled = false
    const finish = (file: File | null): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(file)
    }

    input.addEventListener('change', () => finish(input.files?.[0] ?? null))
    // A cancelled picker fires no `change` event on Android WebView. `focus`
    // returning to the document is the only reliable cancellation signal;
    // the delay lets a real `change` land first.
    window.addEventListener(
      'focus',
      () => setTimeout(() => finish(input.files?.[0] ?? null), 500),
      { once: true }
    )

    input.click()
  })
}

// --- shell ------------------------------------------------------------------

export const shell = {
  openExternal(url: string): Promise<void> {
    // Routed through the host so links leave the WebView and open in the
    // user's browser, matching desktop behaviour.
    window.open(url, '_blank', 'noopener,noreferrer')
    return Promise.resolve()
  },

  /**
   * "Reveal in file manager" has no Android equivalent. Handing the file to
   * the share sheet is the closest useful behaviour, and it is what the one
   * caller (`shareIcs`) actually wants.
   */
  showItemInFolder(path: string): void {
    try {
      const mime = path.endsWith('.ics') ? 'text/calendar' : 'application/octet-stream'
      unwrap<null>('shareFile', nativeBridge().shareFile(path, mime, 'Share event'))
    } catch (err) {
      console.error('Share failed:', err)
    }
  },

  openPath: async (path: string): Promise<string> => {
    shell.showItemInFolder(path)
    return ''
  }
}

// --- safeStorage / Notification --------------------------------------------
// `secure-store.ts` and `reminder-scheduler.ts` are both swapped for
// Android-native implementations, so nothing should reach these. They throw
// rather than degrade: a silent plaintext fallback for tokens is exactly the
// failure the desktop build refuses to make on Linux without a keyring.

// The signatures mirror Electron's so that the desktop modules which are
// *not* swapped - caldav-sync-engine.ts reaches SecureStore, for instance -
// still typecheck against this module.

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return false
  },
  encryptString(_plaintext: string): Buffer {
    throw new Error('safeStorage is not available on Android; use src/android/platform/secure-store.ts')
  },
  decryptString(_encrypted: Buffer): string {
    throw new Error('safeStorage is not available on Android; use src/android/platform/secure-store.ts')
  }
}

export interface NotificationOptions {
  title?: string
  body?: string
  silent?: boolean
  icon?: unknown
}

export class Notification {
  constructor(_options?: NotificationOptions) {}
  static isSupported(): boolean {
    return false
  }
  show(): void {
    throw new Error(
      'electron.Notification is not available on Android; reminder-scheduler.ts is swapped ' +
        'for a LocalNotifications implementation.'
    )
  }
  on(_event: string, _listener: (...args: any[]) => void): this {
    return this
  }
}

const emptyImage = { isEmpty: () => true, resize: (_opts?: unknown) => emptyImage }

export const nativeImage = {
  createFromPath: (_path: string) => emptyImage,
  createFromDataURL: (_url: string) => emptyImage,
  createFromBuffer: (_buffer: unknown, _opts?: unknown) => emptyImage
}

export const Menu = {
  buildFromTemplate: () => ({}),
  setApplicationMenu: () => {}
}

export class Tray {
  setToolTip(): void {}
  setContextMenu(): void {}
  on(): void {}
  destroy(): void {}
}

export default {
  app,
  ipcMain,
  ipcRenderer,
  contextBridge,
  BrowserWindow,
  dialog,
  shell,
  safeStorage,
  Notification,
  nativeImage,
  Menu,
  Tray
}
