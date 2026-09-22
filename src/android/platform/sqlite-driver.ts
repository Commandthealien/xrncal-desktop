import { nativeBridge, unwrap, type NativeRunResult } from '../native/bridge'

/**
 * Android replacement for `src/main/db/sqlite-driver.ts`.
 *
 * Swapped in by `androidModuleSwap` in vite.android.config.ts, so it must
 * export the same surface as the desktop module - every repo class imports
 * `ISqliteDatabase` from here (by type), and `database.ts` imports
 * `createSqliteDriver` as a value.
 *
 * The desktop driver talks to `node:sqlite`; this one talks to Android's own
 * SQLite through the synchronous `XrncalNative` bridge. The *interface is
 * identical and synchronous*, which is the whole reason the repos, the ICS
 * layer and the three sync engines compile unchanged.
 */

export interface ISqliteRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface ISqliteStatement {
  run(...params: any[]): ISqliteRunResult
  get<T = any>(...params: any[]): T | undefined
  all<T = any>(...params: any[]): T[]
}

export interface ISqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): ISqliteStatement
  transaction<T>(fn: () => T): () => T
  close(): void
}

/**
 * `node:sqlite` accepts positional params as a rest argument, and some call
 * sites in the repos pass a single array instead. Normalise both, and flatten
 * the `undefined`s a spread can introduce into SQL NULLs - Android's binder
 * rejects `undefined` where node:sqlite quietly bound NULL.
 */
function normaliseParams(params: any[]): any[] {
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params
  return flat.map((p) => {
    if (p === undefined) return null
    // SQLite has no boolean type; node:sqlite coerces, android's bindArgs does not.
    if (typeof p === 'boolean') return p ? 1 : 0
    if (typeof p === 'bigint') return Number(p)
    return p
  })
}

export function createSqliteDriver(dbPath: string): ISqliteDatabase {
  const bridge = nativeBridge()

  // `:memory:` is honoured so the same seeding/migration code can be exercised
  // in a scratch database on device.
  unwrap<null>('dbOpen', bridge.dbOpen(dbPath))

  let txnDepth = 0
  let closed = false

  const assertOpen = (): void => {
    if (closed) throw new Error('Database connection is closed')
  }

  const driver: ISqliteDatabase = {
    exec(sql: string): void {
      assertOpen()
      unwrap<null>('dbExec', bridge.dbExec(sql))
    },

    prepare(sql: string): ISqliteStatement {
      assertOpen()
      // No JS-side statement cache here, unlike the desktop driver: the
      // compiled-statement cache lives on the Kotlin side, keyed by SQL text,
      // so caching a wrapper object here would buy nothing but would keep the
      // `IN (?,?,…)` key space alive in two places.
      const trimmed = sql.trim()
      const isRead = /^(SELECT|WITH|PRAGMA|EXPLAIN)/i.test(trimmed)

      return {
        run(...params: any[]): ISqliteRunResult {
          assertOpen()
          const res = unwrap<NativeRunResult>(
            'dbRun',
            bridge.dbRun(sql, JSON.stringify(normaliseParams(params)))
          )
          return { changes: res.changes, lastInsertRowid: res.lastInsertRowid }
        },
        get<T = any>(...params: any[]): T | undefined {
          assertOpen()
          const rows = unwrap<T[]>(
            'dbQuery',
            bridge.dbQuery(sql, JSON.stringify(normaliseParams(params)))
          )
          return rows.length > 0 ? rows[0] : undefined
        },
        all<T = any>(...params: any[]): T[] {
          assertOpen()
          // A statement that writes and returns rows (RETURNING) still has to
          // go through the query path to surface them.
          if (!isRead && !/RETURNING/i.test(trimmed)) {
            unwrap<NativeRunResult>(
              'dbRun',
              bridge.dbRun(sql, JSON.stringify(normaliseParams(params)))
            )
            return []
          }
          return unwrap<T[]>(
            'dbQuery',
            bridge.dbQuery(sql, JSON.stringify(normaliseParams(params)))
          )
        }
      }
    },

    /**
     * Savepoint-based nesting, matching the desktop driver: `EventsRepo`
     * wraps multi-table writes in a transaction and then calls other repo
     * methods that open their own, so a bare BEGIN would fail on re-entry.
     */
    transaction<T>(fn: () => T): () => T {
      return () => {
        assertOpen()
        txnDepth++
        const savepoint = `sp_${Date.now()}_${txnDepth}`
        driver.exec(`SAVEPOINT ${savepoint};`)
        try {
          const result = fn()
          driver.exec(`RELEASE ${savepoint};`)
          return result
        } catch (err) {
          // ROLLBACK TO leaves the savepoint on the stack; it still has to be
          // released or the next RELEASE unwinds further than intended.
          driver.exec(`ROLLBACK TO ${savepoint};`)
          driver.exec(`RELEASE ${savepoint};`)
          throw err
        } finally {
          txnDepth--
        }
      }
    },

    close(): void {
      if (closed) return
      closed = true
      unwrap<null>('dbClose', bridge.dbClose())
    }
  }

  return driver
}
