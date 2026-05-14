import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type {
  SSHProfile,
  SSHConnection,
  SSHConnectionStatus,
  ActivePortForward,
  SFTPTransferProgress,
  PortForwardConfig,
} from '@shared/types/ssh.types'
import { sshApi } from '@/lib/api'

export interface SSHState {
  // State
  profiles: SSHProfile[]
  connections: SSHConnection[]
  transfers: SFTPTransferProgress[]
  isLoaded: boolean
  activeProfileId: string | null

  // Profile actions
  loadProfiles: () => Promise<void>
  saveProfile: (profile: SSHProfile) => Promise<boolean>
  deleteProfile: (profileId: string) => Promise<boolean>
  importConfig: () => Promise<SSHProfile[]>

  // Connection actions
  connect: (profileId: string, password?: string) => Promise<SSHConnection | null>
  disconnect: (connectionId: string) => Promise<boolean>
  updateConnectionStatus: (connectionId: string, status: SSHConnectionStatus, error?: string) => void

  // Selection
  selectProfile: (profileId: string | null) => void

  // Persisted editor state (survives workspace switch)
  editingFile: { path: string; name: string; content: string; originalContent: string } | null
  editingContent: string
  setEditingFile: (file: { path: string; name: string; content: string; originalContent: string } | null) => void
  setEditingContent: (content: string) => void

  // Manual connection tracking (for terminal-based SSH)
  markConnected: (profileId: string, terminalId: string) => void
  markDisconnected: (profileId: string) => void
  updateConnectionId: (profileId: string, backendConnectionId: string) => void

  // Port forward actions
  startPortForward: (connectionId: string, config: PortForwardConfig) => Promise<boolean>
  stopPortForward: (connectionId: string, forwardId: string) => Promise<boolean>
  updatePortForwardStatus: (connectionId: string, forward: ActivePortForward) => void

  // Transfer tracking
  updateTransferProgress: (progress: SFTPTransferProgress) => void
  clearCompletedTransfers: () => void
}

export const useSSHStore = create<SSHState>((set, get) => ({
  profiles: [],
  connections: [],
  transfers: [],
  isLoaded: false,
  activeProfileId: null,
  editingFile: null,
  editingContent: '',

  loadProfiles: async () => {
    const result = await sshApi.listProfiles()
    if (result.success) {
      set({ profiles: result.data, isLoaded: true })
    }
  },

  saveProfile: async (profile: SSHProfile) => {
    const result = await sshApi.saveProfile(profile)
    if (result.success) {
      set((state) => {
        const existing = state.profiles.findIndex((p) => p.id === profile.id)
        const profiles =
          existing >= 0
            ? state.profiles.map((p) => (p.id === profile.id ? profile : p))
            : [...state.profiles, profile]
        return { profiles }
      })
      return true
    }
    return false
  },

  deleteProfile: async (profileId: string) => {
    const result = await sshApi.deleteProfile(profileId)
    if (result.success) {
      set((state) => ({
        profiles: state.profiles.filter((p) => p.id !== profileId),
      }))
      return true
    }
    return false
  },

  importConfig: async () => {
    const result = await sshApi.importConfig()
    if (result.success && result.data.length > 0) {
      set((state) => ({
        profiles: [...state.profiles, ...result.data],
      }))
      return result.data
    }
    return []
  },

  connect: async (profileId: string, password?: string) => {
    const result = await sshApi.connect(profileId, password)
    if (result.success) {
      const connection: SSHConnection = {
        id: result.data.id,
        profileId: result.data.profileId,
        status: result.data.status as SSHConnectionStatus,
        terminalId: result.data.terminalId,
        activeForwards: [],
        error: result.data.error,
        reconnectAttempts: result.data.reconnectAttempts,
        connectedAt: result.data.connectedAt,
      }
      set((state) => ({
        connections: [...state.connections, connection],
      }))
      return connection
    }
    return null
  },

  disconnect: async (connectionId: string) => {
    const result = await sshApi.disconnect(connectionId)
    if (result.success) {
      set((state) => ({
        connections: state.connections.filter((c) => c.id !== connectionId),
      }))
      return true
    }
    return false
  },

  updateConnectionStatus: (connectionId: string, status: SSHConnectionStatus, error?: string) => {
    set((state) => ({
      connections: state.connections.map((c) =>
        c.id === connectionId ? { ...c, status, error } : c
      ),
    }))
  },

  selectProfile: (profileId: string | null) => {
    set({ activeProfileId: profileId })
  },

  setEditingFile: (file) => set({ editingFile: file }),
  setEditingContent: (content) => set({ editingContent: content }),

  markConnected: (profileId: string, terminalId: string) => {
    set((state) => {
      // Remove any existing connection for this profile
      const filtered = state.connections.filter((c) => c.profileId !== profileId)
      const newConn: SSHConnection = {
        id: `ssh-conn-${Date.now()}`,
        profileId,
        status: 'connected',
        terminalId,
        activeForwards: [],
        reconnectAttempts: 0,
        connectedAt: new Date().toISOString(),
      }
      return { connections: [...filtered, newConn] }
    })
  },

  markDisconnected: (profileId: string) => {
    set((state) => ({
      connections: state.connections.filter((c) => c.profileId !== profileId),
    }))
  },

  updateConnectionId: (profileId: string, backendConnectionId: string) => {
    set((state) => ({
      connections: state.connections.map((c) =>
        c.profileId === profileId ? { ...c, id: backendConnectionId } : c
      ),
    }))
  },

  startPortForward: async (connectionId: string, config: PortForwardConfig) => {
    const result = await sshApi.startPortForward(connectionId, config)
    if (result.success) {
      set((state) => ({
        connections: state.connections.map((c) =>
          c.id === connectionId
            ? { ...c, activeForwards: [...c.activeForwards, result.data] }
            : c
        ),
      }))
      return true
    }
    return false
  },

  stopPortForward: async (connectionId: string, forwardId: string) => {
    const result = await sshApi.stopPortForward(connectionId, forwardId)
    if (result.success) {
      set((state) => ({
        connections: state.connections.map((c) =>
          c.id === connectionId
            ? { ...c, activeForwards: c.activeForwards.filter((f) => f.id !== forwardId) }
            : c
        ),
      }))
      return true
    }
    return false
  },

  updatePortForwardStatus: (connectionId: string, forward: ActivePortForward) => {
    set((state) => ({
      connections: state.connections.map((c) =>
        c.id === connectionId
          ? {
              ...c,
              activeForwards: c.activeForwards.map((f) =>
                f.id === forward.id ? forward : f
              ),
            }
          : c
      ),
    }))
  },

  updateTransferProgress: (progress: SFTPTransferProgress) => {
    set((state) => {
      const existing = state.transfers.findIndex(
        (t) =>
          t.connectionId === progress.connectionId &&
          t.remotePath === progress.remotePath &&
          t.direction === progress.direction
      )
      if (existing >= 0) {
        const transfers = [...state.transfers]
        transfers[existing] = progress
        return { transfers }
      }
      return { transfers: [...state.transfers, progress] }
    })
  },

  clearCompletedTransfers: () => {
    set((state) => ({
      transfers: state.transfers.filter(
        (t) => t.status === 'in-progress'
      ),
    }))
  },
}))

// Selectors
export const useSSHProfiles = () => useSSHStore((state) => state.profiles)
export const useSSHConnections = () => useSSHStore((state) => state.connections)
export const useSSHTransfers = () => useSSHStore((state) => state.transfers)
export const useSSHLoaded = () => useSSHStore((state) => state.isLoaded)
export const useActiveSSHProfileId = () => useSSHStore((state) => state.activeProfileId)
export const useActiveSSHProfile = () => useSSHStore((state) => 
  state.activeProfileId ? state.profiles.find((p) => p.id === state.activeProfileId) ?? null : null
)
export const useSSHEditorFile = () => useSSHStore((state) => state.editingFile)
export const useSSHEditorContent = () => useSSHStore((state) => state.editingContent)

export const useSSHActions = () =>
  useSSHStore(
    useShallow((state) => ({
      loadProfiles: state.loadProfiles,
      saveProfile: state.saveProfile,
      deleteProfile: state.deleteProfile,
      importConfig: state.importConfig,
      connect: state.connect,
      disconnect: state.disconnect,
      startPortForward: state.startPortForward,
      stopPortForward: state.stopPortForward,
      clearCompletedTransfers: state.clearCompletedTransfers,
      selectProfile: state.selectProfile,
      markConnected: state.markConnected,
      markDisconnected: state.markDisconnected,
      updateConnectionId: state.updateConnectionId,
      setEditingFile: state.setEditingFile,
      setEditingContent: state.setEditingContent,
    }))
  )

export const useConnectionForProfile = (profileId: string) =>
  useSSHStore((state) => state.connections.find((c) => c.profileId === profileId))
