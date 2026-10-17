import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc-contract'
import { isAppSettingKey, type AppSettings } from '@shared/settings-contract'
import { SettingsRepo } from '../db/repos/settings-repo'
import { getDatabase } from '../db/database'

export function registerSettingsIpcHandlers(): void {
  const db = getDatabase()
  const settingsRepo = new SettingsRepo(db)

  ipcMain.removeHandler(IPC_CHANNELS.SETTINGS.GET_ALL)
  ipcMain.removeHandler(IPC_CHANNELS.SETTINGS.GET)
  ipcMain.removeHandler(IPC_CHANNELS.SETTINGS.SET)

  ipcMain.handle(IPC_CHANNELS.SETTINGS.GET_ALL, () => {
    return settingsRepo.getAllSettings()
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS.GET, (_event, key: unknown) => {
    if (!isAppSettingKey(key)) throw new Error(`Unknown setting: ${String(key)}`)
    return settingsRepo.getSetting(key)
  })

  // Only settings, and only plain values: the same table holds each account's
  // encrypted credentials, which the renderer could otherwise overwrite.
  ipcMain.handle(IPC_CHANNELS.SETTINGS.SET, (_event, key: unknown, value: unknown) => {
    if (!isAppSettingKey(key)) throw new Error(`Unknown setting: ${String(key)}`)
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`Invalid value for setting ${key}`)
    }
    return settingsRepo.setSetting(key, value as AppSettings[typeof key])
  })
}
