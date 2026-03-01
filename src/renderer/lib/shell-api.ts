/**
 * Shell API Singleton
 *
 * Exports a singleton instance of the ShellApi for use throughout the app.
 * This provides a consistent interface whether running under Electron or Tauri.
 *
 * Usage:
 *   import { shellApi } from '@/lib/shell-api'
 *   const result = await shellApi.getAvailableShells()
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import type { ShellApi, IpcResult, DetectedShells } from '@shared/types/ipc.types'

/**
 * IPC Command name for shell detection
 */
const IPC_COMMAND = 'detect_shells'

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
 * Create a ShellApi implementation using Tauri IPC
 */
function createTauriShellApi(): ShellApi {
  return {
    async getAvailableShells(): Promise<IpcResult<DetectedShells>> {
      return invokeIpc<DetectedShells>(IPC_COMMAND)
    }
  }
}

/**
 * Singleton ShellApi instance
 *
 * Uses Tauri IPC implementation when running in Tauri context.
 * In the future, this could conditionally export an Electron implementation
 * based on build environment.
 */
export const shellApi: ShellApi = createTauriShellApi()
