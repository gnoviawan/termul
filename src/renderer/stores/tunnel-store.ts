import { create } from 'zustand'
import type { TunnelConfig, TunnelSession, TunnelStatus } from '@shared/types/ipc.types'
import { tunnelApi } from '@/lib/api'

export interface TunnelLogEntry {
  tunnelId: string
  line: string
  timestamp: number
}

export interface TunnelState {
  configs: TunnelConfig[]
  sessions: TunnelSession[]
  logs: TunnelLogEntry[]
  activeTunnelId: string
  isLoading: boolean
  error: string | null
  addConfig: (config: TunnelConfig) => void
  removeConfig: (id: string) => void
  setActiveTunnelId: (id: string) => void
  setSessions: (sessions: TunnelSession[]) => void
  upsertSession: (session: TunnelSession) => void
  appendLog: (tunnelId: string, line: string) => void
  clearLogs: (tunnelId?: string) => void
  updateStatus: (tunnelId: string, status: TunnelStatus, publicUrl?: string | null, lastError?: string | null) => void
  setError: (error: string | null) => void
  setLoading: (loading: boolean) => void
  refreshSessions: () => Promise<void>
  startTunnel: (config: TunnelConfig) => Promise<TunnelSession | null>
  stopTunnel: (tunnelId: string) => Promise<boolean>
}

export const useTunnelStore = create<TunnelState>((set, get) => ({
  configs: [],
  sessions: [],
  logs: [],
  activeTunnelId: '',
  isLoading: false,
  error: null,
  addConfig: (config) => set((state) => ({ configs: [...state.configs, config] })),
  removeConfig: (id) => set((state) => ({ configs: state.configs.filter((config) => config.id !== id) })),
  setActiveTunnelId: (id) => set({ activeTunnelId: id }),
  setSessions: (sessions) => set({ sessions }),
  upsertSession: (session) => set((state) => {
    const existing = state.sessions.findIndex((item) => item.id === session.id)
    const sessions = [...state.sessions]
    if (existing >= 0) {
      sessions[existing] = {
        ...sessions[existing],
        ...session,
        publicUrl: session.publicUrl ?? sessions[existing].publicUrl,
        lastError: session.lastError ?? sessions[existing].lastError,
      }
    } else sessions.unshift(session)
    return { sessions }
  }),
  appendLog: (tunnelId, line) => set((state) => ({
    logs: [{ tunnelId, line, timestamp: Date.now() }, ...state.logs].slice(0, 500)
  })),
  clearLogs: (tunnelId) => set((state) => ({
    logs: tunnelId ? state.logs.filter((log) => log.tunnelId !== tunnelId) : []
  })),
  updateStatus: (tunnelId, status, publicUrl, lastError) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === tunnelId ? { ...session, status, publicUrl: publicUrl ?? session.publicUrl, lastError: lastError ?? session.lastError } : session)
  })),
  setError: (error) => set({ error }),
  setLoading: (isLoading) => set({ isLoading }),
  refreshSessions: async () => {
    try {
      const result = await tunnelApi.list()
      if (result && result.success) set({ sessions: result.data, error: null })
      else if (result) set({ error: result.error })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },
  startTunnel: async (config) => {
    set({ isLoading: true, error: null })
    const result = await tunnelApi.start(config)
    set({ isLoading: false })
    if (!result.success) {
      set({ error: result.error })
      if (result.code === 'TUNNEL_ALREADY_RUNNING') {
        // Force update status biar UI tahu tunnel running dan bisa di-stop
        get().upsertSession({
          id: config.id,
          configId: config.id,
          status: 'running',
          publicUrl: null,
          lastError: null
        })
      }
      return null
    }
    get().upsertSession(result.data)
    set({ activeTunnelId: result.data.id })
    return result.data
  },
  stopTunnel: async (tunnelId) => {
    set({ isLoading: true, error: null })
    const result = await tunnelApi.stop(tunnelId)
    set({ isLoading: false })
    if (!result.success) {
      set({ error: result.error })
      return false
    }
    get().updateStatus(tunnelId, 'stopped')
    return true
  }
}))
