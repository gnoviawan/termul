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
import { 
  wsFilesystemApi, 
  wsWindowApi, 
  wsDialogApi, 
  wsSystemApi, 
  wsClipboardApi, 
  wsPersistenceApi 
} from './ws-api-adapters'

/**
 * Detect if running in Tauri environment
 */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Helper to create a proxy that delegates to Tauri or WS API dynamically
 */
function createProxy<T extends object>(tauriApi: T, wsApi: T): T {
  return new Proxy(tauriApi, {
    get(target, prop, receiver) {
      if (!isTauri()) {
        const wsValue = Reflect.get(wsApi, prop, wsApi)
        if (typeof wsValue === 'function') {
          return wsValue.bind(wsApi)
        }
        return wsValue
      }
      const tauriValue = Reflect.get(target, prop, receiver)
      if (typeof tauriValue === 'function') {
        return tauriValue.bind(target)
      }
      return tauriValue
    }
  })
}

/**
 * Persistence API
 */
export const persistenceApi = createProxy(tauriPersistenceApi, wsPersistenceApi)

/**
 * Filesystem API
 */
export const filesystemApi = createProxy(tauriFilesystemApi, wsFilesystemApi)

/**
 * Dialog API
 */
export const dialogApi = createProxy(tauriDialogApi, wsDialogApi)

/**
 * Clipboard API
 */
export const clipboardApi = createProxy(tauriClipboardApi, wsClipboardApi)

/**
 * System API
 */
export const systemApi = createProxy(tauriSystemApi, wsSystemApi)

/**
 * Window API
 */
export const windowApi = createProxy(tauriWindowApi, wsWindowApi)

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
