import { existsSync, readFileSync } from '../shims/node-fs'
import { join } from '../shims/node-path'
import { app } from '../shims/electron'

/**
 * Android replacement for `src/main/load-credentials.ts`.
 *
 * Desktop reads a `KEY=VALUE` file from a few well-known locations because a
 * packaged Electron app has no build-time env injection. An APK does: Vite
 * inlines `import.meta.env.VITE_*` at build time, so that is the primary
 * source here.
 *
 * A file is still honoured as a second source, dropped at
 * `<app data>/xrncal.env` via adb - that keeps the "clone the repo, add your
 * own OAuth client" workflow usable on device without a rebuild.
 *
 * Note what is deliberately *not* read: the client secrets. A secret shipped
 * inside an APK is public - anyone can unzip it - so the Android OAuth flows
 * are PKCE-only public clients. See src/android/oauth/.
 */
export function credentialsFilePath(): string {
  return join(app.getPath('userData'), 'xrncal.env')
}

/**
 * Keys inlined by the `define` allowlist in vite.android.config.ts. Only
 * client *ids* appear here - the Android flows are public PKCE clients, and
 * a secret baked into an APK would be public anyway.
 */
const BUILD_TIME_KEYS = ['GOOGLE_OAUTH_CLIENT_ID', 'MICROSOFT_CLIENT_ID'] as const

export function loadCredentialsFile(): void {
  const env = (globalThis as any).process?.env as Record<string, string | undefined> | undefined
  if (!env) return

  // 1. Build-time values inlined by Vite.
  const buildEnv = (import.meta as any).env ?? {}
  for (const key of BUILD_TIME_KEYS) {
    const value = buildEnv[key]
    if (value && !env[key]) env[key] = String(value)
  }

  // 2. An optional file pushed onto the device, which wins over nothing but
  //    fills in anything the build did not carry.
  const file = credentialsFilePath()
  if (!existsSync(file)) return
  try {
    const text = readFileSync(file, 'utf8') as string
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (key && !env[key]) env[key] = value
    }
  } catch (err) {
    console.warn(`Failed to read credentials file ${file}:`, err)
  }
}

const DUMMY_VALUES = new Set([
  '',
  'dummy_google_id.apps.googleusercontent.com',
  'dummy_microsoft_client_id'
])

export function isConfigured(clientId: string | undefined): boolean {
  return Boolean(clientId) && !DUMMY_VALUES.has(clientId as string)
}
