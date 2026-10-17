import { describe, it, expect, vi } from 'vitest'

/**
 * The settings table also holds each account's encrypted credentials
 * (`token:<accountId>`). The settings IPC returned them to the renderer with
 * every other row, and let it write any key at all.
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
const { registerSettingsIpcHandlers } = await import('../src/main/ipc/settings-ipc')
const { IPC_CHANNELS } = await import('../src/shared/ipc-contract')

describe('settings IPC', () => {
  const db = initDatabase(':memory:')
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('token:acc_1', 'djEwAAAA', '')").run()
  registerSettingsIpcHandlers()
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

  it('hands the renderer settings, not credentials', () => {
    const all = call(IPC_CHANNELS.SETTINGS.GET_ALL) as Record<string, unknown>
    expect(Object.keys(all).some((k) => k.startsWith('token:'))).toBe(false)
    expect(all.timeFormat).toBe('24h')
    expect(() => call(IPC_CHANNELS.SETTINGS.GET, 'token:acc_1')).toThrow(/Unknown setting/)
  })

  it('writes only known settings, with plain values', () => {
    expect(() => call(IPC_CHANNELS.SETTINGS.SET, 'token:acc_1', 'garbage')).toThrow(/Unknown setting/)
    expect(() => call(IPC_CHANNELS.SETTINGS.SET, 'timeFormat', { evil: true })).toThrow(/Invalid value/)
    expect(db.prepare("SELECT value FROM settings WHERE key = 'token:acc_1'").get<{ value: string }>()!.value).toBe('djEwAAAA')

    call(IPC_CHANNELS.SETTINGS.SET, 'timeFormat', '12h')
    expect(call(IPC_CHANNELS.SETTINGS.GET, 'timeFormat')).toBe('12h')
    call(IPC_CHANNELS.SETTINGS.SET, 'defaultAllDayReminderMinutes', null)
  })
})
