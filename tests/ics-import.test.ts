import { describe, it, expect, vi } from 'vitest'

/**
 * Importing a .ics file. The parser reads guest lists for CalDAV, but an
 * imported event is a copy: carrying its guests into a synced calendar would
 * make this account the organizer and, on Microsoft, invite them all again.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', async () => {
  const stub = await vi.importActual<Record<string, unknown>>('./stubs/electron')
  return {
    ...stub,
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
      on: () => undefined,
      removeHandler: () => undefined
    }
  }
})

const { initDatabase } = await import('../src/main/db/database')
const { EventsRepo } = await import('../src/main/db/repos/events-repo')
const { registerCalendarIpcHandlers } = await import('../src/main/ipc/calendar-ipc')
const { IPC_CHANNELS } = await import('../src/shared/ipc-contract')

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:meeting-1@example.com',
  'DTSTAMP:20260401T000000Z',
  'DTSTART:20260401T090000Z',
  'DTEND:20260401T100000Z',
  'SUMMARY:Planning',
  'ORGANIZER:mailto:boss@example.com',
  'ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@example.com',
  'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:everyone@example.com',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Planning',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n')

describe('.ics import', () => {
  it('imports the event and its reminders, but not its guest list', () => {
    const db = initDatabase(':memory:')
    registerCalendarIpcHandlers()

    const result = handlers.get(IPC_CHANNELS.ICS.IMPORT)!({}, 'calendar-local-default', ICS) as {
      importedCount: number
    }

    expect(result.importedCount).toBe(1)
    const id = db.prepare("SELECT id FROM events WHERE title = 'Planning'").get<{ id: string }>()!.id
    const event = new EventsRepo(db).getEventById(id)!.event
    expect(event.attendees).toEqual([])
    expect(event.reminders).toEqual([{ minutesBefore: 15 }])
  })
})
