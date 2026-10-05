/**
 * Tauri IPC implementation of the ACP catalog facade (CAP-6 / Story 8).
 *
 * Mirrors the desktop `#[tauri::command] acp_list_catalog` +
 * `acp_set_catalog_opt_in` handlers in `src-tauri/src/acp/commands.rs`. The
 * Rust commands wrap their results in `IpcResult<T>`, so this adapter maps
 * `invoke()` → `IpcResult<T>` without double-wrapping (via the shared
 * `ipc/tauri.ts` `invokeIpc` helper).
 *
 * The web/remote fallback lives in `web-acp-catalog-api.ts` and hits the two
 * HTTP routes registered in `web/catalog_api.rs`. Both impls return the SAME
 * `IpcResult<...>` shape byte-for-byte — the `parity-checklist.test.ts` pins
 * this.
 */

import type { AcpCatalog, AcpCatalogApi } from '@shared/types/acp-catalog.types'
import type { IpcResult } from '@shared/types/ipc.types'

import { invokeIpc } from './ipc/tauri'
import { isTauriContext } from './tauri-runtime'

/** IPC command names matching the Rust `#[tauri::command]` declarations. */
const IPC_COMMANDS = {
  LIST_CATALOG: 'acp_list_catalog',
  SET_OPT_IN: 'acp_set_catalog_opt_in',
  IS_OPT_IN: 'acp_is_catalog_opt_in'
} as const

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
      if (!isTauriContext()) {
        return {
          success: false,
          error: 'acp_is_catalog_opt_in requires the Tauri runtime',
          code: 'INVOKE_ERROR'
        }
      }
      return invokeIpc<boolean>(IPC_COMMANDS.IS_OPT_IN)
    }
  }
}
