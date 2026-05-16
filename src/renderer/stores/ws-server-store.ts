import { create } from 'zustand'
import { wsServerApi, type WsServerStatus } from '@/lib/ws-server-api'

interface WsServerState {
  status: WsServerStatus
  isLoading: boolean
  error: string | null
  authToken: string | null
  tokenExpiry: number | null

  startServer: (port: number, authToken: string, useHttps?: boolean) => Promise<{ success: boolean; data?: WsServerStatus; error?: string }>
  stopServer: () => Promise<{ success: boolean; error?: string }>
  refreshStatus: () => Promise<void>
  generateToken: () => Promise<string>
  rotateToken: () => Promise<{ success: boolean; token?: string; error?: string }>
  setAuthToken: (token: string, expirySecs?: number) => void
}

export const useWsServerStore = create<WsServerState>((set, get) => ({
  status: { isRunning: false, port: 9876, clientCount: 0, httpUrl: '', wsUrl: '', useHttps: false },
  isLoading: false,
  error: null,
  authToken: null,
  tokenExpiry: null,

  startServer: async (port, authToken, useHttps = false) => {
    set({ isLoading: true, error: null })
    const result = await wsServerApi.start(port, authToken, useHttps)
    set({ isLoading: false, authToken, tokenExpiry: Date.now() / 1000 + 3600 })
    if (result.success && result.data) {
      set({ status: result.data })
    } else {
      set({ error: result.error || 'Failed to start server' })
    }
    return result
  },

  stopServer: async () => {
    set({ isLoading: true })
    const result = await wsServerApi.stop()
    set({ isLoading: false })
    if (result.success) {
      set((state) => ({ status: { ...state.status, isRunning: false, clientCount: 0 } }))
    }
    return result
  },

  refreshStatus: async () => {
    const status = await wsServerApi.getStatus()
    set({ status })
  },

  generateToken: async () => {
    const token = await wsServerApi.generateToken()
    set({ authToken: token, tokenExpiry: Date.now() / 1000 + 3600 })
    return token
  },

  rotateToken: async () => {
    const result = await wsServerApi.rotateToken()
    if (result.success && result.token) {
      set({ authToken: result.token, tokenExpiry: Date.now() / 1000 + 3600 })
    }
    return result
  },

  setAuthToken: (token, expirySecs = 3600) => set({ authToken: token, tokenExpiry: Date.now() / 1000 + expirySecs }),
}))
