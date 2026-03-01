/**
 * API Bridge - Unified entry point for all Tauri IPC APIs
 *
 * This module provides environment detection and exports appropriate
 * API implementations based on whether we're running in Tauri or web.
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
export const isTauri = (): boolean => '__TAURI_INTERNALS__' in window

/**
 * Persistence API - unified interface
 */
export const persistenceApi = isTauri() ? tauriPersistenceApi : window.api?.persistence

/**
 * Filesystem API - unified interface
 */
export const filesystemApi = isTauri() ? tauriFilesystemApi : window.api?.filesystem

/**
 * Dialog API - unified interface
 */
export const dialogApi = isTauri() ? tauriDialogApi : window.api?.dialog

/**
 * Clipboard API - unified interface
 */
export const clipboardApi = isTauri() ? tauriClipboardApi : window.api?.clipboard

/**
 * System API - unified interface
 */
export const systemApi = isTauri() ? tauriSystemApi : window.api?.system

/**
 * Window API - unified interface
 */
export const windowApi = isTauri() ? tauriWindowApi : window.api?.window

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
