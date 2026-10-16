import { PersistenceKeys } from '@shared/types/persistence.types'
import type {
  SFTPTransferProgress,
  SSHHostKeyPrompt,
  SSHProfile,
  SSHSessionEndReason,
  SSHSessionStage
} from '@shared/types/ssh.types'
import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import { sshApi } from '@/lib/api'
import { syncSharedKey } from '@/lib/shared-key-sync'
import { isTauriContext } from '@/lib/tauri-runtime'

/** The Hosts tab of the SSH workspace; every other tab is a session id. */
export const SSH_HOSTS_TAB = 'hosts'

/**
 * Session tab state. `awaitingInput` means the connect is paused on the user
 * (host key or credential prompt).
 */
export type SSHSessionStatus =
  | 'connecting'
  | 'awaitingInput'
  | 'connected'
  | 'disconnected'
  | 'failed'

export interface SSHSessionError {
  /** Backend error code, e.g. `SSH_AUTH_FAILED` */
  code: string
  /** Technical detail for diagnosis (never contains a secret) */
  detail: string
}

export interface SSHCredentialPrompt {
  kind: 'password' | 'passphrase'
  /** `required`: none was available. `rejected`: the one tried did not work. */
  reason: 'required' | 'rejected'
}

export interface SSHSessionEnd {
  reason: SSHSessionEndReason
  exitCode: number | null
  detail: string | null
}

/** One session tab. A reconnect reuses the tab with a new `attemptId`. */
export interface SSHSession {
  id: string
  /** Backend session id of the current connect attempt */
  attemptId: string
  profileId: string
  status: SSHSessionStatus
  stage: SSHSessionStage | null
  hostKeyPrompt: SSHHostKeyPrompt | null
  credentialPrompt: SSHCredentialPrompt | null
  error: SSHSessionError | null
  ended: SSHSessionEnd | null
  /** Backend terminal id of the remote shell */
  ptyId: string | null
  /** Attach credential for `ptyId` (in memory only) */
  claim: string | null
  /** The renderer is attached to `ptyId`'s output stream */
  attached: boolean
  connectedAt: string | null
}

/** A remote file open in the editor, bound to the session it came from. */
export interface SSHEditingFile {
  /** Backend id of the session the file was read from */
  connectionId: string
  path: string
  name: string
  content: string
  originalContent: string
}

export interface SSHState {
  // Profiles
  profiles: SSHProfile[]
  isLoaded: boolean
  loadProfiles: () => Promise<void>
  saveProfile: (profile: SSHProfile) => Promise<boolean>
  deleteProfile: (profileId: string) => Promise<boolean>
  duplicateProfile: (profileId: string) => Promise<SSHProfile | null>
  toggleFavorite: (profileId: string) => Promise<boolean>
  importConfig: () => Promise<SSHProfile[]>

  // Workspace: open/closed, active tab, highlighted host
  workspaceOpen: boolean
  activeTab: string
  selectedProfileId: string | null
  /**
   * Open the SSH workspace focused on a host (its latest session, else the
   * Hosts tab with the host selected). `null` closes the workspace.
   */
  selectProfile: (profileId: string | null) => void
  /** user@host:port in host lists; hidden by default (privacy, screen sharing). */
  showAddresses: boolean
  toggleShowAddresses: () => void
  openWorkspace: () => void
  setActiveTab: (tab: string) => void

  // Session tabs
  sessions: SSHSession[]
  /** A live session waiting for "Close session?" confirmation. */
  pendingClose: string | null
  setPendingClose: (sessionId: string | null) => void
  addSession: (session: SSHSession) => void
  patchSession: (id: string, patch: Partial<SSHSession>) => void
  removeSession: (id: string) => void

  // File transfers
  transfers: SFTPTransferProgress[]

  // Remote file editor (survives workspace switch)
  editingFile: SSHEditingFile | null
  editingContent: string
  setEditingFile: (file: SSHEditingFile | null) => void
  setEditingContent: (content: string) => void

  // Transfers
  updateTransferProgress: (progress: SFTPTransferProgress) => void
  /** Drop finished transfers; only those of `connectionId` when given. */
  clearCompletedTransfers: (connectionId?: string) => void
}

/** Renderer state never holds secrets. */
function withoutSecrets(profile: SSHProfile): SSHProfile {
  return { ...profile, password: undefined, passphrase: undefined }
}

let profileSyncStarted = false

/** Show profiles another device or tab saved (web client); started once, after the first load. */
function startProfileSync(setProfiles: (profiles: SSHProfile[]) => void): void {
  if (profileSyncStarted) return
  profileSyncStarted = true
  syncSharedKey<SSHProfile[]>(PersistenceKeys.sshProfiles, (change) => {
    if (!change.exists) setProfiles([])
    else if (Array.isArray(change.data)) setProfiles(change.data.map(withoutSecrets))
  })
}

export const useSSHStore = create<SSHState>((set, get) => ({
  profiles: [],
  isLoaded: false,
  workspaceOpen: false,
  activeTab: SSH_HOSTS_TAB,
  selectedProfileId: null,
  showAddresses: false,
  sessions: [],
  pendingClose: null,
  transfers: [],
  editingFile: null,
  editingContent: '',

  loadProfiles: async () => {
    try {
      const result = await sshApi.listProfiles()
      if (result?.success) {
        set({ profiles: result.data.map(withoutSecrets), isLoaded: true })
      } else {
        set({ isLoaded: true })
      }
    } catch {
      set({ isLoaded: true })
    }
    startProfileSync((profiles) => set({ profiles }))
  },

  saveProfile: async (profile: SSHProfile) => {
    const result = await sshApi.saveProfile(profile)
    if (!result.success) return false
    // Mirror the backend flags so the editor shows "saved in keychain"
    // without a reload. Only the desktop has a keychain: the web client
    // stores profiles without secrets, so it never reports one as saved.
    const keychain = isTauriContext()
    const sanitized = withoutSecrets({
      ...profile,
      hasStoredPassword:
        keychain &&
        profile.authMethod === 'password' &&
        (Boolean(profile.password) || Boolean(profile.hasStoredPassword)),
      hasStoredPassphrase:
        keychain &&
        profile.authMethod === 'key' &&
        (Boolean(profile.passphrase) || Boolean(profile.hasStoredPassphrase))
    })
    set((state) => {
      const exists = state.profiles.some((p) => p.id === profile.id)
      return {
        profiles: exists
          ? state.profiles.map((p) => (p.id === profile.id ? sanitized : p))
          : [...state.profiles, sanitized]
      }
    })
    return true
  },

  deleteProfile: async (profileId: string) => {
    const result = await sshApi.deleteProfile(profileId)
    if (!result.success) return false
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== profileId),
      selectedProfileId: state.selectedProfileId === profileId ? null : state.selectedProfileId
    }))
    return true
  },

  duplicateProfile: async (profileId: string) => {
    const result = await sshApi.duplicateProfile(profileId)
    if (!result.success) return null
    const copy = withoutSecrets(result.data)
    set((state) => ({ profiles: [...state.profiles, copy], selectedProfileId: copy.id }))
    return copy
  },

  toggleFavorite: async (profileId: string) => {
    const profile = get().profiles.find((p) => p.id === profileId)
    if (!profile) return false
    return get().saveProfile({ ...profile, favorite: !profile.favorite })
  },

  importConfig: async () => {
    const result = await sshApi.importConfig()
    if (result.success && result.data.length > 0) {
      set((state) => {
        const byId = new Map(state.profiles.map((profile) => [profile.id, profile]))
        for (const profile of result.data) byId.set(profile.id, withoutSecrets(profile))
        return { profiles: Array.from(byId.values()) }
      })
      return result.data
    }
    return []
  },

  selectProfile: (profileId: string | null) => {
    if (profileId === null) {
      set({ workspaceOpen: false })
      return
    }
    const sessions = get().sessions.filter((s) => s.profileId === profileId)
    const latest = sessions[sessions.length - 1]
    set({
      workspaceOpen: true,
      selectedProfileId: profileId,
      activeTab: latest ? latest.id : SSH_HOSTS_TAB
    })
  },

  openWorkspace: () => set({ workspaceOpen: true }),

  setActiveTab: (tab: string) => {
    const session = get().sessions.find((s) => s.id === tab)
    set({
      workspaceOpen: true,
      activeTab: session || tab === SSH_HOSTS_TAB ? tab : SSH_HOSTS_TAB,
      ...(session ? { selectedProfileId: session.profileId } : {})
    })
  },

  setPendingClose: (sessionId: string | null) => set({ pendingClose: sessionId }),

  addSession: (session: SSHSession) => {
    set((state) => ({ sessions: [...state.sessions, session] }))
  },

  patchSession: (id: string, patch: Partial<SSHSession>) => {
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s))
    }))
  },

  removeSession: (id: string) => {
    set((state) => {
      const index = state.sessions.findIndex((s) => s.id === id)
      if (index < 0) return {}
      const sessions = state.sessions.filter((s) => s.id !== id)
      if (state.activeTab !== id) return { sessions }
      // Focus the neighbour tab, like closing a browser tab.
      const next = sessions[index] ?? sessions[index - 1]
      return { sessions, activeTab: next ? next.id : SSH_HOSTS_TAB }
    })
  },

  setEditingFile: (file) => set({ editingFile: file }),
  setEditingContent: (content) => set({ editingContent: content }),
  toggleShowAddresses: () => set((state) => ({ showAddresses: !state.showAddresses })),

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

  clearCompletedTransfers: (connectionId) => {
    set((state) => ({
      transfers: state.transfers.filter(
        (t) =>
          t.status === 'in-progress' ||
          (connectionId !== undefined && t.connectionId !== connectionId)
      )
    }))
  }
}))

// Selectors
export const useSSHProfiles = () => useSSHStore((state) => state.profiles)
export const useSSHTransfers = () => useSSHStore((state) => state.transfers)
export const useSSHLoaded = () => useSSHStore((state) => state.isLoaded)
export const useSSHSessions = () => useSSHStore((state) => state.sessions)
export const useSSHWorkspaceOpen = () => useSSHStore((state) => state.workspaceOpen)
export const useSSHActiveTab = () => useSSHStore((state) => state.activeTab)
export const useSSHPendingClose = () => useSSHStore((state) => state.pendingClose)
export const useSSHSelectedProfileId = () => useSSHStore((state) => state.selectedProfileId)

export function selectActiveSession(state: SSHState): SSHSession | null {
  if (!state.workspaceOpen) return null
  return state.sessions.find((s) => s.id === state.activeTab) ?? null
}

export const useActiveSSHSession = () => useSSHStore(selectActiveSession)

/** The host in focus while the SSH workspace is open, else `null`. */
export function selectActiveProfileId(state: SSHState): string | null {
  if (!state.workspaceOpen) return null
  return selectActiveSession(state)?.profileId ?? state.selectedProfileId
}

export const useActiveSSHProfileId = () => useSSHStore(selectActiveProfileId)
export const useActiveSSHProfile = () =>
  useSSHStore((state) => {
    const id = selectActiveProfileId(state)
    return id ? (state.profiles.find((p) => p.id === id) ?? null) : null
  })
export const useSSHEditorFile = () => useSSHStore((state) => state.editingFile)
export const useSSHEditorContent = () => useSSHStore((state) => state.editingContent)
export const useSSHShowAddresses = () => useSSHStore((state) => state.showAddresses)

export const useSSHActions = () =>
  useSSHStore(
    useShallow((state) => ({
      loadProfiles: state.loadProfiles,
      saveProfile: state.saveProfile,
      deleteProfile: state.deleteProfile,
      duplicateProfile: state.duplicateProfile,
      toggleFavorite: state.toggleFavorite,
      importConfig: state.importConfig,
      clearCompletedTransfers: state.clearCompletedTransfers,
      selectProfile: state.selectProfile,
      openWorkspace: state.openWorkspace,
      setActiveTab: state.setActiveTab,
      setEditingFile: state.setEditingFile,
      setEditingContent: state.setEditingContent,
      toggleShowAddresses: state.toggleShowAddresses
    }))
  )

/** Sessions of one host, oldest first. */
export const useSessionsForProfile = (profileId: string) =>
  useSSHStore(useShallow((state) => state.sessions.filter((s) => s.profileId === profileId)))
