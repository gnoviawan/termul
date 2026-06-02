import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import type {
  IpcResult,
  RemoteBindMode,
  RemoteProjectTree,
  RemoteServerApi,
  RemoteStatus
} from '@shared/types/ipc.types'

/**
 * Tauri IPC adapter for the embedded remote terminal server.
 *
 * The Rust commands (`remote_server_start` / `_stop` / `_status` /
 * `remote_publish_projects` in `src-tauri/src/commands.rs`) already wrap their
 * results in `IpcResult`, so this adapter must NOT wrap them again — it just
 * forwards the typed result.
 *
 * Access model: the server is reachable by `ip:port` with no token. CSWSH is
 * prevented server-side by same-origin validation on the WebSocket upgrade.
 */

const IPC_COMMANDS = {
  START: 'remote_server_start',
  STOP: 'remote_server_stop',
  STATUS: 'remote_server_status',
  PUBLISH_PROJECTS: 'remote_publish_projects'
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
  /** Start the embedded server on the chosen bind mode (auto-port). */
  async start(options?: { bindMode?: RemoteBindMode }): Promise<IpcResult<RemoteStatus>> {
    const bindMode = options?.bindMode
    return invokeIpc<RemoteStatus>(
      IPC_COMMANDS.START,
      bindMode ? { bindMode } : undefined
    )
  },

  /** Stop the embedded server and disconnect all web clients. */
  async stop(): Promise<IpcResult<RemoteStatus>> {
    return invokeIpc<RemoteStatus>(IPC_COMMANDS.STOP)
  },

  /** Query whether the server is running and its current url/port. */
  async status(): Promise<IpcResult<RemoteStatus>> {
    return invokeIpc<RemoteStatus>(IPC_COMMANDS.STATUS)
  },

  /** Publish the current project → terminal tree for the web client to browse. */
  async publishProjects(tree: RemoteProjectTree): Promise<IpcResult<void>> {
    return invokeIpc<void>(IPC_COMMANDS.PUBLISH_PROJECTS, { tree })
  }
}
