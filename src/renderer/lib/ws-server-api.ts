import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { cleanupTauriListener, isTauriContext } from './tauri-runtime'

export interface WsServerStatus {
  isRunning: boolean
  port: number
  clientCount: number
  httpUrl: string
  wsUrl: string
  useHttps: boolean
}

export interface ConnectionAudit {
  timestamp: string
  remoteAddr: string
  event: string
  authenticated: boolean
  clientId: string | null
}

async function invokeRaw<T>(command: string, args?: Record<string, unknown>): Promise<{ success: boolean; data?: T; error?: string }> {
  try {
    const data = args !== undefined ? await invoke<T>(command, args) : await invoke<T>(command)
    return { success: true, data }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
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

export const wsServerApi = {
  start(port: number, authToken: string, useHttps = false) {
    return invokeRaw<WsServerStatus>('ws_server_start', { port, authToken, useHttps })
  },

  stop() {
    return invokeRaw<void>('ws_server_stop')
  },

  async getStatus(): Promise<WsServerStatus> {
    const result = await invokeRaw<WsServerStatus>('ws_server_get_status')
    return result.data ?? { isRunning: false, port: 9876, clientCount: 0, httpUrl: '', wsUrl: '', useHttps: false }
  },

  async generateToken(): Promise<string> {
    const result = await invokeRaw<string>('ws_server_get_token')
    return result.data ?? ''
  },

  rotateToken() {
    return invokeRaw<{ token: string }>('ws_rotate_token')
  },

  getAuditLog() {
    return invokeRaw<ConnectionAudit[]>('ws_get_audit_log')
  },

  setActiveProject(projectName: string, projectPath: string, defaultShell?: string, color?: string) {
    return invokeRaw<void>('ws_server_set_active_project', { projectName, projectPath, defaultShell, color })
  },

  setProjects(projects: Array<Record<string, unknown>>, activeProjectId?: string) {
    return invokeRaw<void>('ws_server_set_projects', { projects, activeProjectId })
  },

  onStatusChanged(callback: (status: WsServerStatus) => void): () => void {
    return createListener<WsServerStatus>('ws-server-status-changed', callback)
  }
}
