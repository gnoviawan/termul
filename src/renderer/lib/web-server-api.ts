/**
 * Fetch-based client for the web/remote mode (Story: Web/remote project
 * creation).
 *
 * When the renderer is NOT running inside a Tauri webview (`!isTauriContext()`),
 * the facades (`tauri-filesystem-api`, `git-api`, `shell-api`,
 * `tauri-dialog-api`) resolve to these server-backed implementations. They hit
 * the same-origin `termul-server` HTTP routes registered in
 * `src-tauri/src/web/router.rs` and return the SAME `IpcResult<T>` contract
 * the Tauri commands return — so callers (`NewProjectModal`,
 * `scaffoldProject`) are unchanged.
 *
 * Transport/parse failures (non-2xx, network error, bad JSON) are mapped to
 * `IpcResult { success: false, code: 'NETWORK_ERROR' }` so the renderer never
 * sees a thrown exception from the network layer.
 */
import type { DetectedShells, DirectoryEntry, IpcResult } from '@shared/types/ipc.types'
import { isTauriContext } from './tauri-runtime'

/**
 * Same-origin base for the embedded server. In web/remote mode the browser is
 * served by `termul-server` itself, so `window.location.origin` is the server.
 * Returns the empty string under Tauri (desktop build) so a misconfigured call
 * fails fast rather than hitting a phantom origin.
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

/**
 * Filesystem ops routed to `termul-server` (`/fs/*`). Only the methods project
 * creation touches are implemented; other `FilesystemApi` methods stay on their
 * desktop-only stubs in web mode (deferred to a later story).
 */
export const webServerFilesystem = {
  async createDirectory(dirPath: string): Promise<IpcResult<void>> {
    return postJson<void>('/fs/mkdir', { path: dirPath })
  },

  async createFile(filePath: string, content = ''): Promise<IpcResult<void>> {
    return postJson<void>('/fs/write', { path: filePath, content })
  },

  async readDirectory(dirPath: string): Promise<IpcResult<DirectoryEntry[]>> {
    const encoded = encodeURIComponent(dirPath)
    return getJson<DirectoryEntry[]>(`/fs/ls?path=${encoded}`)
  }
}

/**
 * Directory picker browse op routed to `termul-server` (`/fs/browse`). Returns
 * one level of children so `DirectoryPicker` can navigate host directories.
 */
export const webServerDialog = {
  async browseDirectory(path: string): Promise<IpcResult<DirectoryEntry[]>> {
    const encoded = encodeURIComponent(path)
    return getJson<DirectoryEntry[]>(`/fs/browse?path=${encoded}`)
  }
}

/** Git init routed to `termul-server` (`/git/init`). */
export const webServerGit = {
  async init(cwd: string): Promise<void> {
    const res = await postJson<void>('/git/init', { cwd })
    if (!res.success) {
      throw new Error(res.error)
    }
  }
}

/** Shell detection routed to `termul-server` (`/shells`). */
export const webServerShell = {
  async getAvailableShells(): Promise<IpcResult<DetectedShells>> {
    return getJson<DetectedShells>('/shells')
  }
}
