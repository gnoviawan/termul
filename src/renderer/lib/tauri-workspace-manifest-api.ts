/**
 * Tauri IPC implementation of the workspace-manifest facade (CAP-5 / Story 5).
 *
 * Mirrors the desktop `#[tauri::command] workspace_manifest_*` handlers in
 * `src-tauri/src/commands.rs`. The Rust commands already wrap their results
 * in `IpcResult<T>`, so this adapter maps `invoke()` → `IpcResult<T>` without
 * double-wrapping (mirrors `tauri-terminal-api.ts`'s `invokeIpc` pattern).
 *
 * The web/remote fallback lives in `web-workspace-manifest-api.ts` and hits
 * the three HTTP routes registered in `web/workspace_api.rs`. Both impls
 * return the SAME `IpcResult<...>` shape byte-for-byte — the
 * `parity-checklist.test.ts` pins this.
 */
import type { IpcResult } from '@shared/types/ipc.types'
import type {
  WorkspaceManifest,
  WorkspaceManifestApi,
  WriteOutcome
} from '@shared/types/workspace-manifest.types'
import { type InvokeArgs, invoke } from '@tauri-apps/api/core'

import { isTauriContext } from './tauri-runtime'

/** IPC command names matching the Rust `#[tauri::command]` declarations. */
const IPC_COMMANDS = {
  GET: 'workspace_manifest_get',
  WRITE: 'workspace_manifest_write',
  DELETE: 'workspace_manifest_delete'
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
 * Build the Tauri IPC impl of [`WorkspaceManifestApi`]. Returns the typed
 * facade; the singleton in `workspace-manifest-api.ts` picks this when
 * `isTauriContext()` is true.
 *
 * Outside a Tauri webview, every method returns `IpcResult { success: false,
 * code: 'INVOKE_ERROR' }` — the facade singleton NEVER picks this impl when
 * `!isTauriContext()`, but the guard is here for tests that construct this
 * adapter directly.
 *
 * Patch 14: empty `projectId` is rejected at the facade boundary with
 * `VALIDATION_ERROR` (before the IPC layer) so a misconfigured call surfaces
 * a clear validation error rather than a Rust-side `InvalidProjectId` /
 * `INVOKE_ERROR`.
 */
export function createTauriWorkspaceManifestApi(): WorkspaceManifestApi {
  return {
    async getManifest(projectId: string): Promise<IpcResult<WorkspaceManifest | null>> {
      if (!projectId) {
        return {
          success: false,
          error: 'projectId is required',
          code: 'VALIDATION_ERROR'
        }
      }
      if (!isTauriContext()) {
        return {
          success: false,
          error: 'workspace_manifest_get requires the Tauri runtime',
          code: 'INVOKE_ERROR'
        }
      }
      return invokeIpc<WorkspaceManifest | null>(IPC_COMMANDS.GET, { projectId })
    },

    async writeManifest(
      projectId: string,
      basedRevision: number | null,
      manifest: WorkspaceManifest
    ): Promise<IpcResult<WriteOutcome>> {
      if (!projectId) {
        return {
          success: false,
          error: 'projectId is required',
          code: 'VALIDATION_ERROR'
        }
      }
      if (!isTauriContext()) {
        return {
          success: false,
          error: 'workspace_manifest_write requires the Tauri runtime',
          code: 'INVOKE_ERROR'
        }
      }
      return invokeIpc<WriteOutcome>(IPC_COMMANDS.WRITE, {
        projectId,
        basedRevision,
        manifest
      })
    },

    async deleteManifest(projectId: string): Promise<IpcResult<void>> {
      if (!projectId) {
        return {
          success: false,
          error: 'projectId is required',
          code: 'VALIDATION_ERROR'
        }
      }
      if (!isTauriContext()) {
        return {
          success: false,
          error: 'workspace_manifest_delete requires the Tauri runtime',
          code: 'INVOKE_ERROR'
        }
      }
      return invokeIpc<void>(IPC_COMMANDS.DELETE, { projectId })
    }
  }
}
