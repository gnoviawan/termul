// Import GitStatus from shared types to ensure consistency
// between IPC contract and renderer domain models
import type { GitStatus } from '@shared/types/ipc.types'

// Re-export for convenience
export type { GitStatus }

export type ProjectColor =
  | 'blue'
  | 'purple'
  | 'green'
  | 'yellow'
  | 'red'
  | 'cyan'
  | 'pink'
  | 'orange'
  | 'gray'

export interface Worktree {
  id: string
  name: string
  branch: string
  path: string
  createdAt: string // ISO timestamp
}

export interface Project {
  id: string
  name: string
  color: ProjectColor
  path?: string
  isActive?: boolean
  isArchived?: boolean
  gitBranch?: string
  lastOpened?: Date
  defaultShell?: string
  envVars?: EnvVariable[]
  worktrees?: Worktree[]
  activeWorktreeId?: string | null
  isGitRepo?: boolean
  symlinkDirs?: string[] // Directories to symlink from project root into worktrees
}

// Helper getters for worktree operations
export function getActiveWorktree(project: Project): Worktree | undefined {
  if (!project.activeWorktreeId) return undefined
  return project.worktrees?.find(w => w.id === project.activeWorktreeId)
}

export function isWorktreeTermulManaged(worktree: Worktree): boolean {
  // Normalize path separators for cross-platform detection
  const normalizedPath = worktree.path.replace(/\\/g, '/')
  return normalizedPath.includes('.termul/worktrees/')
}

export type TerminalHealthStatus = 'running' | 'crashed' | 'hibernated' | 'disconnected'

export interface Terminal {
  id: string
  ptyId?: string
  name: string
  projectId: string
  shell: string
  cwd?: string
  worktreeId?: string
  gitBranch?: string | null
  gitStatus?: GitStatus | null
  lastExitCode?: number | null
  isActive?: boolean
  output?: TerminalLine[]
  pendingScrollback?: string[] // Legacy text snapshot to restore on terminal mount
  transcript?: string // Raw PTY transcript used for ANSI/styling-preserving restoration
  detachedOutput?: string // Raw PTY output captured while no renderer is mounted
  rendererAttachmentCount?: number // Number of mounted renderers bound to this PTY
  healthStatus?: TerminalHealthStatus // Terminal health status
  isHidden?: boolean // Whether terminal is currently hidden within the workspace/pane model
  hiddenSince?: number // Timestamp when terminal became hidden within the workspace/pane model
  isAppHidden?: boolean // Whether the entire app/window is currently hidden or minimized
  appHiddenSince?: number // Timestamp when the app-hidden retention window started
  hasActivity?: boolean // Whether terminal has recent output activity
  lastActivityTimestamp?: number // Timestamp when last activity occurred
  needsAttention?: boolean // Whether this terminal's process finished while it was not the focused/visible terminal; drives the in-app highlight border
}

export interface TerminalLine {
  type: 'command' | 'output' | 'error' | 'warning' | 'info' | 'success'
  content: string
}

export interface Snapshot {
  id: string
  projectId: string
  name: string
  description?: string
  createdAt: Date
  paneCount: number
  processCount: number
  tag?: 'stable' | 'base'
  thumbnail?: SnapshotThumbnail
}

export interface SnapshotThumbnail {
  layout: 'single' | 'split-v' | 'split-h' | 'grid'
  lines: { color: string; width: number }[]
}

export interface EnvVariable {
  key: string
  value: string
  isSecret?: boolean
}
