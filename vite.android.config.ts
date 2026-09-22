import { resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Android build of the *same* renderer the desktop app ships.
 *
 * The desktop app is three bundles (main / preload / renderer) separated by a
 * real process boundary. Android has no such boundary: everything runs in one
 * WebView. Rather than fork the business logic, this build compiles
 * `src/main/**` straight into the web bundle and swaps only the handful of
 * modules that genuinely cannot work there - see `androidModuleSwap` below.
 * Everything else (repos, sync engines, ICS, recurrence, holidays) is the
 * byte-identical desktop source.
 */

const SRC = resolve(__dirname, 'src')

/**
 * Per-file substitutions, keyed by the real desktop module.
 *
 * `resolve.alias` matches import *specifiers*, which is useless here: the same
 * module is reached as './sqlite-driver' from one directory and
 * '../db/sqlite-driver' from another. This resolves the specifier first and
 * matches on the file it actually lands on, so every import path is covered.
 */
const MODULE_SWAPS: Record<string, string> = {
  // node:sqlite -> Android's SQLite over a synchronous JS bridge
  'main/db/sqlite-driver.ts': 'android/platform/sqlite-driver.ts',
  // Electron safeStorage -> Android Keystore
  'main/secure-store.ts': 'android/platform/secure-store.ts',
  // Loopback HTTP server -> custom-scheme redirect via Chrome Custom Tabs
  'main/oauth/google-oauth.ts': 'android/oauth/google-oauth.ts',
  'main/oauth/microsoft-oauth.ts': 'android/oauth/microsoft-oauth.ts',
  // Reads a KEY=VALUE file off disk -> build-time injected config
  'main/load-credentials.ts': 'android/platform/load-credentials.ts',
  // VACUUM INTO a user-picked path -> scoped storage + share sheet
  'main/db/backup.ts': 'android/platform/backup.ts',
  // Electron Notification -> LocalNotifications, which survive app suspension
  'main/notifications/reminder-scheduler.ts': 'android/platform/reminder-scheduler.ts'
}

function androidModuleSwap(): Plugin {
  const swaps = new Map(
    Object.entries(MODULE_SWAPS).map(([from, to]) => [resolve(SRC, from), resolve(SRC, to)])
  )

  return {
    name: 'xrncal:android-module-swap',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer) return null
      // Let the normal resolver work out what this specifier points at, then
      // decide. `skipSelf` avoids recursing into this hook.
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved) return null
      const target = swaps.get(resolved.id)
      return target ? { id: target } : null
    }
  }
}

export default defineConfig(({ mode }) => {
  // Read the project's own .env - the same file the desktop build uses - even
  // though the Vite root is src/android.
  const env = loadEnv(mode, __dirname, '')

  return {
  root: resolve(__dirname, 'src/android'),
  plugins: [androidModuleSwap(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@renderer': resolve(SRC, 'renderer/src'),
      '@shared': resolve(SRC, 'shared'),
      '@main': resolve(SRC, 'main'),
      '@android': resolve(SRC, 'android'),
      // Electron's module is imported by the IPC handlers, the sync worker and
      // the i18n catalog. The shim re-implements the slice they actually touch
      // (ipcMain/ipcRenderer, app, dialog, shell, Notification) in-process.
      electron: resolve(SRC, 'android/shims/electron.ts'),
      // Node builtins reached by main-process code. Only the handful of calls
      // xrncal makes are implemented; anything else throws loudly rather than
      // silently returning undefined.
      'node:fs/promises': resolve(SRC, 'android/shims/node-fs-promises.ts'),
      'node:fs': resolve(SRC, 'android/shims/node-fs.ts'),
      'node:path': resolve(SRC, 'android/shims/node-path.ts'),
      'node:crypto': resolve(SRC, 'android/shims/node-crypto.ts'),
      'node:http': resolve(SRC, 'android/shims/node-http.ts'),
      fs: resolve(SRC, 'android/shims/node-fs.ts'),
      path: resolve(SRC, 'android/shims/node-path.ts'),
      crypto: resolve(SRC, 'android/shims/node-crypto.ts'),
      http: resolve(SRC, 'android/shims/node-http.ts')
    }
  },
  /**
   * OAuth client ids are inlined at build time, because an APK has no
   * equivalent of the `xrncal.env` file the desktop build reads at startup.
   *
   * This is an explicit allowlist rather than Vite's `envPrefix`, and that is
   * a security decision, not a style one: any prefix broad enough to cover
   * GOOGLE_OAUTH_CLIENT_ID also covers GOOGLE_OAUTH_CLIENT_SECRET, and an
   * OAuth secret compiled into an APK is readable by anyone who unzips it.
   * The Android flows are public PKCE clients and need no secret, so only the
   * ids are ever exposed here.
   */
  define: {
    'import.meta.env.GOOGLE_OAUTH_CLIENT_ID': JSON.stringify(env.GOOGLE_OAUTH_CLIENT_ID ?? ''),
    'import.meta.env.MICROSOFT_CLIENT_ID': JSON.stringify(env.MICROSOFT_CLIENT_ID ?? '')
  },

  build: {
    outDir: resolve(__dirname, 'out/android'),
    emptyOutDir: true,
    // A phone WebView parses and JITs this on every cold start; keep it lean
    // and let the sync engines and ICS parser split out of the initial chunk.
    target: 'es2022',
    // Emitted for local debugging; `ignoreAssetsPattern` in
    // android/app/build.gradle keeps them out of the packaged APK.
    sourcemap: true
  }
  }
})
