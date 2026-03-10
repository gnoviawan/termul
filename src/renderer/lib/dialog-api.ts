/**
 * Dialog API Singleton
 *
 * Exports a singleton instance of the DialogApi for use throughout the app.
 * This provides a consistent interface whether running under Electron or Tauri.
 *
 * Usage:
 *   import { dialogApi } from '@/lib/dialog-api'
 *   const result = await dialogApi.selectDirectory()
 */

import { open, confirm } from '@tauri-apps/plugin-dialog'
import type { DialogApi, IpcResult } from '@shared/types/ipc.types'

/**
 * Create a DialogApi implementation using Tauri's dialog plugin
 */
function createTauriDialogApi(): DialogApi {
  return {
    async selectDirectory(): Promise<IpcResult<string>> {
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Select Project Folder'
        })
        if (!selected) {
          return { success: false, error: 'No directory selected', code: 'CANCELLED' }
        }
        return { success: true, data: selected as string }
      } catch (err) {
        return { success: false, error: String(err), code: 'DIALOG_ERROR' }
      }
    },

    async selectFile(options?: {
      filters?: Array<{ name: string; extensions: string[] }>
      title?: string
    }): Promise<IpcResult<string>> {
      try {
        const selected = await open({
          multiple: false,
          filters: options?.filters,
          title: options?.title || 'Select File'
        })
        if (!selected) {
          return { success: false, error: 'No file selected', code: 'CANCELLED' }
        }
        return { success: true, data: selected as string }
      } catch (err) {
        return { success: false, error: String(err), code: 'DIALOG_ERROR' }
      }
    }
  }
}

/**
 * Singleton DialogApi instance
 *
 * Uses Tauri dialog plugin when running in Tauri context.
 * In the future, this could conditionally export an Electron implementation
 * based on build environment.
 */
export const dialogApi: DialogApi = createTauriDialogApi()

/**
 * Helper function for confirm dialogs (not part of DialogApi interface but useful)
 */
export async function confirmDialog(message: string, title = 'Confirm'): Promise<boolean> {
  return await confirm(message, { title, kind: 'warning' })
}
