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
}

export type TerminalHealthStatus = 'running' | 'crashed' | 'hibernated'

export interface Terminal {
  id: string
  ptyId?: string
  name: string
  projectId: string
  shell: string
  cwd?: string
  gitBranch?: string | null
  gitStatus?: GitStatus | null
  lastExitCode?: number | null
  isActive?: boolean
  output?: TerminalLine[]
  pendingScrollback?: string[] // Scrollback snapshot to restore on terminal mount
  detachedOutput?: string // Raw PTY output captured while no renderer is mounted
  rendererAttachmentCount?: number // Number of mounted renderers bound to this PTY
  healthStatus?: TerminalHealthStatus // Terminal health status
  isHidden?: boolean // Whether terminal is currently hidden (on another route)
  hiddenSince?: number // Timestamp when terminal was hidden (for buffer truncation)
  hasActivity?: boolean // Whether terminal has recent output activity
  lastActivityTimestamp?: number // Timestamp when last activity occurred
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
