import type {
  IpcResult,
  RemoteBindMode,
  RemoteServerApi,
  RemoteStatus
} from '@shared/types/ipc.types'
import type { ProjectSummary } from '@shared/types/web-projects.types'
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
 */
export async function syncProjects(
  projects: ProjectSummary[],
  activeProjectId: string | null
): Promise<IpcResult<void>> {
  return invokeIpc<void>('remote_sync_projects', {
    payload: { projects, activeProjectId }
  })
}
