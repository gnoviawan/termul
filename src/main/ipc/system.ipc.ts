import { ipcMain } from 'electron'
import { homedir } from 'os'
import type { IpcResult } from '../../shared/types/ipc.types'

function createSuccessResult<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

export function registerSystemIpc(): void {
  // system:getHomeDirectory - Get user's home directory
  ipcMain.handle('system:getHomeDirectory', async (): Promise<IpcResult<string>> => {
    return createSuccessResult(homedir())
  })
}

export function unregisterSystemIpc(): void {
  ipcMain.removeHandler('system:getHomeDirectory')
}
