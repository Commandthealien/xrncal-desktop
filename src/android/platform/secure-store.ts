import { nativeBridge, unwrap } from '../native/bridge'
import type { ISqliteDatabase } from './sqlite-driver'

/**
 * Android replacement for `src/main/secure-store.ts`.
 *
 * Deliberately a near-copy of the desktop class: the *storage* is identical
 * (encrypted blob in the `settings` table under `token:<accountId>`), only the
 * cipher changes - Electron `safeStorage` becomes an AES-GCM key held in the
 * Android Keystore. Keeping the row layout matters beyond tidiness:
 * `detach-account.ts` cleans up by deleting that exact settings row, so a
 * token kept anywhere else would survive a detach.
 *
 * Like the desktop build on a keyring-less Linux box, this fails closed. There
 * is no plaintext fallback: a device where the Keystore is unavailable simply
 * cannot connect a provider account.
 */

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      'Android Keystore encryption is unavailable. Set a device screen lock, then reconnect the account.'
    )
    this.name = 'EncryptionUnavailableError'
  }
}

export class SecureStore {
  constructor(private db?: ISqliteDatabase) {}

  isAvailable(): boolean {
    try {
      return nativeBridge().secureAvailable()
    } catch {
      return false
    }
  }

  encrypt(plaintext: string): string {
    if (!this.isAvailable()) {
      throw new EncryptionUnavailableError()
    }
    return unwrap<string>('secureEncrypt', nativeBridge().secureEncrypt(plaintext))
  }

  decrypt(encryptedBase64: string): string {
    if (!this.isAvailable()) {
      throw new EncryptionUnavailableError()
    }
    return unwrap<string>('secureDecrypt', nativeBridge().secureDecrypt(encryptedBase64))
  }

  storeToken(accountId: string, tokenData: any): void {
    if (!this.db) {
      throw new Error('Database instance required to persist tokens')
    }
    const serialized = JSON.stringify(tokenData)
    const encrypted = this.encrypt(serialized)
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(`token:${accountId}`, encrypted, now)
  }

  getToken<T = any>(accountId: string): T | null {
    if (!this.db) return null
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get<{ value: string }>(`token:${accountId}`)

    if (!row || !row.value) return null
    try {
      const decrypted = this.decrypt(row.value)
      return JSON.parse(decrypted) as T
    } catch (err) {
      console.error(`Failed to decrypt token for account ${accountId}:`, err)
      return null
    }
  }

  deleteToken(accountId: string): void {
    if (!this.db) return
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(`token:${accountId}`)
  }
}
