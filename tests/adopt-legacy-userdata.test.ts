import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptLegacyUserData } from '../src/main/adopt-legacy-userdata'
import { createSqliteDriver } from '../src/main/db/sqlite-driver'

/**
 * Renaming the app moves Electron's userData directory. Without this adoption
 * step the new name starts on an empty database and every existing event looks
 * deleted.
 */
describe('adoptLegacyUserData', () => {
  let root: string
  let legacyDir: string
  let newDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xrncal-adopt-'))
    legacyDir = join(root, 'gone-calendar')
    newDir = join(root, 'xrncal')
    mkdirSync(legacyDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** A legacy profile holding one event, left open so its writes sit in the WAL. */
  function seedLegacy(): ReturnType<typeof createSqliteDriver> {
    const db = createSqliteDriver(join(legacyDir, 'gone-calendar.sqlite'))
    db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
    db.prepare('INSERT INTO events (id, title) VALUES (?, ?)').run('ev-1', 'Giỗ ông nội')
    writeFileSync(join(legacyDir, 'gone-calendar.env'), 'GOOGLE_OAUTH_CLIENT_ID=abc')
    return db
  }

  function titlesIn(dbPath: string): string[] {
    const db = createSqliteDriver(dbPath)
    try {
      return db.prepare('SELECT title FROM events').all<{ title: string }>().map((r) => r.title)
    } finally {
      db.close()
    }
  }

  it('brings the events across, including writes still sitting in the WAL', () => {
    const legacy = seedLegacy()
    try {
      expect(adoptLegacyUserData(newDir)).toBe(true)
      expect(titlesIn(join(newDir, 'xrncal.sqlite'))).toEqual(['Giỗ ông nội'])
    } finally {
      legacy.close()
    }
  })

  it('carries the credentials file over too', () => {
    const legacy = seedLegacy()
    try {
      adoptLegacyUserData(newDir)
      expect(readFileSync(join(newDir, 'xrncal.env'), 'utf8')).toBe('GOOGLE_OAUTH_CLIENT_ID=abc')
    } finally {
      legacy.close()
    }
  })

  it('leaves the old profile in place so the previous build still works', () => {
    const legacy = seedLegacy()
    try {
      adoptLegacyUserData(newDir)
      expect(titlesIn(join(legacyDir, 'gone-calendar.sqlite'))).toEqual(['Giỗ ông nội'])
    } finally {
      legacy.close()
    }
  })

  it('never overwrites a database that already exists under the new name', () => {
    const legacy = seedLegacy()
    try {
      mkdirSync(newDir, { recursive: true })
      const current = createSqliteDriver(join(newDir, 'xrncal.sqlite'))
      current.exec('CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
      current.prepare('INSERT INTO events (id, title) VALUES (?, ?)').run('ev-2', 'Sprint planning')
      current.close()

      expect(adoptLegacyUserData(newDir)).toBe(false)
      expect(titlesIn(join(newDir, 'xrncal.sqlite'))).toEqual(['Sprint planning'])
    } finally {
      legacy.close()
    }
  })

  it('does nothing when there is no previous install', () => {
    expect(adoptLegacyUserData(newDir)).toBe(false)
    expect(existsSync(join(newDir, 'xrncal.sqlite'))).toBe(false)
  })
})
