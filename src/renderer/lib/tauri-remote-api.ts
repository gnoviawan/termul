import type {
  IpcResult,
  RemoteBindMode,
  RemoteServerApi,
  RemoteStatus
} from '@shared/types/ipc.types'
import type { ProjectSummary } from '@shared/types/web-projects.types'
import type { PersistedSessionSummary } from '@shared/types/web-protocol.types'
import { type InvokeArgs, invoke } from '@tauri-apps/api/core'

/**
 * Tauri IPC adapter for the desktop-hosted shared-live web server.
 *
 * The Rust commands (`remote_server_start` / `_stop` / `_status` in
 * `src-tauri/src/commands.rs`) already wrap their results in `IpcResult`, so
 * this adapter must NOT wrap them again — it just forwards the typed result.
 *
 * The server shares the desktop's live ACP agent sessions with a browser/phone
 * over the LAN; the phone connects directly to a session via the WS URL. Auth /
 * token-gating land in Epic 2.
 */

const IPC_COMMANDS = {
  START: 'remote_server_start',
  STOP: 'remote_server_stop',
  STATUS: 'remote_server_status'
} as const

/**
 * Invoke a Tauri command that already returns `IpcResult<T>` from Rust.
 * Wraps only transport-level failures (invoke throwing) into an IpcResult.
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

export const remoteServerApi: RemoteServerApi = {
  /** Start the embedded server on the chosen bind mode (OS-assigned port). */
  async start(options?: { bindMode?: RemoteBindMode }): Promise<IpcResult<RemoteStatus>> {
    const bindMode = options?.bindMode
    return invokeIpc<RemoteStatus>(IPC_COMMANDS.START, bindMode ? { bindMode } : undefined)
  },

  /** Stop the embedded server and disconnect all web clients. */
  async stop(): Promise<IpcResult<RemoteStatus>> {
    return invokeIpc<RemoteStatus>(IPC_COMMANDS.STOP)
  },

  /** Query whether the server is running and its current url/port. */
  async status(): Promise<IpcResult<RemoteStatus>> {
    return invokeIpc<RemoteStatus>(IPC_COMMANDS.STATUS)
  }
}

/**
 * Push the desktop renderer's current project list into the in-memory
 * `ProjectRegistry` (Epic-4 bridge) so the web/remote client can read it via
 * `GET /projects`. No env-var values cross the wire — `ProjectSummary` redacts
 * by omission. Call on server-start success + on every project-store mutation
 * while the server runs (a no-op when the server is stopped just returns ok).
 *
 * In desktop-hosted mode the desktop's `activeProjectId` IS the host default
 * (the desktop user is the host operator), so it is pushed as
 * `defaultProjectId`. The web client seeds its initial `activeProjectId` from
 * it on the first `GET /projects` but preserves its own selection on
 * subsequent refetches.
 */
export async function syncProjects(
  projects: ProjectSummary[],
  defaultProjectId: string | null
): Promise<IpcResult<void>> {
  return invokeIpc<void>('remote_sync_projects', {
    payload: { projects, defaultProjectId }
  })
}

/**
 * Explicitly set the host's default project (Epic 7 — cross-client workspace
 * continuity). Distinct from a per-connection `switch_project`: this changes
 * the host default that new web clients start with. Validates the project is
 * switchable, updates `registry.set_default_project`, and broadcasts
 * `projects_changed` to all connected web clients. Mirrors the
 * `set_default_project` WS request + the `POST /projects/default` HTTP route
 * (transport parity). Lets the desktop set a default DIFFERENT from its own
 * active project (the desktop's active IS pushed as the default via
 * `syncProjects`, but this command is the explicit override).
 */
export async function setHostDefaultProject(projectId: string): Promise<IpcResult<void>> {
  return invokeIpc<void>('set_host_default_project', { projectId })
}

/**
 * Push the desktop renderer's chat-history index + payloads into the in-memory
 * `ChatHistoryCache` (Epic-4 bridge) so the web/remote client can read them via
 * `list_persisted_sessions` + `get_session_payload`. No secrets, permission
 * tickets, or auth data cross the wire. Call on server-start success + on every
 * session-index/payload mutation while the server runs (a no-op when the
 * server is stopped just returns ok).
 *
 * `index` is optional: the `useAcpHistorySync` hook owns the index push (it
 * reacts to every `sessionIndex` change); `persistSession` pushes ONLY its
 * payload (index omitted) so the index reaches the server exactly once per
 * mutation, not twice. When provided, `index` is the wire
 * `PersistedSessionSummary[]` shape (convert the renderer's
 * `SessionIndexEntry[]` via `toPersistedSessionSummaries` before pushing).
 * `payloads` is optional — push lazily (only sessions the renderer has in
 * memory); omitted on an index-only sync.
 */
export async function syncChatHistory(
  index?: PersistedSessionSummary[],
  payloads?: Record<string, unknown>,
  revision?: number
): Promise<IpcResult<void>> {
  return invokeIpc<void>('remote_sync_chat_history', {
    payload: {
      index: index ?? null,
      payloads: payloads ?? null,
      revision: revision ?? null
    }
  })
}
