import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc-contract'
import { getDatabase } from '../db/database'
import { ReminderScheduler } from '../notifications/reminder-scheduler'

let scheduler: ReminderScheduler | null = null

/**
 * Registered from index.ts rather than ipc.ts, like the mini window's handlers:
 * a clicked notification has to open the main window, and only index.ts can
 * hand out `showMainWindow`, the one path that opens the main window.
 */
export function registerReminderIpcHandlers(showMainWindow: () => void): ReminderScheduler {
  if (!scheduler) {
    scheduler = new ReminderScheduler(getDatabase(), showMainWindow)
    scheduler.start()
  }
  const active = scheduler

  ipcMain.removeHandler(IPC_CHANNELS.REMINDERS.LIST_ACTIVE)
  ipcMain.removeHandler(IPC_CHANNELS.REMINDERS.DISMISS)
  ipcMain.removeHandler(IPC_CHANNELS.REMINDERS.SNOOZE)

  ipcMain.handle(IPC_CHANNELS.REMINDERS.LIST_ACTIVE, () => active.listActive())
  ipcMain.handle(IPC_CHANNELS.REMINDERS.DISMISS, (_event, key: string) => active.dismiss(key))
  ipcMain.handle(IPC_CHANNELS.REMINDERS.SNOOZE, (_event, key: string, minutes: number) =>
    active.snooze(key, minutes)
  )

  return active
}
