import type {
  IpcResult,
  RemoteBindMode,
  RemoteServerApi,
  RemoteStatus
} from '@shared/types/ipc.types'
import type { ProjectSummary } from '@shared/types/web-projects.types'
import type { PersistedSessionSummary } from '@shared/types/web-protocol.types'
import type { StoredMcpServer } from './acp-mcp-persistence'
import { invokeIpc } from './ipc/tauri'

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
 * One-shot import of the desktop renderer's old project list into the host's
 * durable registry (`project_registry_import`). The host accepts it only while
 * its registry file says nothing was imported: unknown ids are added, existing
 * ones are kept, the default applies only when none is set, and a repeat is an
 * ok no-op (`imported: false`). Either reply is an acknowledgement; the caller
 * deletes the old `projects` key only after one. No env-var values cross the
 * wire — `ProjectSummary` redacts by omission.
 */
export async function projectRegistryImport(
  projects: ProjectSummary[],
  defaultProjectId: string | null
): Promise<IpcResult<{ imported: boolean }>> {
  return invokeIpc<{ imported: boolean }>('project_registry_import', {
    payload: { projects, defaultProjectId }
  })
}

/**
 * Mirror the desktop app-store MCP registry to the named project's
 * `.termul/mcp-servers.json` (CAP-7 — registry sync gap). The Rust
 * `remote_sync_mcp_registry` command resolves `projectId` through the shared
 * `ProjectRegistry` (an unknown, archived or pathless project is refused
 * `NOT_FOUND`) and writes the registry via `atomic_file::replace`, so the web
 * `GET /mcp-servers?projectId=` route (file-based) serves the same registry the
 * desktop app store holds.
 *
 * Best-effort: the result is `IpcResult<void>` (never throws — invoke errors map
 * to `{ success: false, code: 'INVOKE_ERROR' }`). Callers log a failure but never
 * let it block the app-store save or the project switch.
 */
export async function syncMcpRegistryToProject(
  projectId: string,
  registry: StoredMcpServer[]
): Promise<IpcResult<void>> {
  return invokeIpc<void>('remote_sync_mcp_registry', { projectId, registry })
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
