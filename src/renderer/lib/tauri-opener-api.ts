/**
 * Opener API Singleton
 *
 * Provides functions for opening files with external applications
 * and revealing items in the system file manager.
 *
 * Uses @tauri-apps/plugin-opener for cross-platform file operations.
 */

import type { IpcResult } from '@shared/types/ipc.types'
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'

export interface OpenerApi {
  openWithExternalApp: (path: string) => Promise<IpcResult<void>>
  openUrlWithSystemBrowser: (url: string) => Promise<IpcResult<void>>
  revealInFileManager: (path: string) => Promise<IpcResult<void>>
}

function createTauriOpenerApi(): OpenerApi {
  return {
    async openWithExternalApp(path: string): Promise<IpcResult<void>> {
      try {
        await openPath(path)
        return { success: true, data: undefined }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'OPEN_ERROR'
        }
      }
    },

    async openUrlWithSystemBrowser(url: string): Promise<IpcResult<void>> {
      try {
        await openUrl(url)
        return { success: true, data: undefined }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'OPEN_URL_ERROR'
        }
      }
    },

    async revealInFileManager(path: string): Promise<IpcResult<void>> {
      try {
        await revealItemInDir(path)
        return { success: true, data: undefined }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'REVEAL_ERROR'
        }
      }
    }
  }
}

export const openerApi: OpenerApi = createTauriOpenerApi()
