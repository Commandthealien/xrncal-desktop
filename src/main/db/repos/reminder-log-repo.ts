import type { ISqliteDatabase } from '../sqlite-driver'

/**
 * Which reminders have rung, so that a restart does not ring them again. Each
 * entry keeps the instant its occurrence counts back from, and goes once that
 * is far enough in the past that the reminder can never come due again.
 */
export class ReminderLogRepo {
  constructor(private db: ISqliteDatabase) {}

  /** Ring key -> anchor (ms since epoch). */
  load(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT ring_key, anchor_utc FROM reminder_log')
      .all<{ ring_key: string; anchor_utc: string }>()
    const out = new Map<string, number>()
    for (const row of rows) {
      const anchorMs = Date.parse(row.anchor_utc)
      if (Number.isFinite(anchorMs)) out.set(row.ring_key, anchorMs)
    }
    return out
  }

  add(entries: { key: string; anchorMs: number }[]): void {
    if (entries.length === 0) return
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO reminder_log (ring_key, anchor_utc) VALUES (?, ?)'
    )
    this.db.transaction(() => {
      for (const e of entries) insert.run(e.key, new Date(e.anchorMs).toISOString())
    })()
  }

  /** Forget every entry whose anchor is before `beforeMs`. */
  pruneBefore(beforeMs: number): void {
    this.db.prepare('DELETE FROM reminder_log WHERE anchor_utc < ?').run(new Date(beforeMs).toISOString())
  }
}

/**
 * Reminders on screen and snoozed, by occurrence id. A restart used to lose
 * both: a snoozed reminder never came back (it had already rung), and cards not
 * yet dismissed were gone.
 */
export class ReminderStateRepo {
  constructor(private db: ISqliteDatabase) {}

  load(): { showing: string[]; snoozed: Map<string, number> } {
    const rows = this.db
      .prepare('SELECT occurrence_id, snoozed_until FROM reminder_state')
      .all<{ occurrence_id: string; snoozed_until: string | null }>()
    const showing: string[] = []
    const snoozed = new Map<string, number>()
    for (const row of rows) {
      if (row.snoozed_until === null) {
        showing.push(row.occurrence_id)
        continue
      }
      const untilMs = Date.parse(row.snoozed_until)
      if (Number.isFinite(untilMs)) snoozed.set(row.occurrence_id, untilMs)
    }
    return { showing, snoozed }
  }

  /** On screen, or snoozed until `untilMs`. */
  save(occurrenceId: string, untilMs: number | null): void {
    this.db
      .prepare(
        `INSERT INTO reminder_state (occurrence_id, snoozed_until) VALUES (?, ?)
         ON CONFLICT(occurrence_id) DO UPDATE SET snoozed_until = excluded.snoozed_until`
      )
      .run(occurrenceId, untilMs === null ? null : new Date(untilMs).toISOString())
  }

  remove(occurrenceId: string): void {
    this.db.prepare('DELETE FROM reminder_state WHERE occurrence_id = ?').run(occurrenceId)
  }
}
