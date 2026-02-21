import { ipcMain } from 'electron'
import type { IpcResult } from '../../shared/types/ipc.types'

// Visibility state management for main process services
let currentVisibilityState = true // Assume visible at start

/**
 * Get the current visibility state
 */
export function getVisibilityState(): boolean {
  return currentVisibilityState
}

/**
 * Register IPC handlers for visibility state
 */
export function registerVisibilityIpc(): void {
  ipcMain.handle(
    'visibility:setState',
    async (_event, isVisible: boolean): Promise<IpcResult<void>> => {
      try {
        const previousState = currentVisibilityState
        currentVisibilityState = isVisible

        // Log state change for debugging
        if (previousState !== isVisible) {
          console.log(`[Visibility] State changed: ${isVisible ? 'visible' : 'hidden'}`)
        }

        return { success: true, data: undefined }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          code: 'VISIBILITY_ERROR'
        }
      }
    }
  )
}
