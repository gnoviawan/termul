import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { IpcResult, SystemApi } from '@shared/types/ipc.types'

/**
 * IPC Event names
 */
const IPC_EVENTS = {
  POWER_RESUME: 'system://power-resume'
} as const

/**
 * IPC Command names
 */
const IPC_COMMANDS = {
  GET_HOME_DIRECTORY: 'system_get_home_directory',
  GET_PLATFORM: 'system_get_platform'
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
 * Heartbeat interval for power resume detection (fallback)
 */
const HEARTBEAT_INTERVAL_MS = 30_000
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastHeartbeat = Date.now()

/**
 * Create a SystemApi implementation using Tauri IPC
 */
export function createTauriSystemApi(): SystemApi {
  return {
    async getHomeDirectory(): Promise<IpcResult<string>> {
      return invokeIpc<string>(IPC_COMMANDS.GET_HOME_DIRECTORY)
    },

    onPowerResume(callback: () => void): () => void {
      // Try to use the IPC event first
      let unlistenFn: UnlistenFn | null = null
      listen(IPC_EVENTS.POWER_RESUME, () => {
        callback()
      }).then((fn) => {
        unlistenFn = fn
      }).catch(() => {
        // If IPC fails, use heartbeat fallback
        unlistenFn = null
      })

      // Also set up heartbeat fallback
      heartbeatTimer = setInterval(() => {
        const now = Date.now()
        const elapsed = now - lastHeartbeat

        if (elapsed > HEARTBEAT_INTERVAL_MS * 2) {
          // System likely resumed from sleep
          callback()
        }
        lastHeartbeat = now
      }, HEARTBEAT_INTERVAL_MS)

      return () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer)
          heartbeatTimer = null
        }
        unlistenFn?.()
      }
    }
  }
}

/**
 * Direct export singleton for convenience (matches api-bridge pattern)
 * Extended with getPlatform method
 */
export const tauriSystemApi = {
  async getHomeDirectory(): Promise<IpcResult<string>> {
    return invokeIpc<string>(IPC_COMMANDS.GET_HOME_DIRECTORY)
  },

  onPowerResume(callback: () => void): () => void {
    heartbeatTimer = setInterval(() => {
      const now = Date.now()
      const elapsed = now - lastHeartbeat

      if (elapsed > HEARTBEAT_INTERVAL_MS * 2) {
        // System likely resumed from sleep
        callback()
      }
      lastHeartbeat = now
    }, HEARTBEAT_INTERVAL_MS)

    return () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
    }
  },

  async getPlatform(): Promise<IpcResult<string>> {
    return invokeIpc<string>(IPC_COMMANDS.GET_PLATFORM)
  }
}
