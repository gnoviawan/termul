// Persisted terminal data (subset of Terminal for storage)
export interface PersistedTerminal {
  id: string
  name: string
  shell: string
  cwd?: string
  scrollback?: string[] // Legacy text snapshot for restoration fallback
  transcript?: string // Raw PTY transcript for ANSI/styling-preserving restoration; cap at renderer MAX_TRANSCRIPT_CHARS to avoid unbounded persistence
  // ADR-004.4: terminal-native agent metadata. Persisted so a restored agent
  // terminal re-spawns the agent TUI — but the seed prompt is intentionally NOT
  // persisted, so restore boots the agent fresh rather than re-submitting a
  // stale task. Restore-prompt suppression is enforced in use-terminal-restore.
  kind?: 'shell' | 'agent'
  agentId?: string
  agentName?: string
  agentProgram?: string
  agentArgs?: string[]
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
  windowState: 'window-state',
  // ADR-004.3 / ADR-004.6: user-defined terminal-native agent definitions.
  customAgents: 'agents/custom',
  // Last-selected agent in the launcher (persisted across sessions).
  lastSelectedAgent: 'agents/last-selected'
} as const

// Persisted project data (stored at projects.json)
export interface PersistedProjectData {
  projects: PersistedProject[]
  activeProjectId: string
  updatedAt: string // ISO timestamp
}

export interface PersistedEnvVariable {
  key: string
  value: string
  isSecret?: boolean
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
  envVars?: PersistedEnvVariable[]
  // Worktree fields (added by worktree feature)
  worktrees?: PersistedWorktree[]
  activeWorktreeId?: string | null
  // Git detection (cached)
  isGitRepo?: boolean
}

// ============================================================================
// Worktree Persistence Types
// ============================================================================

/**
 * Persisted worktree data (subset of Worktree for storage)
 * Stored as part of the project record — no separate persistence hook.
 */
export interface PersistedWorktree {
  id: string
  name: string
  branch: string
  path: string
  createdAt: string // ISO timestamp
}
