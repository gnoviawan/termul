/**
 * Tauri IPC implementation of the ACP catalog facade (CAP-6 / Story 8).
 *
 * Mirrors the desktop `#[tauri::command] acp_list_catalog` +
 * `acp_set_catalog_opt_in` handlers in `src-tauri/src/acp/commands.rs`. The
 * Rust commands wrap their results in `IpcResult<T>`, so this adapter maps
 * `invoke()` → `IpcResult<T>` without double-wrapping (mirrors
 * `tauri-workspace-manifest-api.ts`'s `invokeIpc` pattern).
 *
 * The web/remote fallback lives in `web-acp-catalog-api.ts` and hits the two
 * HTTP routes registered in `web/catalog_api.rs`. Both impls return the SAME
 * `IpcResult<...>` shape byte-for-byte — the `parity-checklist.test.ts` pins
 * this.
 */

import type { AcpCatalog, AcpCatalogApi } from '@shared/types/acp-catalog.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { type InvokeArgs, invoke } from '@tauri-apps/api/core'

import { isTauriContext } from './tauri-runtime'

/** IPC command names matching the Rust `#[tauri::command]` declarations. */
const IPC_COMMANDS = {
  LIST_CATALOG: 'acp_list_catalog',
  SET_OPT_IN: 'acp_set_catalog_opt_in'
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
 * Build the Tauri IPC impl of [`AcpCatalogApi`]. Returns the typed facade;
 * the singleton in `acp-catalog-api.ts` picks this when `isTauriContext()`
 * is true.
 *
 * Outside a Tauri webview, every method returns
 * `IpcResult { success: false, code: 'INVOKE_ERROR' }` — the facade singleton
 * NEVER picks this impl when `!isTauriContext()`, but the guard is here for
 * tests that construct this adapter directly.
 */
export function createTauriAcpCatalogApi(): AcpCatalogApi {
  return {
    async listCatalog(refresh?: boolean): Promise<IpcResult<AcpCatalog>> {
      if (!isTauriContext()) {
        return {
          success: false,
          error: 'acp_list_catalog requires the Tauri runtime',
          code: 'INVOKE_ERROR'
        }
      }
      return invokeIpc<AcpCatalog>(IPC_COMMANDS.LIST_CATALOG, {
        refresh: refresh ?? false
      })
    },

    async setCatalogOptIn(enabled: boolean): Promise<IpcResult<void>> {
      if (!isTauriContext()) {
        return {
          success: false,
          error: 'acp_set_catalog_opt_in requires the Tauri runtime',
          code: 'INVOKE_ERROR'
        }
      }
      return invokeIpc<void>(IPC_COMMANDS.SET_OPT_IN, { enabled })
    },

    async isCatalogOptedIn(): Promise<IpcResult<boolean>> {
      // The opt-in state is host-persisted; the desktop resolves it through
      // `listCatalog()` (the catalog response carries the resolved agents,
      // and the opt-in is observable via whether CDN entries are present).
      // A dedicated `acp_is_catalog_opt_in` command is deferred — the
      // facade exposes the method so callers can probe, but the impl
      // derives from `listCatalog()` for now.
      if (!isTauriContext()) {
        return {
          success: false,
          error: 'acp_is_catalog_opt_in requires the Tauri runtime',
          code: 'INVOKE_ERROR'
        }
      }
      // Derive from listCatalog: if any agent has source 'registry', the
      // opt-in is on. This is a best-effort probe — a dedicated command
      // would be cleaner but the spec says "single boolean opt-in" and the
      // catalog response is the source of truth.
      const result = await invokeIpc<AcpCatalog>(IPC_COMMANDS.LIST_CATALOG, {
        refresh: false
      })
      if (!result.success) {
        return result as IpcResult<boolean>
      }
      const optedIn = result.data?.agents.some((agent) => agent.source === 'registry') ?? false
      return { success: true, data: optedIn }
    }
  }
}
