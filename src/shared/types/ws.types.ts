export interface WsServerStatus {
  isRunning: boolean
  port: number
  clientCount: number
  sessionId: string
  activeProjectId: string | null
  tokenTtlSecs: number
}

export interface WsRequest {
  type: 'request'
  id: string
  method: string
  params?: Record<string, unknown>
}

export interface WsResponse<T = unknown> {
  type: 'response'
  id: string
  success: boolean
  data?: T
  error?: string
  code?: string
}

export interface WsEvent {
  type: 'event'
  event: string
  payload?: Record<string, unknown>
}

export interface WsAuth {
  type: 'auth'
  token: string
  projectId?: string | null
  sessionId?: string | null
}

export type WsInboundMessage = WsRequest | WsAuth
export type WsOutboundMessage = WsResponse | WsEvent

export interface WsAdapterConfig {
  url: string
  authToken: string
  projectId?: string | null
  sessionId?: string | null
  reconnectInterval?: number
  maxReconnectAttempts?: number
}

export interface WsAdapter {
  connect: () => Promise<void>
  disconnect: () => void
  invoke: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  listen: (event: string, callback: (payload: Record<string, unknown>) => void) => () => void
  isConnected: () => boolean
  onDisconnect: (callback: () => void) => () => void
}
