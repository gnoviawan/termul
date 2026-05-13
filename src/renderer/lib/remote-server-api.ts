import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { IpcResult } from '@shared/types/ipc.types'

export interface RemoteServerStatus {
  isRunning: boolean
  port: number
  pid?: number
  version?: string
}

export const remoteServerApi = {
  async start(port: number, password?: string): Promise<IpcResult<RemoteServerStatus>> {
    return await invoke('remote_server_start', { port, password })
  },
  async stop(): Promise<IpcResult<void>> {
    return await invoke('remote_server_stop')
  },
  async getStatus(): Promise<IpcResult<RemoteServerStatus>> {
    return await invoke('remote_server_get_status')
  },
  async checkInstalled(): Promise<IpcResult<boolean>> {
    return await invoke('remote_server_check_installed')
  },
  onLog(callback: (line: string) => void) {
    return listen<{ line: string }>('remote-server-log', (event) => callback(event.payload.line))
  }
}
