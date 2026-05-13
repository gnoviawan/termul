import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  IpcResult,
  TunnelApi,
  TunnelConfig,
  TunnelLogEvent,
  TunnelSession,
  TunnelStatusEvent
} from '@shared/types/ipc.types'
import { cleanupTauriListener, isTauriContext } from './tauri-runtime'

const IPC_COMMANDS = {
  START: 'tunnel_start',
  STOP: 'tunnel_stop',
  GET_STATUS: 'tunnel_get_status',
  LIST: 'tunnel_list'
} as const

const IPC_EVENTS = {
  STATUS_CHANGED: 'tunnel-status-changed',
  LOG: 'tunnel-log'
} as const

async function invokeIpc<T>(command: string, args?: InvokeArgs): Promise<IpcResult<T>> {
  try {
    return await invoke<IpcResult<T>>(command, args)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), code: 'INVOKE_ERROR' }
  }
}

function createListener<T>(eventName: string, callback: (payload: T) => void): () => void {
  if (!isTauriContext()) return () => {}
  let unlisten: Promise<UnlistenFn> | undefined
  try {
    unlisten = listen<T>(eventName, ({ payload }) => callback(payload))
  } catch {
    return () => {}
  }
  return () => cleanupTauriListener(unlisten)
}

export const tunnelApi: TunnelApi = {
  start(config: TunnelConfig): Promise<IpcResult<TunnelSession>> {
    return invokeIpc<TunnelSession>(IPC_COMMANDS.START, { config })
  },
  stop(tunnelId: string): Promise<IpcResult<void>> {
    return invokeIpc<void>(IPC_COMMANDS.STOP, { tunnelId })
  },
  getStatus(tunnelId: string): Promise<IpcResult<TunnelSession | null>> {
    return invokeIpc<TunnelSession | null>(IPC_COMMANDS.GET_STATUS, { tunnelId })
  },
  list(): Promise<IpcResult<TunnelSession[]>> {
    return invokeIpc<TunnelSession[]>(IPC_COMMANDS.LIST)
  },
  onStatusChanged(callback: (event: TunnelStatusEvent) => void): () => void {
    return createListener<TunnelStatusEvent>(IPC_EVENTS.STATUS_CHANGED, callback)
  },
  onLog(callback: (event: TunnelLogEvent) => void): () => void {
    return createListener<TunnelLogEvent>(IPC_EVENTS.LOG, callback)
  }
}
