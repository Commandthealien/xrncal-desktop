/**
 * Synchronous bridge into the Android host.
 *
 * Capacitor's own plugin bridge is promise-based, which is fatal for this port:
 * `ISqliteDatabase` is a *synchronous* interface and every repo class in
 * `src/main/db/repos/` is written against it (`db.prepare(sql).get(id)`).
 * Making it async would mean rewriting the repos, the IPC handlers and the
 * three sync engines - i.e. most of the app.
 *
 * Android's `WebView.addJavascriptInterface` does not have that limitation:
 * methods on an injected object are called synchronously from JS and block
 * until the Java side returns. `XrncalNative` is that object. It is the only
 * place where the port departs from "the same code, different host".
 *
 * Every method returns a JSON envelope so errors cross the boundary as values
 * rather than as an opaque `null` - a thrown Java exception inside a
 * @JavascriptInterface method is swallowed by the WebView and surfaces to JS as
 * `null`, which would turn a constraint violation into a silent no-op.
 */

export interface NativeEnvelope<T> {
  ok: boolean
  value?: T
  error?: string
}

export interface NativeRunResult {
  changes: number
  lastInsertRowid: number
}

/** The raw `@JavascriptInterface` surface, exactly as Kotlin exposes it. */
export interface XrncalNativeBridge {
  // --- SQLite -------------------------------------------------------------
  dbOpen(path: string): string
  dbExec(sql: string): string
  dbQuery(sql: string, paramsJson: string): string
  dbRun(sql: string, paramsJson: string): string
  dbClose(): string

  // --- Filesystem ---------------------------------------------------------
  fsExists(path: string): boolean
  fsMkdirs(path: string): string
  fsReadBase64(path: string): string
  fsWriteBase64(path: string, base64: string): string
  fsUnlink(path: string): string
  fsSize(path: string): string

  // --- Well-known directories --------------------------------------------
  dirData(): string
  dirCache(): string

  // --- Keystore-backed encryption -----------------------------------------
  // Mirrors Electron's `safeStorage` contract rather than a key/value store,
  // because that is what the desktop SecureStore is written against: it keeps
  // the *ciphertext* in the settings table under `token:<accountId>`, and
  // `detach-account.ts` deletes that row directly. Storing secrets somewhere
  // else on Android would leave those rows orphaned on detach.
  secureAvailable(): boolean
  secureEncrypt(plaintext: string): string
  secureDecrypt(ciphertextBase64: string): string

  // --- Host metadata ------------------------------------------------------
  appVersion(): string

  /** Hand a file to Android's share sheet (the `shell.showItemInFolder` analogue). */
  shareFile(path: string, mimeType: string, title: string): string
}

declare global {
  interface Window {
    XrncalNative?: XrncalNativeBridge
  }
}

export class NativeBridgeError extends Error {
  constructor(method: string, detail: string) {
    super(`XrncalNative.${method} failed: ${detail}`)
    this.name = 'NativeBridgeError'
  }
}

export class NativeBridgeUnavailableError extends Error {
  constructor() {
    super(
      'The XrncalNative bridge is not attached. The web bundle is running outside ' +
        'the Android host (a plain browser, or before onPageStarted).'
    )
    this.name = 'NativeBridgeUnavailableError'
  }
}

export function hasNativeBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.XrncalNative !== 'undefined'
}

/**
 * Resolve once the host has attached the bridge.
 *
 * MainActivity injects it synchronously right after `super.onCreate()`, which
 * should always beat the page's first script. This poll exists so that if that
 * ever stops holding - a Capacitor change, a slow cold start, a WebView that
 * restores a frame early - the app reports a clear failure instead of
 * throwing NativeBridgeUnavailableError from somewhere deep in database init.
 */
export function waitForNativeBridge(timeoutMs = 3000): Promise<boolean> {
  if (hasNativeBridge()) return Promise.resolve(true)

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const poll = (): void => {
      if (hasNativeBridge()) {
        resolve(true)
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(poll, 25)
    }
    poll()
  })
}

export function nativeBridge(): XrncalNativeBridge {
  const bridge = typeof window !== 'undefined' ? window.XrncalNative : undefined
  if (!bridge) throw new NativeBridgeUnavailableError()
  return bridge
}

/**
 * Call a bridge method and unwrap its JSON envelope.
 *
 * A `null` return means the Java method threw before it could serialise an
 * envelope; the WebView converts that into `null` with no diagnostics, so it is
 * reported here rather than propagating as `undefined` into caller logic.
 */
export function unwrap<T>(method: keyof XrncalNativeBridge, raw: string | null): T {
  if (raw === null || raw === undefined) {
    throw new NativeBridgeError(String(method), 'native side threw before responding')
  }
  let parsed: NativeEnvelope<T>
  try {
    parsed = JSON.parse(raw) as NativeEnvelope<T>
  } catch {
    throw new NativeBridgeError(String(method), `unparseable response: ${raw.slice(0, 200)}`)
  }
  if (!parsed.ok) {
    throw new NativeBridgeError(String(method), parsed.error ?? 'unknown error')
  }
  return parsed.value as T
}
