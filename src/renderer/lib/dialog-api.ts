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
import { confirm, open, save } from '@tauri-apps/plugin-dialog'
import { type DesktopHost, getDesktopHost } from './desktop-host'
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

/** True when this client can pick local file paths: Tauri, or a registered desktop host. */
export function canPickLocalFiles(): boolean {
  return isTauriContext() || getDesktopHost() !== null
}

/** The desktop host whose dialogs replace Tauri's outside Tauri, or null. */
function dialogHost(): DesktopHost | null {
  return isTauriContext() ? null : getDesktopHost()
}

async function hostResult<T>(pick: Promise<T | null>, cancelled: string): Promise<IpcResult<T>> {
  try {
    const picked = await pick
    if (picked === null || (Array.isArray(picked) && picked.length === 0)) {
      return { success: false, error: cancelled, code: 'CANCELLED' }
    }
    return { success: true, data: picked }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'DIALOG_ERROR'
    }
  }
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
      const host = dialogHost()
      if (host) {
        return hostResult(
          host.openFiles({ multiple: false }).then((paths) => paths?.[0] ?? null),
          'No file selected'
        )
      }
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
    },

    async selectFiles(options?: { title?: string }): Promise<IpcResult<string[]>> {
      const host = dialogHost()
      if (host) return hostResult(host.openFiles({ multiple: true }), 'No file selected')
      if (!isTauriContext()) {
        return { success: false, error: 'No file selected', code: 'CANCELLED' }
      }
      try {
        const selected = await open({ multiple: true, title: options?.title || 'Select Files' })
        const paths = selected == null ? [] : Array.isArray(selected) ? selected : [selected]
        if (paths.length === 0) {
          return { success: false, error: 'No file selected', code: 'CANCELLED' }
        }
        return { success: true, data: paths }
      } catch (err) {
        return { success: false, error: String(err), code: 'DIALOG_ERROR' }
      }
    },

    async saveFile(options?: { title?: string; defaultPath?: string }): Promise<IpcResult<string>> {
      const host = dialogHost()
      if (host) {
        return hostResult(
          host.saveFile({ defaultPath: options?.defaultPath }),
          'No location selected'
        )
      }
      if (!isTauriContext()) {
        return { success: false, error: 'No location selected', code: 'CANCELLED' }
      }
      try {
        const selected = await save({ title: options?.title, defaultPath: options?.defaultPath })
        if (!selected) {
          return { success: false, error: 'No location selected', code: 'CANCELLED' }
        }
        return { success: true, data: selected }
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
