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

export interface GitStatus {
  modified: number
  staged: number
  untracked: number
  hasChanges: boolean
}

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
  pendingScrollback?: string[] // Scrollback to restore on terminal mount
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
