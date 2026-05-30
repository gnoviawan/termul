/**
 * Unified API exports for the Tauri runtime
 *
 * This module re-exports all API singletons for easy importing.
 * Each API follows the IpcResult<T> pattern for consistent error handling.
 *
 * Usage:
 *   import { terminalApi, clipboardApi, systemApi } from '@/lib/api'
 */

import { tauriTerminalApi, addRendererRef, removeRendererRef } from './terminal-api'
import {
  clipboardApi as _clipboardApi,
  systemApi as _systemApi,
  persistenceApi as _persistenceApi,
  windowApi as _windowApi,
  filesystemApi as _filesystemApi,
  dialogApi as _dialogApi
} from './api-bridge'
import { keyboardApi } from './keyboard-api'
import { visibilityApi } from './visibility-api'
import { shellApi as tauriShellApi } from './shell-api'
import { gitApi as tauriGitApi } from './git-api'
import { openerApi } from './tauri-opener-api'
import { tauriTunnelApi } from './tunnel-api'
import * as tauriUpdaterApi from './tauri-updater-api'
import * as tauriVersionSkipService from './tauri-version-skip'
import { hasActiveTerminalSessions } from './tauri-safe-update'
import { tauriSessionApi } from './tauri-session-api'
import { createTauriDataMigrationApi } from './tauri-data-migration-api'
import { tauriSecureStorageApi } from './tauri-secure-storage-api'
import { worktreeApi } from './worktree-api'
import { isTauri } from './api-bridge'
import { wsGitApi, wsTunnelApi, wsTerminalApi, wsShellApi } from './ws-api-adapters'

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

export const terminalApi = createProxy(tauriTerminalApi, wsTerminalApi)
export const gitApi = createProxy(tauriGitApi, wsGitApi)
export const tunnelApi = createProxy(tauriTunnelApi, wsTunnelApi)
export const shellApi = createProxy(tauriShellApi, wsShellApi)

export { addRendererRef, removeRendererRef }
export {
  _clipboardApi as clipboardApi,
  _systemApi as systemApi,
  _persistenceApi as persistenceApi,
  _windowApi as windowApi,
  keyboardApi,
  visibilityApi,
  _filesystemApi as filesystemApi,
  _dialogApi as dialogApi,
  openerApi,
  worktreeApi,
  tauriUpdaterApi,
  tauriVersionSkipService,
  hasActiveTerminalSessions
}

export const sessionApi = tauriSessionApi
export const dataMigrationApi = createTauriDataMigrationApi()
export const secureStorageApi = tauriSecureStorageApi
