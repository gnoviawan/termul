// Persisted terminal data (subset of Terminal for storage)
export interface PersistedTerminal {
  id: string
  name: string
  shell: string
  cwd?: string
  scrollback?: string[] // Lines of terminal output for restoration
}

// Default scrollback limit to prevent excessive storage
export const DEFAULT_SCROLLBACK_LIMIT = 10000

// Stored at terminals/{projectId}.json
export interface PersistedTerminalLayout {
  activeTerminalId: string | null
  terminals: PersistedTerminal[]
  updatedAt: string // ISO timestamp
}

// Window position and size state
export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

// Persisted snapshot data (subset of Snapshot for storage)
export interface PersistedSnapshot {
  id: string
  projectId: string
  name: string
  description?: string
  createdAt: string // ISO timestamp
  terminals: PersistedTerminal[]
  activeTerminalId: string | null
  tag?: 'stable' | 'base'
}

// Stored at snapshots/{projectId}.json
export interface PersistedSnapshotList {
  snapshots: PersistedSnapshot[]
  updatedAt: string // ISO timestamp
}

// Keys used for persistence storage
export const PersistenceKeys = {
  terminals: (projectId: string): string => `terminals/${projectId}`,
  snapshots: (projectId: string): string => `snapshots/${projectId}`,
  projects: 'projects',
  settings: 'settings',
  windowState: 'window-state'
} as const

// Persisted project data (stored at projects.json)
export interface PersistedProjectData {
  projects: PersistedProject[]
  activeProjectId: string
  updatedAt: string // ISO timestamp
}

// Minimal project data for persistence (matches Project from renderer)
export interface PersistedProject {
  id: string
  name: string
  color: string
  path?: string
  isArchived?: boolean
  gitBranch?: string
  defaultShell?: string
}
