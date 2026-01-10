import { ipcMain } from 'electron'
import { read, write, remove, writeDebounced } from '../services/persistence-service'

/**
 * Register persistence IPC handlers
 */
export function registerPersistenceIpc(): void {
  // Read data from storage
  ipcMain.handle('persistence:read', async (_event, key: string) => {
    return await read(key)
  })

  // Write data to storage (immediate)
  ipcMain.handle('persistence:write', async (_event, key: string, data: unknown) => {
    return await write(key, data)
  })

  // Write data to storage (debounced)
  ipcMain.handle('persistence:writeDebounced', (_event, key: string, data: unknown) => {
    writeDebounced(key, data)
    return { success: true, data: undefined }
  })

  // Delete data from storage
  ipcMain.handle('persistence:delete', async (_event, key: string) => {
    return await remove(key)
  })
}
