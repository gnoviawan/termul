/**
 * API Bridge - Unified entry point for Tauri IPC APIs
 *
 * Usage:
 *   import { persistenceApi, systemApi } from '@/lib/api-bridge'
 */

import { tauriPersistenceApi } from './tauri-persistence-api'
import { tauriFilesystemApi } from './tauri-filesystem-api'
import { tauriDialogApi } from './tauri-dialog-api'
import { tauriClipboardApi } from './tauri-clipboard-api'
import { tauriSystemApi } from './tauri-system-api'
import { tauriWindowApi } from './tauri-window-api'

/**
 * Detect if running in Tauri environment
 */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Persistence API
 */
export const persistenceApi = tauriPersistenceApi

/**
 * Filesystem API
 */
export const filesystemApi = tauriFilesystemApi

/**
 * Dialog API
 */
export const dialogApi = tauriDialogApi

/**
 * Clipboard API
 */
export const clipboardApi = tauriClipboardApi

/**
 * System API
 */
export const systemApi = tauriSystemApi

/**
 * Window API
 */
export const windowApi = tauriWindowApi

/**
 * Re-export all APIs for convenience
 */
export {
  tauriPersistenceApi,
  tauriFilesystemApi,
  tauriDialogApi,
  tauriClipboardApi,
  tauriSystemApi,
  tauriWindowApi
}

/**
 * Type exports
 */
export type { IpcResult } from '@shared/types/ipc.types'
