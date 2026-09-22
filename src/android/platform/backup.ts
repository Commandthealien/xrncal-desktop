import { existsSync, statSync, unlinkSync } from '../shims/node-fs'
import { nativeBridge, unwrap } from '../native/bridge'
import type { ISqliteDatabase } from './sqlite-driver'

/**
 * Android replacement for `src/main/db/backup.ts`.
 *
 * The snapshot mechanism is unchanged - `VACUUM INTO` for the same reason as
 * on desktop (WAL means a file copy can land torn). What changes is what
 * happens next: an app-private file the user cannot browse to is not a backup
 * in any useful sense, so the finished snapshot is handed straight to
 * Android's share sheet. Saving to Drive, a file manager or a messaging app is
 * then the user's choice, which is the platform's equivalent of picking a path.
 */
export function backupDatabaseTo(db: ISqliteDatabase, destPath: string): number {
  // VACUUM INTO refuses to overwrite an existing file.
  if (existsSync(destPath)) unlinkSync(destPath)

  // The path is app-generated rather than user-typed, but it still goes into a
  // statement: escape quotes so a path containing one cannot end the literal.
  db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)

  const size = statSync(destPath).size

  try {
    unwrap<null>(
      'shareFile',
      nativeBridge().shareFile(destPath, 'application/x-sqlite3', 'Save xrncal backup')
    )
  } catch (err) {
    // The snapshot is already written and its path is reported back to the
    // renderer, so a share sheet that fails to open is not a failed backup.
    console.error('Backup written but share sheet failed to open:', err)
  }

  return size
}

/** `xrncal-backup-2026-09-14T19-20-31.sqlite` */
export function defaultBackupFileName(now = new Date()): string {
  const stamp = now.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
  return `xrncal-backup-${stamp}.sqlite`
}
