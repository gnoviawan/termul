import { invoke } from '@tauri-apps/api/core'

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

export const wsServerApi = {
  async start(port: number, authToken: string, useHttps = false): Promise<{ success: boolean; data?: WsServerStatus; error?: string }> {
    try {
      const data = await invoke<WsServerStatus>('ws_server_start', { port, authToken, useHttps })
      return { success: true, data }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async stop(): Promise<{ success: boolean; error?: string }> {
    try {
      await invoke('ws_server_stop')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async getStatus(): Promise<WsServerStatus> {
    try {
      return await invoke<WsServerStatus>('ws_server_get_status')
    } catch {
      return { isRunning: false, port: 9876, clientCount: 0, httpUrl: '', wsUrl: '', useHttps: false }
    }
  },

  async generateToken(): Promise<string> {
    try {
      return await invoke<string>('ws_server_get_token')
    } catch {
      return ''
    }
  },

  async rotateToken(): Promise<{ success: boolean; token?: string; error?: string }> {
    try {
      const result = await invoke<{ token: string }>('ws_rotate_token')
      return { success: true, token: result.token }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async getAuditLog(): Promise<{ success: boolean; logs?: ConnectionAudit[]; error?: string }> {
    try {
      const logs = await invoke<ConnectionAudit[]>('ws_get_audit_log')
      return { success: true, logs }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async setActiveProject(projectName: string, projectPath: string, defaultShell?: string): Promise<{ success: boolean; error?: string }> {
    try {
      await invoke('ws_server_set_active_project', { projectName, projectPath, defaultShell })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
}
