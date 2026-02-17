import { ipcMain, BrowserWindow } from 'electron'
import type { IpcResult } from '../../shared/types/ipc.types'

function createSuccessResult<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

let onMaximize: (() => void) | null = null
let onUnmaximize: (() => void) | null = null

export function registerWindowIpc(mainWindow: BrowserWindow): void {
  ipcMain.on('window:minimize', () => {
    mainWindow.minimize()
  })

  ipcMain.handle('window:toggleMaximize', async (): Promise<IpcResult<boolean>> => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
    return createSuccessResult(mainWindow.isMaximized())
  })

  ipcMain.on('window:close', () => {
    mainWindow.close()
  })

  onMaximize = (): void => {
    mainWindow.webContents.send('window:maximize-changed', true)
  }
  onUnmaximize = (): void => {
    mainWindow.webContents.send('window:maximize-changed', false)
  }

  mainWindow.on('maximize', onMaximize)
  mainWindow.on('unmaximize', onUnmaximize)
}

export function unregisterWindowIpc(mainWindow?: BrowserWindow): void {
  ipcMain.removeAllListeners('window:minimize')
  ipcMain.removeHandler('window:toggleMaximize')
  ipcMain.removeAllListeners('window:close')

  if (mainWindow) {
    if (onMaximize) mainWindow.removeListener('maximize', onMaximize)
    if (onUnmaximize) mainWindow.removeListener('unmaximize', onUnmaximize)
  }

  onMaximize = null
  onUnmaximize = null
}
