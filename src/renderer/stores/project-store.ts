import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { Project, ProjectColor, Worktree } from '@/types/project'

export interface ProjectState {
  // State
  projects: Project[]
  activeProjectId: string
  isLoaded: boolean
  isWorktreeOperationLocked: boolean

  // Actions
  selectProject: (id: string) => void
  addProject: (name: string, color: ProjectColor, path?: string, defaultShell?: string) => Project
  updateProject: (id: string, updates: Partial<Project>) => void
  deleteProject: (id: string) => void
  archiveProject: (id: string) => void
  restoreProject: (id: string) => void
  reorderProjects: (activeProjectIds: string[]) => void
  setProjects: (projects: Project[], activeProjectId?: string) => void
  addWorktree: (projectId: string, worktree: Worktree) => void
  removeWorktree: (projectId: string, worktreeId: string) => void
  setActiveWorktree: (projectId: string, worktreeId: string | null) => void
  setWorktreeOperationLock: (locked: boolean) => void
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: '',
  isLoaded: false,
  isWorktreeOperationLocked: false,

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
      gitBranch: 'main',
      tunnelPresets: []
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
  },

  addWorktree: (projectId: string, worktree: Worktree): void => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId
          ? { ...p, worktrees: [...(p.worktrees ?? []), worktree] }
          : p
      )
    }))
  },

  removeWorktree: (projectId: string, worktreeId: string): void => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              worktrees: (p.worktrees ?? []).filter((w) => w.id !== worktreeId),
              activeWorktreeId: p.activeWorktreeId === worktreeId ? null : p.activeWorktreeId,
            }
          : p
      ),
    }))
  },

  setActiveWorktree: (projectId: string, worktreeId: string | null): void => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId
          ? { ...p, activeWorktreeId: worktreeId }
          : p
      )
    }))
  },

  setWorktreeOperationLock: (locked: boolean): void => {
    set({ isWorktreeOperationLocked: locked })
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

export function getActiveWorktreeFromStore(projectId: string): Worktree | undefined {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
  if (!project?.activeWorktreeId) return undefined
  return project.worktrees?.find((w) => w.id === project.activeWorktreeId)
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
  | 'addWorktree'
  | 'removeWorktree'
  | 'setActiveWorktree'
  | 'setWorktreeOperationLock'
> {
  return useProjectStore(
    useShallow((state) => ({
      selectProject: state.selectProject,
      addProject: state.addProject,
      updateProject: state.updateProject,
      deleteProject: state.deleteProject,
      archiveProject: state.archiveProject,
      restoreProject: state.restoreProject,
      reorderProjects: state.reorderProjects,
      addWorktree: state.addWorktree,
      removeWorktree: state.removeWorktree,
      setActiveWorktree: state.setActiveWorktree,
      setWorktreeOperationLock: state.setWorktreeOperationLock
    }))
  )
}
