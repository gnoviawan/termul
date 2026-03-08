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

import { tauriClipboardApi } from './tauri-clipboard-api'
import type { ClipboardApi } from '@shared/types/ipc.types'

/**
 * Singleton ClipboardApi instance
 *
 * Uses Tauri IPC implementation when running in Tauri context.
 * In the future, this could conditionally export an Electron implementation
 * based on build environment.
 */
export const clipboardApi: ClipboardApi = tauriClipboardApi
