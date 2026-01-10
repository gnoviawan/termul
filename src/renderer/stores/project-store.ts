import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { Project, ProjectColor } from '@/types/project'

export interface ProjectState {
  // State
  projects: Project[]
  activeProjectId: string
  isLoaded: boolean

  // Actions
  selectProject: (id: string) => void
  addProject: (name: string, color: ProjectColor, path?: string, defaultShell?: string) => Project
  updateProject: (id: string, updates: Partial<Project>) => void
  deleteProject: (id: string) => void
  archiveProject: (id: string) => void
  restoreProject: (id: string) => void
  reorderProjects: (activeProjectIds: string[]) => void
  setProjects: (projects: Project[], activeProjectId?: string) => void
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: '',
  isLoaded: false,

  selectProject: (id: string): void => {
    set((state) => ({
      activeProjectId: id,
      projects: state.projects.map((p) => ({ ...p, isActive: p.id === id }))
    }))
  },

  addProject: (name: string, color: ProjectColor, path?: string, defaultShell?: string): Project => {
    const newProject: Project = {
      id: Date.now().toString(),
      name,
      color,
      path,
      defaultShell,
      gitBranch: 'main'
    }
    set((state) => ({
      projects: [...state.projects, newProject],
      activeProjectId: newProject.id
    }))
    return newProject
  },

  updateProject: (id: string, updates: Partial<Project>): void => {
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, ...updates } : p))
    }))
  },

  deleteProject: (id: string): void => {
    const { projects, activeProjectId } = get()
    const remaining = projects.filter((p) => p.id !== id)
    set({
      projects: remaining,
      activeProjectId:
        activeProjectId === id && remaining.length > 0
          ? remaining[0].id
          : activeProjectId === id
            ? ''
            : activeProjectId
    })
  },

  archiveProject: (id: string): void => {
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, isArchived: true } : p))
    }))
  },

  restoreProject: (id: string): void => {
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, isArchived: false } : p))
    }))
  },

  reorderProjects: (activeProjectIds: string[]): void => {
    set((state) => {
      // Separate archived and active projects
      const archivedProjects = state.projects.filter((p) => p.isArchived)
      const activeProjects = state.projects.filter((p) => !p.isArchived)

      // Create a map for quick lookup
      const projectMap = new Map(activeProjects.map((p) => [p.id, p]))

      // Reorder active projects based on the new order
      const reorderedActive = activeProjectIds
        .map((id) => projectMap.get(id))
        .filter((p): p is Project => p !== undefined)

      // Combine reordered active projects with archived projects
      return { projects: [...reorderedActive, ...archivedProjects] }
    })
  },

  setProjects: (projects: Project[], activeProjectId?: string): void => {
    set({
      projects,
      activeProjectId: activeProjectId ?? (projects.length > 0 ? projects[0].id : ''),
      isLoaded: true
    })
  }
}))

// Selectors for performance (selective subscriptions)
export function useActiveProject(): Project | undefined {
  return useProjectStore(
    (state) => state.projects.find((p) => p.id === state.activeProjectId)
  )
}

export function useProjects(): Project[] {
  return useProjectStore(useShallow((state) => state.projects))
}

export function useActiveProjectId(): string {
  return useProjectStore((state) => state.activeProjectId)
}

export function useProjectsLoaded(): boolean {
  return useProjectStore((state) => state.isLoaded)
}

export function useProjectActions(): Pick<
  ProjectState,
  | 'selectProject'
  | 'addProject'
  | 'updateProject'
  | 'deleteProject'
  | 'archiveProject'
  | 'restoreProject'
  | 'reorderProjects'
> {
  return useProjectStore(
    useShallow((state) => ({
      selectProject: state.selectProject,
      addProject: state.addProject,
      updateProject: state.updateProject,
      deleteProject: state.deleteProject,
      archiveProject: state.archiveProject,
      restoreProject: state.restoreProject,
      reorderProjects: state.reorderProjects
    }))
  )
}
