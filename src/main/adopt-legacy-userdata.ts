import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { createSqliteDriver } from './db/sqlite-driver'

/**
 * The app used to be called "Gone Calendar", so Electron kept its profile in a
 * directory named after that: `~/.config/gone-calendar` on Linux, the same leaf
 * under AppData on Windows. Renaming the app moves `userData` to a fresh, empty
 * directory - which would look to the user like every event they ever made had
 * been deleted. On first run under the new name, adopt the old database instead.
 *
 * `VACUUM INTO` rather than a file copy, for the reason spelled out in
 * `db/backup.ts`: the database runs in WAL mode, so the `.sqlite` file alone is
 * only part of the story, and the previous build may well still be running when
 * this happens - somebody updates the app, launches the new one, and the old
 * window is open behind it. VACUUM INTO takes a read transaction, so the
 * snapshot is consistent even mid-write.
 *
 * Copy, never move: if anything goes wrong the previous build still opens its
 * own data, and the two profiles simply diverge from here.
 */
const LEGACY_APP_DIRS = ['gone-calendar', 'Gone Calendar']
const LEGACY_DB_NAME = 'gone-calendar.sqlite'
const LEGACY_ENV_NAME = 'gone-calendar.env'

export function adoptLegacyUserData(userDataDir: string, dbName = 'xrncal.sqlite'): boolean {
  const destDb = join(userDataDir, dbName)
  if (existsSync(destDb)) return false

  const parent = dirname(userDataDir)
  const legacyDir = LEGACY_APP_DIRS.map((name) => join(parent, name)).find((dir) =>
    existsSync(join(dir, LEGACY_DB_NAME))
  )
  if (!legacyDir) return false

  let legacyDb: ReturnType<typeof createSqliteDriver> | null = null
  try {
    mkdirSync(userDataDir, { recursive: true })
    legacyDb = createSqliteDriver(join(legacyDir, LEGACY_DB_NAME))
    legacyDb.exec(`VACUUM INTO '${destDb.replace(/'/g, "''")}'`)

    const legacyEnv = join(legacyDir, LEGACY_ENV_NAME)
    if (existsSync(legacyEnv)) copyFileSync(legacyEnv, join(userDataDir, 'xrncal.env'))

    console.log(`Adopted calendar data from previous install at ${legacyDir}`)
    return true
  } catch (err) {
    console.error('Could not adopt data from the previous install:', err)
    return false
  } finally {
    try {
      legacyDb?.close()
    } catch {
      /* the snapshot is already written; a failed close changes nothing */
    }
  }
}

export function adoptLegacyUserDataForApp(): boolean {
  return adoptLegacyUserData(app.getPath('userData'))
}
