import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import type { IpcResult, VisibilityApi } from '@shared/types/ipc.types'

/**
 * IPC Command names
 * Must match Rust command names in src-tauri/src/commands.rs
 */
const IPC_COMMANDS = {
  SET_VISIBILITY_STATE: 'terminal_set_visibility'
} as const

/**
 * Wrap invoke() calls in IpcResult<T> pattern with try/catch
 */
async function invokeIpc<T>(command: string, args?: InvokeArgs): Promise<IpcResult<T>> {
  try {
    const data = await invoke<T>(command, args)
    return { success: true, data }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'UNKNOWN_ERROR'
    }
  }
}

/**
 * Create a VisibilityApi implementation using Tauri IPC
 */
export function createTauriVisibilityApi(): VisibilityApi {
  return {
    async setVisibilityState(isVisible: boolean): Promise<IpcResult<void>> {
      // Rust expects: request: SetVisibilityRequest { is_visible }
      const request = { isVisible }
      return invokeIpc<void>(IPC_COMMANDS.SET_VISIBILITY_STATE, { request })
    }
  }
}
