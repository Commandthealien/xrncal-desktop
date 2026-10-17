import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface RunningApp {
  app: ElectronApplication
  page: Page
  /** Uncaught errors the renderer threw. */
  errors: string[]
  close: () => Promise<void>
}

/**
 * The built app on a fresh profile, in a fixed zone (Asia/Ho_Chi_Minh, UTC+7
 * all year) so times read the same on every machine. On Linux without a display
 * (CI) run it under xvfb-run.
 */
export async function launchApp(): Promise<RunningApp> {
  const profile = mkdtempSync(join(tmpdir(), 'xrncal-e2e-'))
  const app = await electron.launch({
    // CI runners cannot start Chromium's OS sandbox for an unpacked Electron
    // (no setuid helper, user namespaces restricted); the window sandboxes stay.
    args: [join(__dirname, '..', 'out', 'main', 'index.js'), ...(process.env.CI ? ['--no-sandbox'] : [])],
    env: { ...process.env, XRNCAL_USER_DATA_DIR: profile, TZ: 'Asia/Ho_Chi_Minh' }
  })
  const page = await mainWindow(app)
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  await page.waitForLoadState('domcontentloaded')
  return {
    app,
    page,
    errors,
    close: async () => {
      await app.close()
      rmSync(profile, { recursive: true, force: true })
    }
  }
}

/** The main window, not the tray's mini window (`#mini`). */
async function mainWindow(app: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 50; i++) {
    const main = app.windows().find((w) => !w.url().includes('#mini'))
    if (main) return main
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('The main window never opened')
}
