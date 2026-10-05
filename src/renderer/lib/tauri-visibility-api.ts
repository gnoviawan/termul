import type { IpcResult, VisibilityApi } from '@shared/types/ipc.types'

import { invokeIpcWrapped } from './ipc/tauri'

/**
 * IPC Command names
 * Must match Rust command names in src-tauri/src/commands.rs
 */
const IPC_COMMANDS = {
  SET_VISIBILITY_STATE: 'terminal_set_visibility'
} as const

/**
 * Create a VisibilityApi implementation using Tauri IPC
 */
export function createTauriVisibilityApi(): VisibilityApi {
  return {
    async setVisibilityState(isVisible: boolean): Promise<IpcResult<void>> {
      // Rust expects: request: SetVisibilityRequest { is_visible }
      const request = { isVisible }
      return invokeIpcWrapped<void>(IPC_COMMANDS.SET_VISIBILITY_STATE, { request })
    }
  }
}
