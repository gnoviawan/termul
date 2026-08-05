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
  GitCommit,
  GitCommitContext,
  GitStashInfo,
  GitStatusDetail,
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

/**
 * Git ops routed to `termul-server` (`/git/*`). CAP-1 parity: each method
 * mirrors a desktop `#[tauri::command] git_*` handler and returns unwrapped
 * data, throwing on `!res.success` (matching the existing `init` template) so
 * the renderer facade (`git-api.ts`) can branch `isTauriContext()` between
 * `invoke(...)` and these HTTP impls without changing call-site ergonomics.
 */
export const webServerGit = {
  async init(cwd: string): Promise<void> {
    const res = await postJson<void>('/git/init', { cwd })
    if (!res.success) {
      throw new Error(res.error)
    }
  },

  async getStatus(cwd: string): Promise<GitStatusDetail[]> {
    const res = await postJson<GitStatusDetail[]>('/git/status', { cwd })
    if (!res.success) throw new Error(res.error)
    return res.data
  },

  async getDiff(cwd: string, path: string, staged = false): Promise<string> {
    const res = await postJson<string>('/git/diff', { cwd, path, staged })
    if (!res.success) throw new Error(res.error)
    return res.data
  },

  async stage(cwd: string, path: string): Promise<void> {
    const res = await postJson<void>('/git/stage', { cwd, path })
    if (!res.success) throw new Error(res.error)
  },

  async unstage(cwd: string, path: string): Promise<void> {
    const res = await postJson<void>('/git/unstage', { cwd, path })
    if (!res.success) throw new Error(res.error)
  },

  async discard(cwd: string, path: string): Promise<void> {
    const res = await postJson<void>('/git/discard', { cwd, path })
    if (!res.success) throw new Error(res.error)
  },

  async getLog(cwd: string, limit?: number): Promise<GitCommit[]> {
    const res = await postJson<GitCommit[]>('/git/log', {
      cwd,
      ...(limit !== undefined ? { limit } : {})
    })
    if (!res.success) throw new Error(res.error)
    return res.data
  },

  async commit(cwd: string, summary: string, description = '', amend = false): Promise<void> {
    const res = await postJson<void>('/git/commit', { cwd, summary, description, amend })
    if (!res.success) throw new Error(res.error)
  },

  async push(cwd: string): Promise<void> {
    const res = await postJson<void>('/git/push', { cwd })
    if (!res.success) throw new Error(res.error)
  },

  async getCommitContext(cwd: string): Promise<GitCommitContext> {
    const res = await postJson<GitCommitContext>('/git/commit-context', { cwd })
    if (!res.success) throw new Error(res.error)
    return res.data
  },

  async checkoutBranch(cwd: string, branch: string, isRemote = false): Promise<void> {
    const res = await postJson<void>('/git/checkout-branch', { cwd, branch, isRemote })
    if (!res.success) throw new Error(res.error)
  },

  async createBranch(cwd: string, branch: string, startRef?: string): Promise<void> {
    const res = await postJson<void>('/git/create-branch', {
      cwd,
      branch,
      ...(startRef !== undefined ? { startRef } : {})
    })
    if (!res.success) throw new Error(res.error)
  },

  async stashSave(cwd: string, message?: string, includeUntracked?: boolean): Promise<void> {
    const res = await postJson<void>('/git/stash-save', {
      cwd,
      ...(message !== undefined ? { message } : {}),
      ...(includeUntracked !== undefined ? { includeUntracked } : {})
    })
    if (!res.success) throw new Error(res.error)
  },

  async stashList(cwd: string): Promise<GitStashInfo[]> {
    const encoded = encodeURIComponent(cwd)
    const res = await getJson<GitStashInfo[]>(`/git/stash-list?cwd=${encoded}`)
    if (!res.success) throw new Error(res.error)
    return res.data
  },

  async stashApply(cwd: string, index: number): Promise<void> {
    const res = await postJson<void>('/git/stash-apply', { cwd, index })
    if (!res.success) throw new Error(res.error)
  },

  async stashPop(cwd: string, index: number): Promise<void> {
    const res = await postJson<void>('/git/stash-pop', { cwd, index })
    if (!res.success) throw new Error(res.error)
  },

  async stashDrop(cwd: string, index: number): Promise<void> {
    const res = await postJson<void>('/git/stash-drop', { cwd, index })
    if (!res.success) throw new Error(res.error)
  },

  async branchList(cwd: string): Promise<string[]> {
    const encoded = encodeURIComponent(cwd)
    const res = await getJson<string[]>(`/git/branch-list?cwd=${encoded}`)
    if (!res.success) throw new Error(res.error)
    return res.data
  },

  async branchSwitch(cwd: string, name: string): Promise<void> {
    const res = await postJson<void>('/git/branch-switch', { cwd, name })
    if (!res.success) throw new Error(res.error)
  },

  async branchCreate(cwd: string, name: string): Promise<void> {
    const res = await postJson<void>('/git/branch-create', { cwd, name })
    if (!res.success) throw new Error(res.error)
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
 *
 * Also exposes the explicit host-default change (`POST /projects/default`,
 * Epic 7) — mirrors the `set_host_default_project` Tauri command + the
 * `set_default_project` WS request (transport parity).
 */
export const webServerProjects = {
  async list(): Promise<IpcResult<ProjectListPayload>> {
    return getJson<ProjectListPayload>('/projects')
  },

  /**
   * Set the host's default project (Epic 7 — cross-client workspace
   * continuity). Validates the project is switchable, updates
   * `registry.set_default_project`, persists to the `FileProjectRegistry`
   * (VPS), and broadcasts `projects_changed` to all connected clients.
   */
  async setDefaultProject(projectId: string): Promise<IpcResult<void>> {
    return postJson<void>('/projects/default', { projectId })
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
 * Agent skills routed to `termul-server` (`/skills`). CAP-2 parity: each method
 * mirrors a desktop `#[tauri::command]` skills handler and returns unwrapped
 * data, throwing on `!res.success` so the renderer facade (`skills-api.ts`)
 * can branch `isTauriContext()` between `invoke(...)` and these HTTP impls.
 */
import type { AgentSkillContent, AgentSkillSummary } from './skills-api'

export const webServerSkills = {
  async list(projectRoot?: string): Promise<AgentSkillSummary[]> {
    const params = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ''
    const res = await getJson<AgentSkillSummary[]>(`/skills${params}`)
    if (!res.success) throw new Error(res.error)
    return res.data
  },

  async read(name: string, projectRoot?: string): Promise<AgentSkillContent> {
    const params = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ''
    const res = await getJson<AgentSkillContent>(`/skills/${encodeURIComponent(name)}${params}`)
    if (!res.success) throw new Error(res.error)
    return res.data
  }
}

/**
 * Frontend error forwarding routed to `termul-server` (`POST /log/frontend-error`).
 * CAP-2 parity: mirrors the desktop `log_frontend_error` Tauri command. Returns
 * unwrapped; throws are swallowed by the caller (`log-api.ts`).
 */
export const webServerLog = {
  async frontendError(payload: {
    level?: string
    message: string
    source?: string
    stack?: string
    componentStack?: string
  }): Promise<void> {
    const res = await postJson<void>('/log/frontend-error', {
      level: payload.level ?? 'error',
      message: payload.message,
      source: payload.source ?? 'renderer',
      stack: payload.stack ?? null,
      componentStack: payload.componentStack ?? null
    })
    if (!res.success) throw new Error(res.error)
  }
}

/**
 * Content search routed to `termul-server` (`/search/*`). CAP-2 parity: each
 * method mirrors a desktop `#[tauri::command] search_*` handler and returns
 * unwrapped data, throwing on `!res.success`.
 */
export const webServerSearch = {
  async rgInfo(): Promise<{
    sidecarBinaryName: string
    resolvedPath: string
    source: string
    exists: boolean
  }> {
    const res = await getJson<{
      sidecarBinaryName: string
      resolvedPath: string
      source: string
      exists: boolean
    }>('/search/rg-info')
    if (!res.success) throw new Error(res.error)
    return res.data
  },

  async content(
    scopeRoot: string,
    rootPath: string,
    query: string
  ): Promise<{
    results: Array<{ filePath: string; matches: Array<{ lineNumber: number; lineText: string }> }>
    truncated: boolean
    scannedFiles: number
    failedFiles: number
  }> {
    const res = await postJson<{
      results: Array<{ filePath: string; matches: Array<{ lineNumber: number; lineText: string }> }>
      truncated: boolean
      scannedFiles: number
      failedFiles: number
    }>('/search/content', { scopeRoot, rootPath, query })
    if (!res.success) throw new Error(res.error)
    return res.data
  },

  async cancel(searchId: string): Promise<void> {
    const res = await postJson<void>('/search/cancel', { searchId })
    if (!res.success) throw new Error(res.error)
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
