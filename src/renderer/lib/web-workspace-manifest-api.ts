/**
 * Fetch-based HTTP impl of the workspace-manifest facade (CAP-5 / Story 5).
 *
 * Mirrors the desktop Tauri command impl over the three HTTP routes
 * registered in `src-tauri/src/web/workspace_api.rs`. Transport/parse
 * failures map to `IpcResult { success: false, code: 'NETWORK_ERROR' }` so
 * the renderer never sees a thrown exception from the network layer.
 *
 * Routes (same-origin under `termul-server`):
 * - `GET  /workspace/:projectId` — load.
 * - `POST /workspace/:projectId/write` — revision-checked write.
 * - `POST /workspace/:projectId/delete` — idempotent delete.
 *
 * The `IpcBody<T>` shape the HTTP routes return matches the renderer-side
 * `IpcResult<T>` byte-for-byte — this adapter only maps a transport/parse
 * failure to `NETWORK_ERROR`; a structured `IpcBody` is parsed into the
 * success/failure body variant the route returned on ANY status (the web auth
 * gate's 401 UNAUTHORIZED keeps its code/message).
 */
import type { IpcResult } from '@shared/types/ipc.types'
import type {
  WorkspaceManifest,
  WorkspaceManifestApi,
  WorkspaceManifestWriteRequestBody,
  WriteOutcome
} from '@shared/types/workspace-manifest.types'

import { getJson, postJson } from './ipc/http'

/**
 * The fetch-backed impl of [`WorkspaceManifestApi`]. The singleton in
 * `workspace-manifest-api.ts` picks this when `!isTauriContext()`.
 *
 * Patch 14: empty `projectId` is rejected at the facade boundary with
 * `VALIDATION_ERROR` so a misconfigured call never hits `fetch('/workspace/')`
 * (which would 404 or hit the wrong route).
 */
export const webWorkspaceManifestApi: WorkspaceManifestApi = {
  getManifest(projectId: string): Promise<IpcResult<WorkspaceManifest | null>> {
    if (!projectId) {
      return Promise.resolve({
        success: false,
        error: 'projectId is required',
        code: 'VALIDATION_ERROR'
      })
    }
    const encoded = encodeURIComponent(projectId)
    return getJson<WorkspaceManifest | null>(`/workspace/${encoded}`)
  },

  writeManifest(
    projectId: string,
    basedRevision: number | null,
    manifest: WorkspaceManifest
  ): Promise<IpcResult<WriteOutcome>> {
    if (!projectId) {
      return Promise.resolve({
        success: false,
        error: 'projectId is required',
        code: 'VALIDATION_ERROR'
      })
    }
    const encoded = encodeURIComponent(projectId)
    const body: WorkspaceManifestWriteRequestBody = { basedRevision, manifest }
    return postJson<WriteOutcome>(`/workspace/${encoded}/write`, body)
  },

  deleteManifest(projectId: string): Promise<IpcResult<void>> {
    if (!projectId) {
      return Promise.resolve({
        success: false,
        error: 'projectId is required',
        code: 'VALIDATION_ERROR'
      })
    }
    const encoded = encodeURIComponent(projectId)
    return postJson<void>(`/workspace/${encoded}/delete`, {})
  }
}
