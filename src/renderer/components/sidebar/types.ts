import type { Project } from '@/types/project'

export interface ColorPickerState {
  isOpen: boolean
  x: number
  y: number
  targetId: string
  targetType: 'project' | 'group'
}

export interface DeleteConfirmState {
  isOpen: boolean
  projectId: string
  projectName: string
}

export interface SettingsDialogState {
  isOpen: boolean
  projectId: string
}

export interface NewWorktreeModalState {
  isOpen: boolean
  projectId: string
}

export interface ProjectSidebarProps {
  projects: Project[]
  activeProjectId: string
  onSelectProject: (id: string) => void
  onNewProject: () => void
  onUpdateProject: (id: string, updates: Partial<Project>) => void
  onDeleteProject: (id: string) => void
  onArchiveProject: (id: string) => void
  onRestoreProject: (id: string) => void
  onReorderProjects: (projectIds: string[]) => void
  onSSHConnect?: (profileId: string) => void
  onSelectSSHProfile?: (profileId: string) => void
  activeSSHProfileId?: string | null
}
