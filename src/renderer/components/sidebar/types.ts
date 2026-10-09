import type { Project } from '@/types/project'

/** Target of the "Change Color" popover, opened at the last right-click point. */
export interface ColorPickerState {
  x: number
  y: number
  targetId: string
  targetType: 'project' | 'group'
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
