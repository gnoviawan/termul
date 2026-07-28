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

import type { DialogApi, IpcResult } from '@shared/types/ipc.types'
import { confirm, open } from '@tauri-apps/plugin-dialog'
import { isTauriContext } from './tauri-runtime'

/**
 * Registry for the web-mode directory picker. In web/remote mode there is no
 * native `dialog.open`, so `selectDirectory` delegates to an in-app picker
 * (DirectoryPicker) registered here. The picker is mounted at the top of the
 * app and calls back with the selected path. If no picker is registered,
 * `selectDirectory` returns a CANCELLED result (graceful fallback).
 */
type WebDirectoryPickerFn = () => Promise<IpcResult<string>>

let webDirectoryPicker: WebDirectoryPickerFn | null = null

/**
 * Register the web-mode directory picker opener. Called once at app mount when
 * `!isTauriContext()`. The DirectoryPicker component registers its opener so
 * `dialogApi.selectDirectory()` can invoke it transparently in web mode.
 */
export function registerWebDirectoryPicker(opener: WebDirectoryPickerFn): void {
  webDirectoryPicker = opener
}

/** @internal Testing only — clear the registered picker. */
export function _resetWebDirectoryPickerForTesting(): void {
  webDirectoryPicker = null
}

/**
 * Create a DialogApi implementation using Tauri's dialog plugin
 */
function createTauriDialogApi(): DialogApi {
  return {
    async selectDirectory(): Promise<IpcResult<string>> {
      // Web/remote mode: open the in-app Browse picker backed by /fs/browse
      // (Story: Web/remote project creation). Desktop stays on dialog.open.
      if (!isTauriContext()) {
        if (webDirectoryPicker) {
          return webDirectoryPicker()
        }
        return { success: false, error: 'No directory selected', code: 'CANCELLED' }
      }
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
