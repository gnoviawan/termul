/**
 * Clipboard API Singleton
 *
 * Exports a singleton instance of the ClipboardApi for use throughout the app.
 * This provides a consistent interface whether running under Electron or Tauri.
 *
 * Usage:
 *   import { clipboardApi } from '@/lib/clipboard-api'
 *   const result = await clipboardApi.readText()
 */

import type { ClipboardApi } from '@shared/types/ipc.types'
import { tauriClipboardApi } from './tauri-clipboard-api'
import { isTauriContext } from './tauri-runtime'

/**
 * Singleton ClipboardApi instance
 *
 * Uses Tauri IPC implementation when running in Tauri context.
 * In the future, this could conditionally export an Electron implementation
 * based on build environment.
 */
const browserClipboardApi: ClipboardApi = {
  async readText() {
    try {
      return { success: true, data: await navigator.clipboard.readText() }
    } catch (error) {
      return { success: false, error: String(error), code: 'READ_ERROR' }
    }
  },
  async writeText(text) {
    try {
      await navigator.clipboard.writeText(text)
      return { success: true, data: undefined }
    } catch (error) {
      return { success: false, error: String(error), code: 'WRITE_ERROR' }
    }
  },
  async hasImage() {
    return { success: true, data: false }
  }
}

export const clipboardApi: ClipboardApi = isTauriContext() ? tauriClipboardApi : browserClipboardApi
