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
 * failure to `NETWORK_ERROR`; a successful HTTP response is parsed into the
 * success/failure body variant the route returned.
 */
import type { IpcResult } from '@shared/types/ipc.types'
import type {
  WorkspaceManifest,
  WorkspaceManifestApi,
  WorkspaceManifestWriteRequestBody,
  WriteOutcome
} from '@shared/types/workspace-manifest.types'

import { isTauriContext } from './tauri-runtime'

/**
 * Same-origin base for the embedded server. In web/remote mode the browser is
 * served by `termul-server` itself, so `window.location.origin` is the
 * server. Returns the empty string under Tauri (desktop build) so a
 * misconfigured call fails fast rather than hitting a phantom origin.
 */
function serverBase(): string {
  if (isTauriContext()) return ''
  if (typeof window === 'undefined' || !window.location) return ''
  return window.location.origin
}

/** Shape of the HTTP response body mirroring `IpcResult<T>`. */
type IpcBody<T> = { success: true; data: T } | { success: false; error: string; code: string }

/** Map any transport/parse failure to a uniform `IpcResult` failure. */
function networkError(detail: string): IpcResult<never> {
  return { success: false, error: detail, code: 'NETWORK_ERROR' }
}

/** Parse the `IpcBody<T>` JSON body into `IpcResult<T>`. */
async function parseBody<T>(res: Response): Promise<IpcResult<T>> {
  if (!res.ok) {
    return networkError(`HTTP ${res.status} ${res.statusText}`)
  }
  let body: IpcBody<T>
  try {
    body = (await res.json()) as IpcBody<T>
  } catch (err) {
    return networkError(err instanceof Error ? err.message : 'invalid JSON')
  }
  if (body.success) {
    return { success: true, data: body.data }
  }
  return { success: false, error: body.error, code: body.code }
}

/** POST JSON and return the typed `IpcResult` body (or NETWORK_ERROR). */
async function postJson<T>(path: string, body: unknown): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return await parseBody<T>(res)
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}

/** GET and return the typed `IpcResult` body (or NETWORK_ERROR). */
async function getJson<T>(path: string): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, { method: 'GET' })
    return await parseBody<T>(res)
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}

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
