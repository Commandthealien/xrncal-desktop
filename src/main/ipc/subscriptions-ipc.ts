import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc-contract'
import { getDatabase } from '../db/database'
import { addSubscription, refreshSubscription } from '../subscriptions/ics-subscription'

export function registerSubscriptionIpcHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.SUBSCRIPTIONS.ADD)
  ipcMain.removeHandler(IPC_CHANNELS.SUBSCRIPTIONS.REFRESH)

  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTIONS.ADD, (_event, url: string, name?: string) => {
    if (typeof url !== 'string' || !url.trim()) throw new Error('A calendar link is required')
    return addSubscription(getDatabase(), url, typeof name === 'string' ? name : undefined)
  })

  // A refresh that changed anything tells every window, the same signal a
  // background sync sends - so a refresh from the sidebar menu redraws the view
  // without the menu needing a way to reload it.
  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTIONS.REFRESH, async (_event, calendarId: string) => {
    const stored = await refreshSubscription(getDatabase(), calendarId)
    if (stored > 0) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.SYNC.CHANGED)
      }
    }
    return stored
  })
}
