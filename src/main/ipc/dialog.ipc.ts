import { ipcMain, dialog } from 'electron'
import type { IpcResult } from '../../shared/types/ipc.types'
import { IpcErrorCodes } from '../../shared/types/ipc.types'

function createSuccessResult<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

function createCanceledResult<T>(): IpcResult<T> {
  return { success: false, error: 'Dialog canceled', code: IpcErrorCodes.DIALOG_CANCELED }
}

export function registerDialogIpc(): void {
  // dialog:selectDirectory - Open native directory picker
  ipcMain.handle('dialog:selectDirectory', async (): Promise<IpcResult<string>> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return createCanceledResult()
    }

    return createSuccessResult(result.filePaths[0])
  })
}

export function unregisterDialogIpc(): void {
  ipcMain.removeHandler('dialog:selectDirectory')
}
