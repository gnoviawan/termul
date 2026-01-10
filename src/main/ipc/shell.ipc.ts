import { ipcMain } from 'electron'
import type { IpcResult, DetectedShells } from '../../shared/types/ipc.types'
import { detectShells } from '../services/shell-detect'

function createSuccessResult<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

export function registerShellIpc(): void {
  // shell:detect - Get available shells on the system
  ipcMain.handle('shell:detect', async (): Promise<IpcResult<DetectedShells>> => {
    const shells = detectShells()
    return createSuccessResult(shells)
  })
}

export function unregisterShellIpc(): void {
  ipcMain.removeHandler('shell:detect')
}
