import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import type { IpcResult, SystemApi } from '@shared/types/ipc.types'

/**
 * IPC Event names
 *
 * NOTE: The POWER_RESUME event is NOT emitted by the backend.
 * This file uses a heartbeat-based fallback approach instead.
 *
 * See decision document: docs/decisions/keyboard-system-event-mode-final.md
 *
 * In Electron, power resume detection uses 'system:power-resume' event,
 * but the Electron backend ALSO does not emit this event (it's a stub).
 * Therefore, using a heartbeat fallback provides actual parity (or better).
 *
 * The heartbeat approach works by:
 * 1. Setting a recurring interval timer (30 seconds)
 * 2. Tracking the last heartbeat timestamp
 * 3. If more than 2 intervals have passed, system was likely asleep
 * 4. Triggering the resume callback when sleep is detected
 */
const IPC_EVENTS = {
  POWER_RESUME: 'system://power-resume' // Not emitted - using heartbeat fallback instead
} as const

/**
 * IPC Command names
 * Must match Rust command names in src-tauri/src/lib.rs
 */
const IPC_COMMANDS = {
  GET_HOME_DIRECTORY: 'get_home_directory'
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
 * Heartbeat interval for power resume detection.
 *
 * This is the CHOSEN approach for detecting system sleep/resume, not a workaround.
 * The Electron implementation also lacks a proper backend emitter for power-resume,
 * so this heartbeat method provides equivalent (or better) functionality.
 *
 * Interval: 30 seconds
 * Detection threshold: 2x interval (60 seconds) = system was asleep
 */
const HEARTBEAT_INTERVAL_MS = 30_000
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastHeartbeat = Date.now()

/**
 * Create a SystemApi implementation using Tauri IPC
 *
 * FALLBACK MODE for power resume detection:
 *
 * The onPowerResume implementation uses a heartbeat-based approach rather than
 * backend event emitters. This is the intentional design decision, documented in:
 * docs/decisions/keyboard-system-event-mode-final.md
 *
 * Rationale:
 * - OS-specific power monitoring in Rust is complex (windows-rs, NSWorkspace, systemd)
 * - Electron's power-resume is also a stub (no actual backend emitter)
 * - Heartbeat approach is cross-platform and reliable
 * - Estimated effort for proper backend events: 2-3 days (not worth the value)
 */
export function createTauriSystemApi(): SystemApi {
  return {
    async getHomeDirectory(): Promise<IpcResult<string>> {
      return invokeIpc<string>(IPC_COMMANDS.GET_HOME_DIRECTORY)
    },

    onPowerResume(callback: () => void): () => void {
      // Heartbeat-based power resume detection (chosen approach)
      // See: docs/decisions/keyboard-system-event-mode-final.md
      heartbeatTimer = setInterval(() => {
        const now = Date.now()
        const elapsed = now - lastHeartbeat

        if (elapsed > HEARTBEAT_INTERVAL_MS * 2) {
          // System likely resumed from sleep
          // More than 2 intervals have passed without the timer running
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
    }
  }
}

/**
 * Direct export singleton for convenience (matches api-bridge pattern)
 *
 * FALLBACK MODE for power resume detection - see documentation above.
 *
 * NOTE: getPlatform was removed - the corresponding Rust command does not exist.
 * Use tauri-plugin-os's platform() directly if needed.
 */
export const tauriSystemApi = {
  async getHomeDirectory(): Promise<IpcResult<string>> {
    return invokeIpc<string>(IPC_COMMANDS.GET_HOME_DIRECTORY)
  },

  onPowerResume(callback: () => void): () => void {
    // Heartbeat-based power resume detection (chosen approach)
    // See: docs/decisions/keyboard-system-event-mode-final.md
    heartbeatTimer = setInterval(() => {
      const now = Date.now()
      const elapsed = now - lastHeartbeat

      if (elapsed > HEARTBEAT_INTERVAL_MS * 2) {
        // System likely resumed from sleep
        // More than 2 intervals have passed without the timer running
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
  }
}

/**
 * @internal Testing only - reset heartbeat state between tests
 */
export function _resetSystemHeartbeatForTesting(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  lastHeartbeat = Date.now()
}
