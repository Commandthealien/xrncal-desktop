import { defineConfig } from '@playwright/test'

/**
 * UI tests that drive the built app (`npm run test:e2e` builds it first). Each
 * spec launches Electron on a throwaway profile; see e2e/app.ts.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']]
})
