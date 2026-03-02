import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  getDefaultSessionPersistenceService,
  resetSessionPersistenceService
} from '../services/session-persistence'
import type { SessionData } from '../../shared/types/ipc.types'
import type { IpcResult } from '../../shared/types/ipc.types'

/**
 * Register IPC handlers for session persistence
 *
 * Channels:
 * - session:save - Save session data
 * - session:restore - Restore session data
 * - session:clear - Clear saved session
 * - session:flush - Flush pending auto-save
 * - session:hasSession - Check if saved session exists
 */
export function registerSessionIpc(): void {
  const sessionService = getDefaultSessionPersistenceService()

  // Save session
  ipcMain.handle('session:save', async (_event: IpcMainInvokeEvent, sessionData: SessionData): Promise<IpcResult<void>> => {
    return sessionService.saveSession(sessionData)
  })

  // Restore session
  ipcMain.handle('session:restore', async (_event: IpcMainInvokeEvent): Promise<IpcResult<SessionData>> => {
    return sessionService.restoreSession()
  })

  // Clear session
  ipcMain.handle('session:clear', async (_event: IpcMainInvokeEvent): Promise<IpcResult<void>> => {
    return sessionService.clearSession()
  })

  // Flush pending auto-save
  ipcMain.handle('session:flush', async (_event: IpcMainInvokeEvent): Promise<IpcResult<void>> => {
    try {
      await sessionService.flushPendingAutoSave()
      return { success: true, data: undefined }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to flush session',
        code: 'SESSION_FLUSH_FAILED'
      }
    }
  })

  // Check if saved session exists
  ipcMain.handle('session:hasSession', async (_event: IpcMainInvokeEvent): Promise<IpcResult<boolean>> => {
    try {
      const hasSession = await sessionService.hasSavedSession()
      return { success: true, data: hasSession }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check session',
        code: 'SESSION_CHECK_FAILED'
      }
    }
  })
}

/**
 * Reset session IPC service (useful for testing)
 */
export function resetSessionIpc(): void {
  resetSessionPersistenceService()
}
