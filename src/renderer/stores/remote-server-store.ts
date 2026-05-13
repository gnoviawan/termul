import { create } from 'zustand'
import { remoteServerApi, type RemoteServerStatus } from '@/lib/remote-server-api'

interface RemoteServerState {
  status: RemoteServerStatus | null
  isLoading: boolean
  isInstalled: boolean | null
  logs: string[]
  error: string | null
  
  checkInstalled: () => Promise<void>
  refreshStatus: () => Promise<void>
  startServer: (port: number, password?: string) => Promise<{ success: boolean; data?: RemoteServerStatus; error?: string }>
  stopServer: () => Promise<{ success: boolean; data?: void; error?: string }>
  appendLog: (line: string) => void
}

export const useRemoteServerStore = create<RemoteServerState>((set, get) => ({
  status: null,
  isLoading: false,
  isInstalled: null,
  logs: [],
  error: null,

  checkInstalled: async () => {
    const result = await remoteServerApi.checkInstalled()
    if (result.success) set({ isInstalled: result.data })
  },

  refreshStatus: async () => {
    const result = await remoteServerApi.getStatus()
    if (result.success) set({ status: result.data })
  },

  startServer: async (port: number, password?: string) => {
    set({ isLoading: true, error: null })
    const result = await remoteServerApi.start(port, password)
    set({ isLoading: false })
    if (result.success) {
      set({ status: result.data })
    } else {
      set({ error: result.error })
    }
    return result
  },

  stopServer: async () => {
    set({ isLoading: true })
    const result = await remoteServerApi.stop()
    set({ isLoading: false })
    if (result.success) {
      set({ status: { isRunning: false, port: get().status?.port || 8080 } })
    }
    return result
  },

  appendLog: (line: string) => set((state) => ({
    logs: [...state.logs, line].slice(-200)
  }))
}))
