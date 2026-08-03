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
import type {
  DetectedShells,
  DirectoryEntry,
  FileContent,
  IpcResult
} from '@shared/types/ipc.types'
import type { ProjectListPayload } from '@shared/types/web-projects.types'
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
async function postJson<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
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

/** PUT JSON and return the typed `IpcResult` body (or NETWORK_ERROR). */
async function putJson<T>(path: string, body: unknown): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
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
  },

  async readFile(filePath: string): Promise<IpcResult<FileContent>> {
    const encoded = encodeURIComponent(filePath)
    return getJson<FileContent>(`/fs/read?path=${encoded}`)
  },

  async deletePath(path: string, options?: { recursive?: boolean }): Promise<IpcResult<void>> {
    return postJson<void>('/fs/delete', {
      path,
      ...(options?.recursive ? { recursive: options.recursive } : {})
    })
  },

  async renameFile(oldPath: string, newPath: string): Promise<IpcResult<void>> {
    return postJson<void>('/fs/rename', { from: oldPath, to: newPath })
  },

  async copyFile(srcPath: string, destPath: string): Promise<IpcResult<void>> {
    return postJson<void>('/fs/copy', { from: srcPath, to: destPath })
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

/**
 * Project-list mirror routed to `termul-server` (`GET /projects`). Returns the
 * desktop's non-archived + archived project summaries the renderer synced into
 * the in-memory `ProjectRegistry` (Epic-4 bridge). Web/remote mode only.
 */
export const webServerProjects = {
  async list(): Promise<IpcResult<ProjectListPayload>> {
    return getJson<ProjectListPayload>('/projects')
  }
}

/** Global MCP registry persistence shared by standalone and desktop-hosted web clients. */
export const webServerMcpServers = {
  async get(): Promise<IpcResult<unknown>> {
    return getJson<unknown>('/mcp-servers')
  },

  async put(registry: unknown[]): Promise<IpcResult<void>> {
    return putJson<void>('/mcp-servers', registry)
  }
}

/**
 * On-demand MCP client probe (web parity). `POST /mcp-servers/probe` runs the
 * rmcp client probe on the termul-server host (where stdio commands execute).
 * Returns the same `IpcResult<ProbeResult>` shape the desktop Tauri command
 * yields — the renderer facade unwraps it. The probe itself never fails: a
 * reachable-but-disconnected server still returns `success:true` with
 * `data.status === 'disconnected'`. Only transport/deserialize failures surface
 * as `success:false` (`MCP_PROBE_INVALID_CONFIG` / `NETWORK_ERROR`).
 *
 * A client-side AbortController bounds the request at 12s — slightly above the
 * backend's 10s probe deadline — so a stalled `fetch` (hung TCP, no response)
 * resolves as `NETWORK_ERROR` instead of remaining pending forever. The signal
 * is cleared on completion (AbortController is GC'd once the request settles).
 */
const PROBE_TIMEOUT_MS = 12_000

export const webServerMcpProbe = {
  async post(server: unknown): Promise<IpcResult<unknown>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      return await postJson<unknown>('/mcp-servers/probe', server, controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }
}
