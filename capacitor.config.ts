import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor wraps the *same* React renderer the desktop app uses; there is no
 * second UI codebase. `webDir` therefore points at the Android-flavoured Vite
 * build (`vite.android.config.ts`), not at the electron-vite output.
 */
const config: CapacitorConfig = {
  appId: 'app.xrncal.android',
  appName: 'xrncal',
  webDir: 'out/android',
  android: {
    // The renderer is a fixed local document. Anything that is not our own
    // bundle must never take over the WebView - the same rule main/index.ts
    // enforces with `will-navigate` on desktop.
    allowMixedContent: false
  },
  plugins: {
    // Routes window.fetch / XMLHttpRequest through the native HTTP stack.
    // Without it every provider call is subject to WebView CORS, and CalDAV
    // servers send no CORS headers at all - Nextcloud/iCloud sync would be
    // impossible from the WebView origin.
    CapacitorHttp: {
      enabled: true
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_xrncal',
      iconColor: '#5865F2'
    }
  }
}

export default config
