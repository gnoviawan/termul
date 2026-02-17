import { ipcMain, BrowserWindow } from 'electron'
import type { IpcResult } from '../../shared/types/ipc.types'
import type { AppCloseResponse } from '../../shared/types/ipc.types'

function createSuccessResult<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

let onMaximize: (() => void) | null = null
let onUnmaximize: (() => void) | null = null
let onClose: ((e: Electron.Event) => void) | null = null
let forceClose = false

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

  // Intercept close event to check for unsaved files
  onClose = (e: Electron.Event): void => {
    if (forceClose) {
      forceClose = false
      return
    }
    e.preventDefault()
    mainWindow.webContents.send('app:close-requested')
  }
  mainWindow.on('close', onClose)

  // Handle renderer's response to close request
  ipcMain.on('app:close-response', (_event, response: AppCloseResponse) => {
    if (response === 'close') {
      forceClose = true
      mainWindow.close()
    }
    // 'cancel' — do nothing, window stays open
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
  ipcMain.removeAllListeners('app:close-response')

  if (mainWindow) {
    if (onMaximize) mainWindow.removeListener('maximize', onMaximize)
    if (onUnmaximize) mainWindow.removeListener('unmaximize', onUnmaximize)
    if (onClose) mainWindow.removeListener('close', onClose)
  }

  onMaximize = null
  onUnmaximize = null
  onClose = null
  forceClose = false
}
