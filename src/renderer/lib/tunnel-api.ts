import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  IpcResult,
  TunnelApi,
  TunnelConfig,
  TunnelLogEvent,
  TunnelSession,
  TunnelStatusEvent
} from '@shared/types/ipc.types'
import { cleanupTauriListener, isTauriContext } from './tauri-runtime'

const CMD = {
  START: 'tunnel_start',
  STOP: 'tunnel_stop',
  GET_STATUS: 'tunnel_get_status',
  LIST: 'tunnel_list'
} as const

const EVT = {
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
  let unlisten: Promise<() => void> | undefined
  try {
    unlisten = listen<T>(eventName, ({ payload }) => callback(payload))
  } catch {
    return () => {}
  }
  return () => cleanupTauriListener(unlisten)
}

export const tauriTunnelApi: TunnelApi = {
  start(config: TunnelConfig): Promise<IpcResult<TunnelSession>> {
    return invokeIpc<TunnelSession>(CMD.START, { config })
  },
  stop(tunnelId: string): Promise<IpcResult<void>> {
    return invokeIpc<void>(CMD.STOP, { tunnelId })
  },
  getStatus(tunnelId: string): Promise<IpcResult<TunnelSession | null>> {
    return invokeIpc<TunnelSession | null>(CMD.GET_STATUS, { tunnelId })
  },
  list(): Promise<IpcResult<TunnelSession[]>> {
    return invokeIpc<TunnelSession[]>(CMD.LIST)
  },
  onStatusChanged(callback: (event: TunnelStatusEvent) => void): () => void {
    return createListener<TunnelStatusEvent>(EVT.STATUS_CHANGED, callback)
  },
  onLog(callback: (event: TunnelLogEvent) => void): () => void {
    return createListener<TunnelLogEvent>(EVT.LOG, callback)
  }
}
