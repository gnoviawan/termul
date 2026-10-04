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
 * Transport/parse failures (network error, bad JSON, or a non-2xx without a
 * structured body) are mapped to `IpcResult { success: false, code:
 * 'NETWORK_ERROR' }` so the renderer never sees a thrown exception from the
 * network layer. A non-2xx response carrying a valid `IpcBody` failure (e.g.
 * the web auth gate's 401 UNAUTHORIZED) keeps the server-provided code/message.
 */
import type {
  BranchInfo,
  DetectedShells,
  DirectoryEntry,
  DirtyStatus,
  FileContent,
  FileInfo,
  GitCommit,
  GitCommitContext,
  GitStashInfo,
  GitStatusDetail,
  IpcResult,
  WorktreeInfo,
  WorktreeProgressEvent
} from '@shared/types/ipc.types'
import type { ProjectListPayload, ProjectSummary } from '@shared/types/web-projects.types'
import { getJson, networkError, parseBody, postJson, putJson, serverBase } from './ipc/http'
import { logFrontendError } from './log-api'
import type { AgentSkillContent, AgentSkillSummary } from './skills-api'
import { authHeader } from './web-auth-token'
import type { BaseBranchInfo, IncludeCopyResult } from './worktree-api'

/**
 * POST JSON and read an `application/x-ndjson` response stream. Each line is
 * a JSON frame; `onFrame` receives non-result frames and the terminal
 * `{"type":"result"}` frame's `result` payload becomes the returned
 * `IpcResult`. A response that is not NDJSON (early guard/validation
 * failures still answer with the plain `IpcBody` envelope) falls back to
 * `parseBody`. A stream ending without a result frame maps to NETWORK_ERROR.
 */
async function postNdjsonStream<T>(
  path: string,
  body: unknown,
  onFrame: (frame: Record<string, unknown>) => void
): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: JSON.stringify(body)
    })
    const contentType = res.headers.get('content-type') ?? ''
    if (!res.body || !contentType.includes('application/x-ndjson')) {
      return await parseBody<T>(res)
    }
    let result: IpcResult<T> | undefined
    const handleLine = (raw: string) => {
      const trimmed = raw.trim()
      if (!trimmed) return
      try {
        const frame = JSON.parse(trimmed) as Record<string, unknown>
        if (frame.type === 'result') {
          result = frame.result as IpcResult<T>
        } else {
          onFrame(frame)
        }
      } catch {
        // Malformed frame — skip it; log noise must not fail the request.
      }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      let idx = buffered.indexOf('\n')
      while (idx !== -1) {
        handleLine(buffered.slice(0, idx))
        buffered = buffered.slice(idx + 1)
        idx = buffered.indexOf('\n')
      }
    }
    handleLine(buffered + decoder.decode())
    if (!result) {
      return networkError('worktree create stream ended without a result')
    }
    return result
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Filesystem ops routed to `termul-server` (`/fs/*`). The methods project
 * creation, file editing, and file inspection touch are implemented. Streaming
 * search (`/search/ws`) and directory watching (server-side `notify` + event
 * channel) are not yet implemented on the server; the renderer facade returns
 * `WEB_UNSUPPORTED` for those (see `tauri-filesystem-api.ts`).
 */
export const webServerFilesystem = {
  async createDirectory(dirPath: string): Promise<IpcResult<void>> {
    return postJson<void>('/fs/mkdir', { path: dirPath })
  },

  async createFile(filePath: string, content = ''): Promise<IpcResult<void>> {
    return postJson<void>('/fs/write', { path: filePath, content })
  },

  async writeFile(filePath: string, content: string): Promise<IpcResult<void>> {
    return postJson<void>('/fs/write', { path: filePath, content })
  },

  async readDirectory(dirPath: string): Promise<IpcResult<DirectoryEntry[]>> {
    const encoded = encodeURIComponent(dirPath)
    // Story 10 (F11): bound the read. A blackholed server (TCP open, no
    // response) otherwise leaves this fetch pending forever — the Explorer's
    // `finally` never runs and the panel strands on "Loading…" until a full
    // reload. 30s is generous for a same-origin directory listing; on expiry
    // the abort reason surfaces as a NETWORK_ERROR the store renders as a
    // retryable rootLoadError.
    const controller = new AbortController()
    const timer = setTimeout(() => {
      // Durable boundary log for the timeout event itself — the operation +
      // the 30s bound + the code the abort surfaces as. The requested
      // directory path is deliberately NOT logged (sensitive path data).
      void logFrontendError({
        level: 'warn',
        source: 'webServerFilesystem.readDirectory',
        message: 'readDirectory timed out after 30000ms (NETWORK_ERROR)'
      })
      controller.abort(new Error('Directory read timed out'))
    }, 30_000)
    try {
      return await getJson<DirectoryEntry[]>(`/fs/ls?path=${encoded}`, controller.signal)
    } finally {
      clearTimeout(timer)
    }
  },

  async readFile(filePath: string): Promise<IpcResult<FileContent>> {
    const encoded = encodeURIComponent(filePath)
    return getJson<FileContent>(`/fs/read?path=${encoded}`)
  },

  async getFileInfo(filePath: string): Promise<IpcResult<FileInfo>> {
    const encoded = encodeURIComponent(filePath)
    return getJson<FileInfo>(`/fs/info?path=${encoded}`)
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
  },

  /**
   * Create / upsert a project (Option B: the standalone server is a first-class
   * project-list authority). Canonicalizes + validates the path on the server,
   * persists to `FileProjectRegistry` (VPS), and broadcasts `projects_changed`.
   * Mirrors the `add_project` WS request.
   */
  async addProject(params: {
    id: string
    name: string
    path: string
    color: string
    isArchived?: boolean
  }): Promise<IpcResult<ProjectSummary>> {
    return postJson<ProjectSummary>('/projects', params)
  },

  /**
   * Patch a project's display fields (name, color, archived). All fields
   * optional (partial update). Mirrors the `update_project` WS request +
   * `PUT /projects/{id}`.
   */
  async updateProject(
    projectId: string,
    patch: { name?: string; color?: string; isArchived?: boolean }
  ): Promise<IpcResult<void>> {
    return putJson<void>(`/projects/${encodeURIComponent(projectId)}`, patch)
  },

  /**
   * Remove a project. Mirrors the `remove_project` WS request +
   * `DELETE /projects/{id}`.
   */
  async removeProject(projectId: string): Promise<IpcResult<void>> {
    const res = await fetch(`${serverBase()}/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      headers: authHeader()
    })
    return parseBody<void>(res)
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
    level?: 'error' | 'warn' | 'info'
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
  },

  /**
   * One-shot filename search (issue #848). Mirrors the desktop
   * `#[tauri::command] search_file_names_stream` result shape: root-relative
   * paths with forward slashes, non-ignored-first when `includeIgnored`.
   * The mention picker debounces client-side, so a single batch replaces the
   * desktop's streaming batches.
   */
  async fileNames(
    root: string,
    query: string,
    includeIgnored?: boolean
  ): Promise<{
    files: Array<{ path: string; ignored: boolean }>
    truncated: boolean
  }> {
    const params = new URLSearchParams({ root, query })
    if (includeIgnored) params.set('includeIgnored', 'true')
    const res = await getJson<{
      files: Array<{ path: string; ignored: boolean }>
      truncated: boolean
    }>(`/search/file-names?${params.toString()}`)
    if (!res.success) throw new Error(res.error)
    return res.data
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

/**
 * Worktree ops routed to `termul-server` (`/worktree/*`). CAP — Web worktree
 * parity: each method mirrors a desktop `#[tauri::command] worktree_*` handler
 * and returns the SAME `IpcResult<T>` contract (the renderer facade
 * `worktree-api.ts` branches `isTauriContext()` between `invoke(...)` and these
 * HTTP impls). Only the 7 launch-flow routes ship here; the 8 advanced ops
 * stay `WEB_UNSUPPORTED` on web (deferred — see deferred-work.md).
 */
export const webServerWorktree = {
  async list(projectPath: string): Promise<IpcResult<WorktreeInfo[]>> {
    return postJson<WorktreeInfo[]>('/worktree/list', { projectPath })
  },

  async create(
    params: {
      projectPath: string
      name: string
      branch: string
      isNewBranch: boolean
      startRef?: string
      targetPath?: string
      progressId?: string
    },
    onProgress?: (event: WorktreeProgressEvent) => void
  ): Promise<IpcResult<WorktreeInfo>> {
    if (!onProgress) {
      return postJson<WorktreeInfo>('/worktree/create', params)
    }
    const { progressId, ...rest } = params
    const id = progressId ?? ''
    return postNdjsonStream<WorktreeInfo>(
      '/worktree/create',
      { ...rest, progressId: progressId ?? null, streamProgress: true },
      (frame) => {
        if (frame.type === 'preparing') {
          onProgress({ progressId: id, line: 'preparing' })
        } else if (frame.type === 'progress' && typeof frame.line === 'string') {
          onProgress({ progressId: id, line: frame.line })
        }
      }
    )
  },

  async remove(
    projectPath: string,
    worktreePath: string,
    force: boolean
  ): Promise<IpcResult<void>> {
    return postJson<void>('/worktree/remove', { projectPath, worktreePath, force })
  },

  async branches(projectPath: string): Promise<IpcResult<BranchInfo[]>> {
    const encoded = encodeURIComponent(projectPath)
    return getJson<BranchInfo[]>(`/worktree/branches?projectPath=${encoded}`)
  },

  async checkDirty(worktreePath: string): Promise<IpcResult<DirtyStatus>> {
    const encoded = encodeURIComponent(worktreePath)
    return getJson<DirtyStatus>(`/worktree/check-dirty?worktreePath=${encoded}`)
  },

  async resolveBaseBranch(projectPath: string): Promise<IpcResult<BaseBranchInfo>> {
    return postJson<BaseBranchInfo>('/worktree/resolve-base-branch', { projectPath })
  },

  async copyIncludeFiles(
    projectPath: string,
    worktreePath: string
  ): Promise<IpcResult<IncludeCopyResult>> {
    return postJson<IncludeCopyResult>('/worktree/copy-include-files', {
      projectPath,
      worktreePath
    })
  }
}
/** MCP OAuth web parity — mirrors the desktop Tauri commands. */
export const webServerMcpOAuth = {
  /** Start the OAuth flow; returns the auth URL to redirect the browser to. */
  async start(serverUrl: string): Promise<IpcResult<{ authUrl: string; redirectUri: string }>> {
    return postJson('/mcp-servers/oauth/start', { serverUrl })
  },

  /** Check whether a stored OAuth token exists for a server URL. */
  async status(serverUrl: string): Promise<IpcResult<{ hasToken: boolean }>> {
    return postJson('/mcp-servers/oauth/status', { serverUrl })
  },

  /** Delete the stored OAuth token for a server URL. */
  async disconnect(serverUrl: string): Promise<IpcResult<void>> {
    return postJson('/mcp-servers/oauth/disconnect', { serverUrl })
  }
}
