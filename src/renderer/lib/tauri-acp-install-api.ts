/**
 * Tauri IPC implementation of the ACP install facade (CAP-6 / Story 9).
 *
 * Mirrors the desktop `#[tauri::command] acp_install_agent` handler in
 * `src-tauri/src/acp/commands.rs`. The Rust command wraps its result in
 * `IpcResult<T>`, so this adapter maps `invoke()` → `IpcResult<T>` without
 * double-wrapping (mirrors `tauri-acp-catalog-api.ts`'s `invokeIpc` pattern).
 *
 * The web/remote fallback lives in `web-acp-install-api.ts` and hits the
 * `POST /acp/install` route registered in `web/install_api.rs`. Both impls
 * return the SAME `IpcResult<...>` shape byte-for-byte — the
 * `parity-checklist.test.ts` pins this.
 */

import type { AcpInstallApi, InstallOutcome } from '@shared/types/acp-install.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { type InvokeArgs, invoke } from '@tauri-apps/api/core'

import { isTauriContext } from './tauri-runtime'

/** IPC command name matching the Rust `#[tauri::command]` declaration. */
const IPC_COMMANDS = {
  INSTALL_AGENT: 'acp_install_agent'
} as const

/**
 * Invoke a Tauri IPC command that already returns `IpcResult<T>` from Rust.
 * Maps a thrown invoke failure (Rust panic, IPC serialization error) to
 * `IpcResult { success: false, code: 'INVOKE_ERROR' }` so the renderer never
 * sees a thrown exception from the IPC layer.
 */
async function invokeIpc<T>(command: string, args?: InvokeArgs): Promise<IpcResult<T>> {
  try {
    return await invoke<IpcResult<T>>(command, args)
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'INVOKE_ERROR'
    }
  }
}

/**
 * Build the Tauri IPC impl of [`AcpInstallApi`]. Returns the typed facade;
 * the singleton in `acp-install-api.ts` picks this when `isTauriContext()`
 * is true.
 *
 * Outside a Tauri webview, the method returns
 * `IpcResult { success: false, code: 'INVOKE_ERROR' }` — the facade singleton
 * NEVER picks this impl when `!isTauriContext()`, but the guard is here for
 * tests that construct this adapter directly.
 */
export function createTauriAcpInstallApi(): AcpInstallApi {
  return {
    async installAgent(agentId: string): Promise<IpcResult<InstallOutcome>> {
      if (!isTauriContext()) {
        return {
          success: false,
          error: 'acp_install_agent requires the Tauri runtime',
          code: 'INVOKE_ERROR'
        }
      }
      return invokeIpc<InstallOutcome>(IPC_COMMANDS.INSTALL_AGENT, {
        request: { agentId }
      })
    }
  }
}
